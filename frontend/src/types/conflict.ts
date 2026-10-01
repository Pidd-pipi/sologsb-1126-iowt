/**
 * ConflictRecord（冲突记录）—— 多人/多端同时编辑同一数据时的版本冲突留痕。
 * 名次表与营位详情页消费此模型，展示冲突的来龙去脉与处理结果。
 */

/** 冲突涉及的实体类型 */
export type ConflictEntityType = 'profile' | 'site'

/** 冲突类型 */
export type ConflictType =
  | 'version-mismatch' // 版本不一致：两人同时改了同一条记录
  | 'scheme-disabled' // 引用的权重方案被停用
  | 'scheme-removed' // 引用的权重方案被移除
  | 'scheme-changed' // 引用的权重方案被修改（权重/阈值/归一方式）
  | 'profile-pending' // 营位转入待选择方案状态

/** 冲突处理结果 */
export type ConflictResolution = 'merged' | 'kept-local' | 'kept-remote' | 'pending'

export interface ConflictRecord {
  /** 主键，自增 */
  id?: number
  /** 冲突实体类型 */
  entityType: ConflictEntityType
  /** 冲突实体 id（方案 id 或营位 id） */
  entityId: number
  /** 实体名称快照（方案名 或 营位编号·名称） */
  entityName: string
  /** 冲突类型 */
  conflictType: ConflictType
  /** 人类可读的变化描述 */
  summary: string
  /** 本地草稿快照（用户尝试保存的内容） */
  localDraft: unknown
  /** 远端快照（数据库当前内容） */
  remoteSnapshot: unknown
  /** 本地草稿基于的版本号 */
  baseVersion: number
  /** 远端当前版本号 */
  remoteVersion: number
  /** 处理结果 */
  resolution: ConflictResolution
  /** 处理时间（未处理为 null） */
  resolvedAt: string | null
  createdAt: string
}

export const CONFLICT_TYPE_LABELS: Record<ConflictType, string> = {
  'version-mismatch': '版本冲突',
  'scheme-disabled': '方案停用',
  'scheme-removed': '方案移除',
  'scheme-changed': '方案变更',
  'profile-pending': '待选择方案'
}

export const CONFLICT_RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  merged: '已合并',
  'kept-local': '保留本地',
  'kept-remote': '保留远端',
  pending: '待处理'
}

/** 比较两个对象的顶层字段，返回变化描述列表（用于冲突时列变化）。 */
export function diffFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  fields: Array<{ key: string; label: string }>
): string[] {
  const changes: string[] = []
  for (const { key, label } of fields) {
    const lv = JSON.stringify(local[key])
    const rv = JSON.stringify(remote[key])
    if (lv !== rv) {
      changes.push(`${label}：${rv || '空'} → ${lv || '空'}`)
    }
  }
  return changes
}
