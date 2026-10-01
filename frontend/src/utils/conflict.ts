/**
 * 冲突处理纯函数：把方案/营位快照摊平为字段三元组（base / current / incoming），
 * 逐字段判断是谁改的，并支持按字段挑选合并结果后还原成可保存的补丁。
 */
import type { FactorKey, FactorWeights, GradeThresholds, NormalizeMethod } from '@/types/score'
import { FACTOR_META } from '@/types/score'
import type { ChangeConflict } from '@/types/conflict'

export type FieldSide = 'current' | 'incoming'

export interface FieldDiff {
  /** 摊平后的字段路径，如 weights.slope / thresholds.gradeA / defaultProfileId */
  key: string
  label: string
  base: unknown
  current: unknown
  incoming: unknown
  /** 对方（先保存方）是否改过 */
  changedByRemote: boolean
  /** 本地草稿是否改过 */
  changedByMe: boolean
  /** 双方都改了同一字段（真正需要取舍的冲突点） */
  bothChanged: boolean
  /** 建议默认采用哪一方 */
  preferred: FieldSide
}

/** 方案参与版本核对的内容字段（active/version/retiredAt 不在内）。 */
export interface ProfileContent {
  name: string
  weights: FactorWeights
  normalize: NormalizeMethod
  thresholds: GradeThresholds
  season: string
  note: string
}

const PROFILE_SCALAR_LABELS: Record<string, string> = {
  name: '方案名',
  season: '适用季节',
  normalize: '归一方式',
  'thresholds.gradeA': 'A 级阈值',
  'thresholds.gradeB': 'B 级阈值',
  note: '备注'
}

const NORMALIZE_TEXT: Record<NormalizeMethod, string> = {
  minmax: '极差归一',
  threshold: '阈值分段'
}

export function profileContent(p: {
  name: string
  weights: FactorWeights
  normalize: NormalizeMethod
  thresholds: GradeThresholds
  season: string
  note: string
}): ProfileContent {
  return {
    name: p.name,
    weights: { ...p.weights },
    normalize: p.normalize,
    thresholds: { ...p.thresholds },
    season: p.season,
    note: p.note
  }
}

/** 摊平：weights.slope=14、thresholds.gradeA=78 … */
export function flattenProfile(c: ProfileContent): Record<string, string | number> {
  const flat: Record<string, string | number> = {
    name: c.name,
    season: c.season,
    normalize: c.normalize,
    note: c.note,
    'thresholds.gradeA': c.thresholds.gradeA,
    'thresholds.gradeB': c.thresholds.gradeB
  }
  FACTOR_META.forEach((m) => {
    flat[`weights.${m.key}`] = Number(c.weights[m.key]) || 0
  })
  return flat
}

/** 方案参与版本核对的全部摊平字段（顺序即变化清单展示顺序）。 */
export const PROFILE_FIELD_KEYS: string[] = [
  ...FACTOR_META.map((m) => `weights.${m.key}`),
  'normalize',
  'thresholds.gradeA',
  'thresholds.gradeB',
  'name',
  'season',
  'note'
]

/** 两份方案内容的摊平差异字段。 */
export function profileChangedKeys(a: ProfileContent, b: ProfileContent): string[] {
  const fa = flattenProfile(a)
  const fb = flattenProfile(b)
  return PROFILE_FIELD_KEYS.filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]))
}

/** 字段展示名。 */
export function fieldLabel(key: string): string {
  if (key in PROFILE_SCALAR_LABELS) return PROFILE_SCALAR_LABELS[key]
  if (key === 'defaultProfileId') return '指定权重方案'
  if (key.startsWith('weights.')) {
    const fk = key.slice('weights.'.length) as FactorKey
    return FACTOR_META.find((m) => m.key === fk)?.label ?? key
  }
  return key
}

/** 字段值的可读文本；方案 id 由页面通过 profileNameOf 转成方案名。 */
export function formatFieldValue(
  key: string,
  value: unknown,
  profileNameOf?: (id: number | null) => string
): string {
  if (value === null || value === undefined || value === '') {
    return key === 'defaultProfileId' ? '待选择（不指定方案）' : '—'
  }
  if (key === 'normalize') return NORMALIZE_TEXT[String(value) as NormalizeMethod] ?? String(value)
  if (key === 'defaultProfileId') {
    return profileNameOf ? profileNameOf(Number(value)) : `方案 #${value}`
  }
  if (key.startsWith('weights.')) return `${value}`
  if (key.startsWith('thresholds.')) return `${value} 分`
  return String(value)
}

function isDifferent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/** 由冲突的三份快照生成逐字段变化清单（仅列发生变化的字段）。 */
export function buildFieldDiffs(conflict: ChangeConflict): FieldDiff[] {
  const fields = conflict.fields ?? []
  const base = conflict.base ?? {}
  const current = conflict.current ?? {}
  const incoming = conflict.incoming ?? {}
  const diffs: FieldDiff[] = []
  for (const key of fields) {
    const b = base[key]
    const c = current[key]
    const i = incoming[key]
    const changedByRemote = isDifferent(b, c)
    const changedByMe = isDifferent(b, i)
    if (!changedByRemote && !changedByMe) continue
    diffs.push({
      key,
      label: fieldLabel(key),
      base: b,
      current: c,
      incoming: i,
      changedByRemote,
      changedByMe,
      bothChanged: changedByRemote && changedByMe,
      // 双方都改时默认保留先保存的一方，避免静默覆盖队友；只有本地改的字段采用本地草稿
      preferred: changedByRemote ? 'current' : 'incoming'
    })
  }
  return diffs
}

/** 把摊平的字段选择还原成方案内容补丁。 */
export function unflattenProfile(
  flat: Record<string, string | number>
): Partial<ProfileContent> {
  const patch: Partial<ProfileContent> = {}
  if ('name' in flat) patch.name = String(flat.name)
  if ('season' in flat) patch.season = String(flat.season)
  if ('normalize' in flat) patch.normalize = String(flat.normalize) as NormalizeMethod
  if ('note' in flat) patch.note = String(flat.note)
  const weights = {} as FactorWeights
  const thresholds = {} as GradeThresholds
  FACTOR_META.forEach((m) => {
    const k = `weights.${m.key}`
    if (k in flat) weights[m.key] = Number(flat[k]) || 0
  })
  if ('thresholds.gradeA' in flat) thresholds.gradeA = Number(flat['thresholds.gradeA'])
  if ('thresholds.gradeB' in flat) thresholds.gradeB = Number(flat['thresholds.gradeB'])
  if (Object.keys(weights).length) patch.weights = weights
  if (thresholds.gradeA !== undefined || thresholds.gradeB !== undefined) patch.thresholds = thresholds
  return patch
}

/** 方案类冲突的一句话摘要：列出关键变化字段。 */
export function summarizeProfileFields(conflict: ChangeConflict): string {
  const diffs = buildFieldDiffs(conflict)
  const names = diffs.slice(0, 4).map((d) => d.label)
  const rest = diffs.length - names.length
  if (!names.length) return '方案内容有差异'
  return `变化字段：${names.join('、')}${rest > 0 ? ` 等 ${diffs.length} 项` : ''}`
}
