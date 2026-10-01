/** 权重方案（ScoreProfile）的本地读写、启用切换、版本核对与冲突联动。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { FactorWeights, ScoreProfile } from '@/types/score'
import { DEFAULT_WEIGHTS } from '@/types/score'
import type { Campsite } from '@/types/campsite'
import type { ConflictRecord } from '@/types/conflict'
import { nowIso } from '@/utils/format'

/** 版本核对结果：无冲突时 conflict=false；有冲突时带回远端当前版本。 */
export interface VersionCheckResult {
  conflict: boolean
  current?: ScoreProfile
}

export const useProfileStore = defineStore('profile', () => {
  const list = ref<ScoreProfile[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  const activeProfile = computed<ScoreProfile | null>(
    () => list.value.find((p) => p.active) ?? list.value[0] ?? null
  )

  const activeWeights = computed<FactorWeights>(() => ({
    ...DEFAULT_WEIGHTS,
    ...(activeProfile.value?.weights ?? {})
  }))

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.profiles.orderBy('id').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function createProfile(input: ScoreProfile): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      weights: { ...DEFAULT_WEIGHTS, ...input.weights },
      thresholds: { ...input.thresholds },
      version: 1,
      createdAt: now,
      updatedAt: now
    }) as ScoreProfile
    delete record.id
    const id = await db.profiles.add(record)
    await load()
    return id
  }

  /**
   * 更新方案。传入 baseVersion 时做乐观并发核对：
   * 若远端版本已更新（被别处改过），返回 conflict=true 与远端快照，不写入。
   */
  async function updateProfile(
    id: number,
    patch: Partial<ScoreProfile>,
    baseVersion?: number
  ): Promise<VersionCheckResult> {
    const current = await db.profiles.get(id)
    if (!current) return { conflict: false }

    if (baseVersion != null && current.version !== baseVersion) {
      return { conflict: true, current: toPlain(current) as ScoreProfile }
    }

    const now = nowIso()
    const nextVersion = current.version + 1
    await db.profiles.update(id, toPlain({ ...patch, version: nextVersion, updatedAt: now }))

    // 方案内容变更 → 引用它的营位名次失效，生成冲突记录（名次由 computed 自动重算）
    const contentChanged =
      (patch.weights && JSON.stringify(patch.weights) !== JSON.stringify(current.weights)) ||
      (patch.thresholds && JSON.stringify(patch.thresholds) !== JSON.stringify(current.thresholds)) ||
      (patch.normalize && patch.normalize !== current.normalize)

    if (contentChanged) {
      await recordSchemeChanged(id, current, patch)
    }

    // 方案被停用 → 引用它的营位转入待选择
    if (patch.active === false && current.active) {
      await markCabinsPending(id, 'scheme-disabled', `权重方案「${current.name}」已停用`)
    }

    await load()
    return { conflict: false }
  }

  /** 另存为新方案（复制当前方案、改名、可选切换季节）。 */
  async function duplicateProfile(id: number, name: string, season?: string): Promise<number> {
    const src = list.value.find((p) => p.id === id)
    const payload: ScoreProfile = {
      name,
      weights: { ...DEFAULT_WEIGHTS, ...(src?.weights ?? {}) },
      normalize: src?.normalize ?? 'minmax',
      thresholds: { ...(src?.thresholds ?? { gradeA: 78, gradeB: 58 }) },
      season: season ?? src?.season ?? '四季通用',
      active: false,
      version: 1,
      note: src?.note ? `由「${src.name}」复制：${src.note}` : `由「${src?.name ?? '默认方案'}」复制`,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    return createProfile(payload)
  }

  /**
   * 移除方案。移除前把引用它的营位全部转入「待选择」，
   * 不静默回退到别的方案，并为每个受影响营位留冲突记录。
   */
  async function removeProfile(id: number): Promise<void> {
    const current = await db.profiles.get(id)
    if (!current) return

    // 先把引用该方案的营位转入待选择
    await markCabinsPending(id, 'scheme-removed', `权重方案「${current.name}」已移除`)

    await db.profiles.delete(id)
    await load()
  }

  /** 启用某个方案：其余方案自动取消启用。 */
  async function activate(id: number): Promise<VersionCheckResult> {
    const now = nowIso()
    await db.transaction('rw', db.profiles, async () => {
      for (const p of list.value) {
        if (typeof p.id !== 'number') continue
        await db.profiles.update(p.id, { active: p.id === id, updatedAt: now })
      }
    })
    await load()
    return { conflict: false }
  }

  function byId(id: number | null | undefined): ScoreProfile | null {
    if (id == null) return null
    return list.value.find((p) => p.id === id) ?? null
  }

  /* --------------------------- 内部：方案变更联动营位 --------------------------- */

  /** 找出引用某方案的营位。 */
  async function cabinsReferencing(profileId: number): Promise<Campsite[]> {
    return db.sites.filter((s) => s.defaultProfileId === profileId).toArray()
  }

  /** 把引用某方案的营位转入「待选择」状态，并写冲突记录。 */
  async function markCabinsPending(
    profileId: number,
    conflictType: 'scheme-disabled' | 'scheme-removed',
    summary: string
  ): Promise<void> {
    const cabins = await cabinsReferencing(profileId)
    if (!cabins.length) return

    const now = nowIso()
    const profile = await db.profiles.get(profileId)
    const records: ConflictRecord[] = []

    await db.transaction('rw', db.sites, db.conflicts, async () => {
      for (const cabin of cabins) {
        if (typeof cabin.id !== 'number') continue
        await db.sites.update(cabin.id, {
          defaultProfileId: null,
          profilePending: true,
          version: cabin.version + 1,
          updatedAt: now
        })
        records.push({
          entityType: 'site',
          entityId: cabin.id,
          entityName: `${cabin.code} · ${cabin.name}`,
          conflictType,
          summary: `${summary}，该营位转入待选择方案，需手动指定新方案`,
          localDraft: null,
          remoteSnapshot: { ...cabin },
          baseVersion: cabin.version,
          remoteVersion: cabin.version + 1,
          resolution: 'pending',
          resolvedAt: null,
          createdAt: now
        })
      }
      if (records.length) await db.conflicts.bulkAdd(records)
    })
  }

  /** 方案内容变更 → 为引用它的营位写冲突记录（名次失效，等待重算）。 */
  async function recordSchemeChanged(
    profileId: number,
    before: ScoreProfile,
    patch: Partial<ScoreProfile>
  ): Promise<void> {
    const cabins = await cabinsReferencing(profileId)
    if (!cabins.length) return

    const now = nowIso()
    const changes: string[] = []
    if (patch.weights) changes.push('权重')
    if (patch.thresholds) changes.push('等级阈值')
    if (patch.normalize) changes.push('归一化方式')
    const summary = `权重方案「${before.name}」的${changes.join('、')}已调整，引用该方案的营位名次失效，需重算`

    const records: ConflictRecord[] = cabins
      .filter((c) => typeof c.id === 'number')
      .map((cabin) => ({
        entityType: 'site' as const,
        entityId: cabin.id!,
        entityName: `${cabin.code} · ${cabin.name}`,
        conflictType: 'scheme-changed' as const,
        summary,
        localDraft: { ...patch },
        remoteSnapshot: { ...before },
        baseVersion: before.version,
        remoteVersion: before.version + 1,
        resolution: 'pending' as const,
        resolvedAt: null,
        createdAt: now
      }))

    if (records.length) await db.conflicts.bulkAdd(records)
  }

  const total = computed(() => list.value.length)

  return {
    list,
    loading,
    loaded,
    total,
    activeProfile,
    activeWeights,
    load,
    createProfile,
    updateProfile,
    duplicateProfile,
    removeProfile,
    activate,
    byId,
    cabinsReferencing,
    markCabinsPending
  }
})
