/**
 * useRanking —— 读取营位、因子、营位各自指定的权重方案与否决记录，
 * 算出归一化得分与名次。被名次表、评分页、地图、详情、否决登记共同消费。
 *
 * v4 规则：
 *   - 每个营位按其「指定方案」评分；方案按营位分组后分别极差归一，再统一排名。
 *   - 未指定 / 指定方案被停用或移除的营位进入 pending，不参与名次与等级，
 *     也不会被悄悄换用别的方案。
 *   - 方案内容改动后（营位的版本快照落后），该营位仍按当前方案重算并排名，
 *     但 row.stale=true，名次表/详情会提示「方案改动后已重算」，对应记录见冲突面板。
 *
 * 入参统一用 getter 函数，兼容 ref / computed / store 派生值，
 * 内部在独立 effectScope 中求值，保证 computed 依赖追踪正常且不泄漏。
 */
import { computed, effectScope, type ComputedRef } from 'vue'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type {
  FactorKey,
  FactorWeights,
  GradeThresholds,
  NormalizeMethod,
  ScoreProfile
} from '@/types/score'
import {
  buildFactorRows,
  buildNormalizedMatrix,
  gradeOf,
  rawValuesOf,
  weightedTotal,
  type Grade,
  type RawFactorValues,
  type SiteScore
} from '@/utils/score'

/** 营位 → 指定方案（null 表示待选择）；同时返回版本是否落后。 */
export interface AssignedProfileInfo {
  profile: ScoreProfile | null
  pending: boolean
  pendingReason: '' | 'retired' | 'removed' | 'unassigned'
  stale: boolean
}

export interface RankingInput {
  /** 参与排名的营位集合 */
  sites: () => Campsite[]
  /** siteId -> 用于评分的因子记录（通常取最新一轮评估） */
  factorOf: (siteId: number) => FactorAssessment | null
  /** siteId -> 该营位指定的方案信息 */
  assignmentOf: (site: Campsite) => AssignedProfileInfo
  /** 命中否决项的营位 id 集合 */
  vetoedIds: () => number[]
}

export interface RankingRow extends SiteScore {
  site: Campsite
  rank: number
  raw: RawFactorValues
  vetoTypes: string[]
  /** 评分所用方案 */
  profile: ScoreProfile
  /** 方案在上次指定后被改动过，本次名次为重算结果 */
  stale: boolean
}

export interface PendingSite {
  site: Campsite
  /** 原指定方案是否已停用（true）还是已删除/从未指定（false） */
  retired: boolean
  /** 待选择原因：retired 停用 / removed 移除 / unassigned 从未指定 */
  reason: '' | 'retired' | 'removed' | 'unassigned'
  /** 停用方案仍可读其名；移除时为 null */
  profileName: string | null
}

export interface RankingState {
  /** 已按得分降序排列的名次（仅指定了有效方案的营位） */
  ranked: ComputedRef<RankingRow[]>
  /** 指定方案缺失（未指定 / 停用 / 移除）的营位，等待人工重新选择 */
  pending: ComputedRef<PendingSite[]>
  scoreOf: (siteId: number) => RankingRow | null
  gradeOfSite: (siteId: number) => Grade
  best: ComputedRef<RankingRow | null>
}

export function useRanking(input: RankingInput): RankingState {
  const scope = effectScope(true)

  const ranked = scope.run(() =>
    computed<RankingRow[]>(() => {
      const sites = (input.sites() ?? []).filter(
        (s): s is Campsite & { id: number } => typeof s.id === 'number'
      )
      const vetoSet = new Set(input.vetoedIds() ?? [])

      // 按指定方案分组：极差归一必须同批营位一起比较，这里的「同批」= 同一方案的营位。
      const groups = new Map<
        number,
        {
          profile: ScoreProfile
          items: Array<{ site: Campsite & { id: number }; stale: boolean }>
        }
      >()

      for (const site of sites) {
        const { profile, pending, stale } = input.assignmentOf(site)
        if (pending || !profile || typeof profile.id !== 'number') continue
        let group = groups.get(profile.id)
        if (!group) {
          group = { profile, items: [] }
          groups.set(profile.id, group)
        }
        group.items.push({ site, stale })
      }

      const rows: RankingRow[] = []
      for (const group of groups.values()) {
        const entries = group.items.map(({ site }) => ({
          siteId: site.id,
          values: rawValuesOf(site, input.factorOf(site.id))
        }))
        const matrix = buildNormalizedMatrix(entries, group.profile.normalize)
        const weights: FactorWeights = group.profile.weights
        const thresholds: GradeThresholds = group.profile.thresholds

        group.items.forEach(({ site, stale }, idx) => {
          const entry = entries[idx]
          const normalized = matrix.get(entry.siteId) ?? ({} as Record<FactorKey, number>)
          const vetoed = vetoSet.has(entry.siteId)
          const total = weightedTotal(normalized, weights)
          rows.push({
            site,
            siteId: entry.siteId,
            total,
            grade: gradeOf(total, thresholds, vetoed),
            vetoed,
            vetoTypes: [],
            rows: buildFactorRows(normalized, weights).map((row) => ({
              ...row,
              raw: entry.values[row.key]
            })),
            raw: entry.values,
            rank: 0,
            profile: group.profile,
            stale
          })
        })
      }

      const sorted = rows.sort((a, b) => b.total - a.total)
      sorted.forEach((row, idx) => {
        row.rank = idx + 1
      })
      return sorted
    })
  ) as ComputedRef<RankingRow[]>

  /** 待选择营位：未指定、或指定方案已停用/移除；保留原方案名用于提示。 */
  const pending = scope.run(() =>
    computed<PendingSite[]>(() => {
      const out: PendingSite[] = []
      for (const site of input.sites() ?? []) {
        const { profile, pending: isPending, pendingReason } = input.assignmentOf(site)
        if (!isPending) continue
        out.push({
          site,
          retired: pendingReason === 'retired',
          reason: pendingReason,
          profileName: profile?.name ?? null
        })
      }
      return out
    })
  ) as ComputedRef<PendingSite[]>

  function scoreOf(siteId: number): RankingRow | null {
    return ranked.value.find((r) => r.siteId === siteId) ?? null
  }

  function gradeOfSite(siteId: number): Grade {
    return scoreOf(siteId)?.grade ?? 'C'
  }

  const best = scope.run(() => computed<RankingRow | null>(() => ranked.value[0] ?? null)) as
    | ComputedRef<RankingRow | null>
    | undefined

  return {
    ranked,
    pending,
    scoreOf,
    gradeOfSite,
    best: best ?? computed<RankingRow | null>(() => ranked.value[0] ?? null)
  }
}

/** 归一方式类型重导出，方便页面引用。 */
export type { NormalizeMethod }
