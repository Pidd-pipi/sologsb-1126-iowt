<script setup lang="ts">
/**
 * ConflictHistory —— 某实体（方案或营位）的冲突记录列表。
 * 被 `/`（名次表）、`/sites/:id`（营位详情）消费，展示冲突类型、摘要、处理结果与时间。
 */
import { computed } from 'vue'
import { useConflictStore } from '@/stores/conflictStore'
import {
  CONFLICT_TYPE_LABELS,
  CONFLICT_RESOLUTION_LABELS,
  type ConflictEntityType
} from '@/types/conflict'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{
  entityType: ConflictEntityType
  entityId?: number | null
  /** 最多展示条数，默认 10 */
  limit?: number
}>()

const conflictStore = useConflictStore()

const rows = computed(() => {
  let all = conflictStore.list
  if (props.entityId != null) {
    all = all.filter((c) => c.entityType === props.entityType && c.entityId === props.entityId)
  } else {
    all = all.filter((c) => c.entityType === props.entityType)
  }
  const sorted = [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return typeof props.limit === 'number' ? sorted.slice(0, props.limit) : sorted
})

function typeLabel(t: string): string {
  return CONFLICT_TYPE_LABELS[t as keyof typeof CONFLICT_TYPE_LABELS] ?? t
}

function resolutionLabel(r: string): string {
  return CONFLICT_RESOLUTION_LABELS[r as keyof typeof CONFLICT_RESOLUTION_LABELS] ?? r
}

function resolutionType(r: string): 'success' | 'warning' | 'info' {
  if (r === 'merged') return 'success'
  if (r === 'pending') return 'warning'
  return 'info'
}
</script>

<template>
  <div v-if="rows.length" class="conflict-history">
    <div v-for="row in rows" :key="row.id" class="conflict-history__item">
      <div class="conflict-history__head">
        <el-tag size="small" :type="row.conflictType === 'version-mismatch' ? 'warning' : 'danger'">
          {{ typeLabel(row.conflictType) }}
        </el-tag>
        <el-tag size="small" :type="resolutionType(row.resolution)" effect="plain">
          {{ resolutionLabel(row.resolution) }}
        </el-tag>
        <span class="conflict-history__time">{{ formatDateTime(row.createdAt) }}</span>
      </div>
      <p class="conflict-history__summary">{{ row.summary }}</p>
    </div>
  </div>
  <p v-else class="conflict-history__empty">暂无冲突记录</p>
</template>

<style scoped>
.conflict-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.conflict-history__item {
  padding: 8px 10px;
  border: 1px solid var(--gb-line);
  border-radius: 8px;
  background: var(--gb-surface);
}
.conflict-history__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.conflict-history__time {
  font-size: 11px;
  color: var(--gb-muted);
  margin-left: auto;
}
.conflict-history__summary {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--gb-ink);
  line-height: 1.6;
}
.conflict-history__empty {
  font-size: 12px;
  color: var(--gb-muted);
  margin: 0;
}
</style>
