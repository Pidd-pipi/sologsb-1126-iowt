/**
 * 营位与因子评估的本地读写。写库前统一脱掉响应式 Proxy，避免 DataCloneError。
 *
 * v4 起「保存营位指定方案」走带版本核对的 saveAssignment：
 * 营位 updatedAt 变了（别人同时改了营位）或指定方案版本变了（别人改了方案）都会拒绝写入，
 * 保留双方草稿并落 open 冲突，人工合并后再启用、重算。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import { nextSerialNo, nowIso, todayIso } from '@/utils/format'
import { notifyDataChange } from '@/utils/syncBus'

export interface SiteSaveResult {
  ok: boolean
  conflictId?: number
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
    const record = toPlain({ ...input, createdAt: now, updatedAt: now }) as Campsite
    delete record.id
    const id = await db.sites.add(record)
    await load()
    notifyDataChange('sites')
    return id
  }

  async function updateSite(id: number, patch: Partial<Campsite>): Promise<void> {
    await db.sites.update(id, toPlain({ ...patch, updatedAt: nowIso() }))
    await load()
    notifyDataChange('sites')
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
    await load()
    notifyDataChange('all', 'site-removed')
  }

  /**
   * 保存营位指定的权重方案（带乐观锁）。
   * @param expectedUpdatedAt 进入编辑时营位的 updatedAt；期间营位被别人保存过则冲突。
   * @param expectedProfileVersion 编辑时选定方案的版本；该方案内容被别人改过则冲突。
   * @param baseProfileId 编辑前的指定方案 id（用于三方对比）。
   * 合并（resolveAssignmentConflict）时传 rebase=true 跳过版本核对。
   */
  async function saveAssignment(params: {
    siteId: number
    profileId: number | null
    expectedUpdatedAt?: string
    expectedProfileVersion?: number | null
    baseProfileId?: number | null
    author?: string
    rebase?: boolean
  }): Promise<SiteSaveResult> {
    const {
      siteId,
      profileId,
      expectedUpdatedAt,
      expectedProfileVersion,
      baseProfileId,
      author,
      rebase = false
    } = params
    const now = nowIso()
    const result = await db.transaction('rw', db.sites, db.profiles, db.conflicts, async () => {
      const site = await db.sites.get(siteId)
      if (!site) return { ok: false as const }

      if (!rebase) {
        const profile = profileId == null ? null : await db.profiles.get(profileId)
        const targetVersion = profile && !profile.retiredAt ? profile.version : null
        const siteChanged =
          expectedUpdatedAt !== undefined && site.updatedAt !== expectedUpdatedAt
        const profileChanged =
          profileId != null &&
          profile &&
          !profile.retiredAt &&
          expectedProfileVersion !== undefined &&
          expectedProfileVersion !== targetVersion

        if (siteChanged || profileChanged) {
          const parts: string[] = []
          if (siteChanged) parts.push('营位信息已被别处改动')
          if (profileChanged)
            parts.push(
              `所选方案「${profile?.name ?? ''}」内容已改动（v${expectedProfileVersion} → v${targetVersion}）`
            )
          const conflictId = await db.conflicts.add(
            toPlain({
              resource: 'site',
              reason: 'site-stale',
              status: 'open',
              resourceId: siteId,
              siteId,
              siteLabel: `${site.code} ${site.name}`,
              summary: `${parts.join('；')}，营位指定未保存，双方选择均已保留`,
              author: author ?? '未署名',
              base: { defaultProfileId: baseProfileId ?? site.defaultProfileId },
              current: { defaultProfileId: site.defaultProfileId },
              incoming: { defaultProfileId: profileId },
              fields: ['defaultProfileId'],
              incomingProfileVersion: targetVersion,
              createdAt: now,
              resolvedAt: null
            })
          )
          return { ok: false as const, conflictId }
        }
      }

      const profile = profileId == null ? null : await db.profiles.get(profileId)
      await db.sites.update(siteId, {
        defaultProfileId: profileId,
        assignedProfileVersion: profile && !profile.retiredAt ? profile.version : null,
        // 指定有效方案 → 清空待选择标记；'unassigned' 是由 defaultProfileId=null 推导的，不入库
        pendingReason: '',
        updatedAt: now
      })
      return { ok: true as const }
    })

    await load()
    if (result.ok) notifyDataChange('all', 'assignment-saved')
    else notifyDataChange('conflicts')
    return result
  }

  /**
   * 合并营位指定冲突：以合并挑选的方案 id 落库，并重绑到该方案当前版本后重算。
   */  async function resolveAssignmentConflict(
    conflictId: number,
    mergedProfileId: number | null,
    note?: string
  ): Promise<SiteSaveResult> {
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict || typeof conflict.siteId !== 'number') return { ok: false }
    const result = await saveAssignment({
      siteId: conflict.siteId,
      profileId: mergedProfileId,
      rebase: true,
      author: conflict.author
    })
    if (result.ok) {
      await db.conflicts.update(conflictId, {
        status: 'merged',
        resolvedNote: note ?? '营位指定已合并，按最新方案版本重新计算名次',
        resolvedAt: nowIso()
      })
      notifyDataChange('all', 'conflict-merged')
    }
    return result
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
    notifyDataChange('factors')
    return id
  }

  async function removeFactor(id: number): Promise<void> {
    await db.factors.delete(id)
    await load()
    notifyDataChange('factors')
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

  const camps = computed(() => Array.from(new Set(list.value.map((s) => s.campName))))
  const total = computed(() => list.value.length)

  return {
    list,
    factors,
    loading,
    loaded,
    total,
    camps,
    load,
    nextCode,
    createSite,
    updateSite,
    removeSite,
    saveAssignment,
    resolveAssignmentConflict,
    addFactor,
    removeFactor,
    byId,
    latestFactor,
    factorsOf
  }
})
