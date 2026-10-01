/**
 * 权重方案（ScoreProfile）的本地读写、乐观锁版本核对与启用/停用/移除。
 *
 * 并发规则（v4）：
 *   - 保存方案内容走 saveProfile(..., expectedVersion)：版本对不上则拒绝写入，
 *     落一条 open 冲突（base/current/incoming 三份草稿都保留），等人工合并。
 *   - 合并后调用 resolveProfileConflict()：写入合并结果、version+1、统一启用并重算。
 *   - 停用/移除方案时，引用它的营位 defaultProfileId 保持原值、进入「待选择」，
 *     绝不悄悄换回别的方案；逐营位落失效记录。
 *   - 方案内容改动后，引用它的营位 assignedProfileVersion 落后 → 名次失效重算，
 *     逐营位落重算记录并刷新版本快照。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { FactorWeights, ScoreProfile } from '@/types/score'
import { DEFAULT_WEIGHTS } from '@/types/score'
import { nowIso } from '@/utils/format'
import { notifyDataChange } from '@/utils/syncBus'
import {
  PROFILE_FIELD_KEYS,
  flattenProfile,
  profileChangedKeys,
  profileContent,
  type ProfileContent
} from '@/utils/conflict'

export interface SaveProfileInput extends Partial<ProfileContent> {
  active?: boolean
}

/** 新建方案入参：版本/停用标记/主键/时间戳由 store 统一补齐。 */
export type NewProfileInput = Omit<
  ScoreProfile,
  'id' | 'version' | 'retiredAt' | 'createdAt' | 'updatedAt'
>

export interface SaveProfileResult {
  ok: boolean
  id?: number
  version?: number
  /** 版本核对失败时返回冲突 id；missing 表示方案已被停用/移除 */
  conflictId?: number
  missing?: boolean
}

