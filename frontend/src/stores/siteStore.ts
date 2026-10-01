/** 营位与因子评估的本地读写。写库前统一脱掉响应式 Proxy，避免 DataCloneError。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { ScoreProfile } from '@/types/score'
import type { ConflictRecord } from '@/types/conflict'
import { nextSerialNo, nowIso, todayIso } from '@/utils/format'

/** 版本核对结果。 */
export interface SiteVersionCheckResult {
  conflict: boolean
  current?: Campsite
}

export const useSiteStore = defineStore('site', () => {
  const list = ref<Campsite[]>([])
  const factors = ref<FactorAssessment[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.sites.orderBy('code').toArray()
      factors.value = await db.factors.toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个营位编号，如 CS-0007。 */
  function nextCode(): string {
    return nextSerialNo('CS-', list.value.map((s) => s.code))
  }

  async function createSite(input: Campsite): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      profilePending: input.profilePending ?? false,
      version: 1,
      createdAt: now,
      updatedAt: now
    }) as Campsite
    delete record.id
    const id = await db.sites.add(record)
    await load()
    return id
  }

  /**
   * 更新营位。传入 baseVersion 时做乐观并发核对：
   * 若远端版本已更新，返回 conflict=true 与远端快照，不写入。
   */
  async function updateSite(
    id: number,
    patch: Partial<Campsite>,
    baseVersion?: number
  ): Promise<SiteVersionCheckResult> {
    const current = await db.sites.get(id)
    if (!current) return { conflict: false }

    if (baseVersion != null && current.version !== baseVersion) {
      return { conflict: true, current: toPlain(current) as Campsite }
    }

    const now = nowIso()
    await db.sites.update(
      id,
      toPlain({ ...patch, version: current.version + 1, updatedAt: now })
    )
    await load()
    return { conflict: false }
  }

  /** 营位手动选择新方案：清除待选择状态，并写冲突记录。 */
  async function assignProfile(siteId: number, profileId: number, baseVersion?: number): Promise<SiteVersionCheckResult> {
    const current = await db.sites.get(siteId)
    if (!current) return { conflict: false }

    if (baseVersion != null && current.version !== baseVersion) {
      return { conflict: true, current: toPlain(current) as Campsite }
    }

    const now = nowIso()
    await db.transaction('rw', db.sites, db.conflicts, async () => {
      await db.sites.update(siteId, {
        defaultProfileId: profileId,
        profilePending: false,
        version: current.version + 1,
        updatedAt: now
      })
      const profile = await db.profiles.get(profileId)
      const record: ConflictRecord = {
        entityType: 'site',
        entityId: siteId,
        entityName: `${current.code} · ${current.name}`,
        conflictType: 'profile-pending',
        summary: `营位已重新指定权重方案为「${profile?.name ?? '未知方案'}」`,
        localDraft: { defaultProfileId: profileId },
        remoteSnapshot: { ...current },
        baseVersion: current.version,
        remoteVersion: current.version + 1,
        resolution: 'merged',
        resolvedAt: now,
        createdAt: now
      }
      await db.conflicts.add(record)
    })
    await load()
    return { conflict: false }
  }

  async function removeSite(id: number): Promise<void> {
    await db.sites.delete(id)
    const own = factors.value.filter((f) => f.siteId === id)
    await db.factors.bulkDelete(
      own.map((f) => f.id).filter((v): v is number => typeof v === 'number')
    )
    const vetoIds = (await db.vetos.where('siteId').equals(id).toArray())
      .map((v) => v.id)
      .filter((v): v is number => typeof v === 'number')
    await db.vetos.bulkDelete(vetoIds)
    // 同时清理该营位的冲突记录
    const conflictIds = (await db.conflicts.where('entityId').equals(id).toArray())
      .filter((c) => c.entityType === 'site')
      .map((c) => c.id)
      .filter((v): v is number => typeof v === 'number')
    if (conflictIds.length) await db.conflicts.bulkDelete(conflictIds)
    await load()
  }

  async function addFactor(input: FactorAssessment): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      assessedAt: input.assessedAt || todayIso(),
      createdAt: now,
      updatedAt: now
    }) as FactorAssessment
    delete record.id
    const id = await db.factors.add(record)
    await load()
    return id
  }

  async function removeFactor(id: number): Promise<void> {
    await db.factors.delete(id)
    await load()
  }

  function byId(id: number | null | undefined): Campsite | null {
    if (id == null || Number.isNaN(id)) return null
    return list.value.find((s) => s.id === id) ?? null
  }

  /** 取某营位最新一条因子评估（按评估日期倒序）。 */
  function latestFactor(siteId: number | null | undefined): FactorAssessment | null {
    if (siteId == null) return null
    const rows = factors.value
      .filter((f) => f.siteId === siteId)
      .sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1))
    return rows[0] ?? null
  }

  /** 取某营位全部因子评估（多轮复核对比用）。 */
  function factorsOf(siteId: number | null | undefined): FactorAssessment[] {
    if (siteId == null) return []
    return factors.value
      .filter((f) => f.siteId === siteId)
      .sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1))
  }

  /** 处于待选择方案状态的营位。 */
  const pendingSites = computed(() => list.value.filter((s) => s.profilePending))

  const camps = computed(() => Array.from(new Set(list.value.map((s) => s.campName))))
  const total = computed(() => list.value.length)

  return {
    list,
    factors,
    loading,
    loaded,
    total,
    camps,
    pendingSites,
    load,
    nextCode,
    createSite,
    updateSite,
    assignProfile,
    removeSite,
    addFactor,
    removeFactor,
    byId,
    latestFactor,
    factorsOf
  }
})
