/**
 * 冲突记录（ChangeConflict）的本地读写：保存冲突的登记、合并闭环，
 * 以及方案停用/移除/改动产生的失效重算记录。
 * 名次表与营位详情都从这里取记录展示。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { ChangeConflict } from '@/types/conflict'
import { nowIso } from '@/utils/format'
import { notifyDataChange } from '@/utils/syncBus'

export const useConflictStore = defineStore('conflict', () => {
  const list = ref<ChangeConflict[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.conflicts.orderBy('createdAt').reverse().toArray()
      list.value = rows
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function addConflict(input: Omit<ChangeConflict, 'id' | 'createdAt' | 'resolvedAt'> & {
    createdAt?: string
  }): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      createdAt: input.createdAt ?? now,
      resolvedAt: input.status === 'merged' ? now : null
    }) as ChangeConflict
    const id = await db.conflicts.add(record)
    await load()
    notifyDataChange('conflicts')
    return id
  }

  /** 冲突合并完成：记录处理说明并闭环。 */
  async function markMerged(id: number, resolvedNote?: string): Promise<void> {
    await db.conflicts.update(id, {
      status: 'merged',
      resolvedNote: resolvedNote ?? undefined,
      resolvedAt: nowIso()
    })
    await load()
    notifyDataChange('conflicts')
  }

  async function removeConflict(id: number): Promise<void> {
    await db.conflicts.delete(id)
    await load()
    notifyDataChange('conflicts')
  }

  /** 营位详情：该营位的全部记录（含已处理历史）。 */
  function ofSite(siteId: number | null | undefined): ChangeConflict[] {
    if (siteId == null) return []
    return list.value.filter((c) => c.siteId === siteId)
  }

  /** 名次表：与营位有关的记录（siteId 非空）。 */
  const siteRelated = computed<ChangeConflict[]>(() =>
    list.value.filter((c) => typeof c.siteId === 'number')
  )

  const openCount = computed(() => list.value.filter((c) => c.status === 'open').length)
  const openList = computed(() => list.value.filter((c) => c.status === 'open'))

  const total = computed(() => list.value.length)

  return {
    list,
    loading,
    loaded,
    total,
    openCount,
    openList,
    siteRelated,
    load,
    addConflict,
    markMerged,
    removeConflict,
    ofSite
  }
})