export const useProfileStore = defineStore('profile', () => {
  const list = ref<ScoreProfile[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  /** 仅在使用中的方案参与排名候选；停用方案不启用、不参与展示选择。 */
  const liveList = computed(() => list.value.filter((p) => !p.retiredAt))

  /** 当前启用方案：先找启用且未停用的，否则无（不回退到停用方案）。 */
  const activeProfile = computed<ScoreProfile | null>(
    () => liveList.value.find((p) => p.active) ?? null
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

  function normalizeContent(
    input: Partial<ProfileContent>,
    fallback?: ScoreProfile | null
  ): ProfileContent {
    return {
      name: input.name ?? fallback?.name ?? '未命名方案',
      weights: { ...DEFAULT_WEIGHTS, ...(input.weights ?? fallback?.weights ?? {}) },
      normalize: input.normalize ?? fallback?.normalize ?? 'minmax',
      thresholds: { ...(fallback?.thresholds ?? { gradeA: 78, gradeB: 58 }), ...input.thresholds },
      season: input.season ?? fallback?.season ?? '四季通用',
      note: input.note ?? fallback?.note ?? ''
    }
  }

  async function createProfile(input: NewProfileInput): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      weights: { ...DEFAULT_WEIGHTS, ...input.weights },
      thresholds: { ...input.thresholds },
      version: 1,
      retiredAt: null,
      createdAt: now,
      updatedAt: now
    }) as ScoreProfile
    const id = await db.profiles.add(record)
    await load()
    notifyDataChange('profiles')
    return id
  }

  /** 另存为新方案（复制当前方案、改名、可选切换季节）。 */
  async function duplicateProfile(id: number, name: string, season?: string): Promise<number> {
    const src = list.value.find((p) => p.id === id)
    const payload: NewProfileInput = {
      name,
      weights: { ...DEFAULT_WEIGHTS, ...(src?.weights ?? {}) },
      normalize: src?.normalize ?? 'minmax',
      thresholds: { ...(src?.thresholds ?? { gradeA: 78, gradeB: 58 }) },
      season: season ?? src?.season ?? '四季通用',
      active: false,
      note: src?.note ? `由「${src.name}」复制：${src.note}` : `由「${src?.name ?? '默认方案'}」复制`
    }
    return createProfile(payload)
  }

  /**
   * 带乐观锁的方案内容保存（合并启用也走这里）。
   * @param expectedVersion 页面编辑时基于的版本；与库内不一致即视为并发改动。
   * @param baseContent 页面开始编辑时的内容；与对方的保存结果共同构成三方对比的 base。
   */
  async function saveProfile(
    id: number,
    content: Partial<ProfileContent>,
    expectedVersion: number,
    baseContent?: ProfileContent,
    author?: string
  ): Promise<SaveProfileResult> {
    const result = await db.transaction(
      'rw',
      db.profiles,
      db.sites,
      db.conflicts,
      async (): Promise<SaveProfileResult> => {
        const current = await db.profiles.get(id)
        const incoming = normalizeContent(content, current)
        if (!current || current.retiredAt) {
          // 方案已被停用/移除：不就地写入，登记冲突后由页面引导另存为新方案。
          const baseFlat = baseContent
            ? flattenProfile(baseContent)
            : flattenProfile(profileContent(current ?? incoming))
          const conflictId = await db.conflicts.add(
            toPlain({
              resource: 'profile',
              reason: 'profile-stale',
              status: 'open',
              resourceId: id,
              siteId: null,
              profileName: current?.name ?? `方案 #${id}`,
              summary: `方案「${current?.name ?? `#${id}`}」已${current?.retiredAt ? '停用' : '移除'}，本地的权重调整无法直接保存`,
              author: author ?? '未署名',
              base: baseFlat,
              current: flattenProfile(profileContent(current ?? incoming)),
              incoming: flattenProfile(incoming),
              fields: PROFILE_FIELD_KEYS,
              profileMissing: true,
              createdAt: nowIso(),
              resolvedAt: null
            })
          )
          return { ok: false, conflictId, missing: true }
        }

        if (current.version !== expectedVersion) {
          const diffs = profileChangedKeys(profileContent(current), incoming)
          const baseFlat = baseContent
            ? flattenProfile(baseContent)
            : flattenProfile(profileContent(current))
          const conflictId = await db.conflicts.add(
            toPlain({
              resource: 'profile',
              reason: 'profile-stale',
              status: 'open',
              resourceId: id,
              siteId: null,
              profileName: current.name,
              summary: diffs.length
                ? `保存前「${current.name}」已被别处改动（v${expectedVersion} → v${current.version}），本地有 ${diffs.length} 项调整待合并`
                : `方案已被别处改动（v${expectedVersion} → v${current.version}），本地无内容差异，可直接刷新`,
              author: author ?? '未署名',
              base: baseFlat,
              current: flattenProfile(profileContent(current)),
              incoming: flattenProfile(incoming),
              fields: PROFILE_FIELD_KEYS,
              profileMissing: false,
              createdAt: nowIso(),
              resolvedAt: null
            })
          )
          return { ok: false, conflictId }
        }

        const nextContent = normalizeContent(incoming, current)
        const changedKeys = profileChangedKeys(profileContent(current), nextContent)
        if (!changedKeys.length) {
          return { ok: true, id, version: current.version }
        }

        const now = nowIso()
        const nextVersion = current.version + 1
        await db.profiles.put(
          toPlain({
            ...current,
            ...nextContent,
            version: nextVersion,
            updatedAt: now
          })
        )
        await recordProfileChangedSites(id, nextVersion, current.name, changedKeys, now)
        return { ok: true, id, version: nextVersion }
      }
    )

    if (result.ok) {
      await load()
      notifyDataChange('all', 'profile-saved')
    } else {
      // 冲突登记后也要刷新冲突列表
      notifyDataChange('conflicts')
    }
    return result
  }

  /**
   * 方案内容生效后：引用该方案的营位名次失效 → 逐营位落「已重算」记录。
   * 注意：不修改营位本身（不动 updatedAt、不提前对齐版本快照）——
   *  - 名次由评分逻辑实时按方案最新版本重算；
   *  - 营位的版本快照保持为「用户确认时的版本」，与最新版本不一致即在名次表/详情打「已重算」，
   *    领队重新保存一次指定即完成确认；
   *  - 不动 updatedAt，避免把「方案被改」误报成「营位被别人改」的保存冲突。
   */
  async function recordProfileChangedSites(
    profileId: number,
    nextVersion: number,
    profileName: string,
    changedKeys: string[],
    now: string
  ): Promise<void> {
    const sites = await db.sites.where('defaultProfileId').equals(profileId).toArray()
    for (const site of sites) {
      if (typeof site.id !== 'number') continue
      await db.conflicts.add(
        toPlain({
          resource: 'site',
          reason: 'profile-changed',
          status: 'merged',
          resourceId: site.id,
          siteId: site.id,
          siteLabel: `${site.code} ${site.name}`,
          profileName,
          summary: `方案「${profileName}」调整了 ${changedKeys.length} 项（${changedKeys
            .slice(0, 3)
            .join('、')}${changedKeys.length > 3 ? ' 等' : ''}），该营位名次失效，已按 v${nextVersion} 重算`,
          resolvedNote: `已按方案 v${nextVersion} 自动重算，重新保存指定可确认新版本`,
          createdAt: now,
          resolvedAt: now
        })
      )
    }
  }

  /**
   * 合并冲突：把逐字段挑选后的方案内容写回，version+1，并记录合并说明。
   * merge 为 { field: 'current' | 'incoming' }。
   */  async function resolveProfileConflict(
    conflictId: number,
    mergedContent: ProfileContent,
    note?: string
  ): Promise<SaveProfileResult> {
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict) return { ok: false }
    // 以库内最新版本为基准再保存一次（saveProfile 会再做一次版本核对，但这里 expectedVersion
    // 直接传库内当前版本，因为合并结果已经包含对方的改动）
    const current = await db.profiles.get(conflict.resourceId)
    if (!current || current.retiredAt) {
      return { ok: false, missing: true }
    }
    const result = await saveProfile(
      conflict.resourceId,
      mergedContent,
      current.version,
      undefined,
      conflict.author
    )
    if (result.ok && result.conflictId === undefined) {
      await db.conflicts.update(conflictId, {
        status: 'merged',
        resolvedNote: note ?? '双方改动已合并并启用，受影响营位已统一重算',
        resolvedAt: nowIso()
      })
      await load()
      notifyDataChange('all', 'conflict-merged')
    }
    return result
  }

  /** 启用某个方案：只有未停用方案可启用，其余自动取消启用；不改版本。 */
  async function activate(id: number): Promise<void> {
    const now = nowIso()
    await db.transaction('rw', db.profiles, async () => {
      const all = await db.profiles.toArray()
      for (const p of all) {
        if (typeof p.id !== 'number') continue
        await db.profiles.update(p.id, { active: p.id === id && !p.retiredAt, updatedAt: now })
      }
    })
    await load()
    notifyDataChange('profiles')
  }

  /**
   * 停用方案（不删除）：引用它的营位转入「待选择」（保留 defaultProfileId 指向与方案名快照），
   * 落 profile-retired 记录；若停用的是启用中方案，取消其启用标记（不自动换方案）。
   */
  async function retireProfile(id: number): Promise<void> {
    const now = nowIso()
    await db.transaction('rw', db.profiles, db.sites, db.conflicts, async () => {
      const target = await db.profiles.get(id)
      if (!target || target.retiredAt) return
      await db.profiles.update(id, { retiredAt: now, active: false, updatedAt: now })
      const sites = await db.sites.where('defaultProfileId').equals(id).toArray()
      for (const site of sites) {
        if (typeof site.id !== 'number') continue
        await db.sites.update(site.id, { pendingReason: 'retired' })
        await db.conflicts.add(
          toPlain({
            resource: 'site',
            reason: 'profile-retired',
            status: 'merged',
            resourceId: site.id,
            siteId: site.id,
            siteLabel: `${site.code} ${site.name}`,
            profileName: target.name,
            summary: `方案「${target.name}」已停用，营位转入待选择，未自动切换其它方案`,
            resolvedNote: '等待人工重新指定方案',
            createdAt: now,
            resolvedAt: now
          })
        )
      }
    })
    await load()
    notifyDataChange('all', 'profile-retired')
  }

  /**
   * 移除方案：引用它的营位转入「待选择」（defaultProfileId 置空、版本快照清空），
   * 落 profile-removed 记录。至少保留一个未停用方案的校验在页面做。
   */
  async function removeProfile(id: number): Promise<void> {
    const now = nowIso()
    await db.transaction('rw', db.profiles, db.sites, db.conflicts, async () => {
      const target = await db.profiles.get(id)
      const sites = await db.sites.where('defaultProfileId').equals(id).toArray()
      const name = target?.name ?? `方案 #${id}`
      await db.profiles.delete(id)
      for (const site of sites) {
        if (typeof site.id !== 'number') continue
        // 保留 defaultProfileId 与最后方案名提示（由 pendingReason='removed' 标记），
        // 但绝不再解析为可评分方案。
        await db.sites.update(site.id, {
          pendingReason: 'removed',
          assignedProfileVersion: null,
          updatedAt: now
        })
        await db.conflicts.add(
          toPlain({
            resource: 'site',
            reason: 'profile-removed',
            status: 'merged',
            resourceId: site.id,
            siteId: site.id,
            siteLabel: `${site.code} ${site.name}`,
            profileName: name,
            summary: `方案「${name}」已移除，营位转入待选择，未自动切换其它方案`,
            resolvedNote: '等待人工重新指定方案',
            createdAt: now,
            resolvedAt: now
          })
        )
      }
    })
    await load()
    notifyDataChange('all', 'profile-removed')
  }

  function byId(id: number | null | undefined): ScoreProfile | null {
    if (id == null) return null
    return list.value.find((p) => p.id === id) ?? null
  }

  /**
   * 营位指定的方案是否仍然有效。
   * pending 原因：pendingReason='retired'（方案停用，profile 仍可读其名）
   *            或 pendingReason='removed'（方案已删除，profile=null 但 defaultProfileId 保留）
   *            或 defaultProfileId=null（从未指定）。
   */
  function assignmentOf(site: Campsite | null | undefined): {
    profile: ScoreProfile | null
    pending: boolean
    pendingReason: '' | 'retired' | 'removed' | 'unassigned'
    stale: boolean
  } {
    if (!site) {
      return { profile: null, pending: true, pendingReason: 'unassigned', stale: false }
    }
    if (site.pendingReason === 'retired') {
      return { profile: byId(site.defaultProfileId), pending: true, pendingReason: 'retired', stale: false }
    }
    if (site.pendingReason === 'removed') {
      return { profile: null, pending: true, pendingReason: 'removed', stale: false }
    }
    if (site.defaultProfileId == null) {
      return { profile: null, pending: true, pendingReason: 'unassigned', stale: false }
    }
    const profile = byId(site.defaultProfileId)
    if (!profile || profile.retiredAt) {
      // 数据层兜底：标记缺失时按停用处理
      return { profile, pending: true, pendingReason: 'retired', stale: false }
    }
    const stale = site.assignedProfileVersion !== profile.version
    return { profile, pending: false, pendingReason: '', stale }
  }

  const total = computed(() => list.value.length)
  const liveTotal = computed(() => liveList.value.length)

  return {
    list,
    liveList,
    loading,
    loaded,
    total,
    liveTotal,
    activeProfile,
    activeWeights,
    load,
    createProfile,
    saveProfile,
    resolveProfileConflict,
    duplicateProfile,
    removeProfile,
    retireProfile,
    activate,
    byId,
    assignmentOf
  }
})
