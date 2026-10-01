/**
 * ChangeConflict（并发改动 / 失效重算记录）—— v4 新增。
 *
 * 两类来源：
 *   1. 保存时版本核对失败（别人先改了）：保留 base（共同旧值）、current（对方已保存的值）、
 *      incoming（本次未保存的草稿值）三份快照，状态为 open，等人工合并后再统一启用/重算。
 *   2. 方案停用 / 移除 / 内容改动导致的引用失效：由系统落一条 merged 记录，
 *      说明受影响营位已转入「待选择」或名次已失效重算，作为可追溯的历史保留。
 *
 * 名次表展示与营位相关的记录，营位详情只展示该营位的记录。
 */

/** 冲突涉及的资源 */
export type ConflictResource = 'profile' | 'site'

/**
 * - profile-stale：保存权重方案时，方案内容已被别处改动（版本对不上）
 * - site-stale：保存营位指定时，营位或其指定方案已被别处改动
 * - profile-retired：方案被停用，引用它的营位转入待选择
 * - profile-removed：方案被移除，引用它的营位转入待选择
 * - profile-changed：方案内容改动，受影响营位名次失效并重算
 */
export type ConflictReason =
  | 'profile-stale'
  | 'site-stale'
  | 'profile-retired'
  | 'profile-removed'
  | 'profile-changed'

/** open：待人工处理；merged：已合并启用 / 系统已自动处理 */
export type ConflictStatus = 'open' | 'merged'

export interface ChangeConflict {
  /** 主键，自增 */
  id?: number
  resource: ConflictResource
  reason: ConflictReason
  status: ConflictStatus
  /** profile 记录存方案 id；site 记录存营位 id */
  resourceId: number
  /** 受影响营位（方案类记录按营位各落一条时填；site 记录即 resourceId） */
  siteId?: number | null
  /** 营位编号/名称快照，方便历史记录在营位被删除后仍可读 */
  siteLabel?: string
  /** 方案名称快照（即使方案后来被删除也能展示） */
  profileName?: string
  /** 人类可读的变化说明 */
  summary: string
  /** 保存方（本地草稿作者）；系统记录可空 */
  author?: string
  /**
   * 合并用三份快照，仅 open 记录需要。
   * 字段名 → base（共同旧值）/ current（对方已保存值）/ incoming（本地草稿值）。
   */
  base?: Record<string, unknown> | null
  current?: Record<string, unknown> | null
  incoming?: Record<string, unknown> | null
  /** 允许合并挑选的字段（权重方案为全部内容字段，营位为 defaultProfileId） */
  fields?: string[]
  /** site-stale 时，草稿保存的方案版本（合并后用于回填 assignedProfileVersion） */
  incomingProfileVersion?: number | null
  /** 方案已被停用/删除时，incoming 草稿无法就地保存，可另存为新方案 */
  profileMissing?: boolean
  resolvedNote?: string
  createdAt: string
  resolvedAt: string | null
}

export const CONFLICT_REASON_LABELS: Record<ConflictReason, string> = {
  'profile-stale': '保存冲突 · 权重方案已被改动',
  'site-stale': '保存冲突 · 营位指定已被改动',
  'profile-retired': '方案停用 · 营位转入待选择',
  'profile-removed': '方案移除 · 营位转入待选择',
  'profile-changed': '方案改动 · 名次失效重算'
}

export const CONFLICT_STATUS_LABELS: Record<ConflictStatus, string> = {
  open: '待合并',
  merged: '已处理'
}
