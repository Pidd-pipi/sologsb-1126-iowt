/**
 * 冲突记录的本地读写。版本核对发现冲突后，把冲突详情落库，
 * 供名次表与营位详情页展示冲突历史与处理结果。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { ConflictRecord, ConflictResolution } from '@/types/conflict'
import { nowIso } from '@/utils/format'

export const useConflictStore = defineStore('conflict', () => {
  const list = ref<ConflictRecord[]>([])
  const loading = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.conflicts.orderBy('createdAt').reverse().toArray()
    } finally {
      loading.value = false
    }
  }

  async function add(input: Omit<ConflictRecord, 'id' | 'createdAt' | 'resolvedAt'>): Promise<number> {
    const record = toPlain({
      ...input,
      createdAt: nowIso(),
      resolvedAt: input.resolution === 'pending' ? null : nowIso()
    }) as ConflictRecord
    delete record.id
    const id = await db.conflicts.add(record)
    await load()
    return id
  }

  async function resolve(id: number, resolution: ConflictResolution): Promise<void> {
    await db.conflicts.update(id, { resolution, resolvedAt: nowIso() })
    await load()
  }

  /** 某实体（方案或营位）的全部冲突记录，按时间倒序。 */
  function ofEntity(entityType: 'profile' | 'site', entityId: number | null | undefined): ConflictRecord[] {
    if (entityId == null) return []
    return list.value
      .filter((c) => c.entityType === entityType && c.entityId === entityId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 待处理的冲突数量。 */
  const pendingCount = ref(0)

  async function refreshPendingCount(): Promise<void> {
    pendingCount.value = await db.conflicts.filter((c) => c.resolution === 'pending').count()
  }

  return {
    list,
    loading,
    pendingCount,
    load,
    add,
    resolve,
    ofEntity,
    refreshPendingCount
  }
})
