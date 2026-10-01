<script setup lang="ts">
/**
 * ConflictDialog —— 版本冲突核对弹窗。
 * 保存时若发现远端已被别处改动，弹出此框：列出本地草稿与远端版本的变化，
 * 提供「保留本地 / 保留远端 / 合并」三种处理方式，处理后写冲突记录。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ConflictResolution } from '@/types/conflict'
import { CONFLICT_TYPE_LABELS } from '@/types/conflict'
import type { ConflictType } from '@/types/conflict'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{
  modelValue: boolean
  entityType: 'profile' | 'site'
  entityName: string
  conflictType: ConflictType
  summary: string
  localDraft: unknown
  remoteSnapshot: unknown
  baseVersion: number
  remoteVersion: number
  remoteUpdatedAt?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'resolve', resolution: ConflictResolution): void
}>()

const resolution = ref<ConflictResolution>('merged')

watch(
  () => props.modelValue,
  (v) => {
    if (v) resolution.value = 'merged'
  }
)

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const typeLabel = computed(() => CONFLICT_TYPE_LABELS[props.conflictType] ?? '版本冲突')

/** 把快照对象转成可读的「字段：值」行，用于并列展示。 */
function snapshotRows(snapshot: unknown): Array<{ key: string; value: string }> {
  if (!snapshot || typeof snapshot !== 'object') return []
  const obj = snapshot as Record<string, unknown>
  return Object.keys(obj)
    .filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k))
    .map((k) => ({
      key: k,
      value: formatValue(obj[k])
    }))
}

function formatValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const localRows = computed(() => snapshotRows(props.localDraft))
const remoteRows = computed(() => snapshotRows(props.remoteSnapshot))

function confirm(): void {
  emit('resolve', resolution.value)
  visible.value = false
  ElMessage.success(`已按「${resolution.value === 'merged' ? '合并' : resolution.value === 'kept-local' ? '保留本地' : '保留远端'}」处理冲突`)
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="版本冲突核对"
    width="780px"
    :close-on-click-modal="false"
    class="conflict-dialog"
  >
    <el-alert
      type="warning"
      show-icon
      :closable="false"
      :title="`${typeLabel}：${entityName}`"
      :description="summary"
      style="margin-bottom: 14px"
    />

    <div class="conflict-meta">
      <span>本地草稿基于版本 <strong>v{{ baseVersion }}</strong></span>
      <span>远端当前版本 <strong>v{{ remoteVersion }}</strong></span>
      <span v-if="remoteUpdatedAt">远端更新于 {{ formatDateTime(remoteUpdatedAt) }}</span>
    </div>

    <div class="conflict-compare">
      <div class="conflict-col">
        <div class="conflict-col__head">本地草稿（本次要保存的内容）</div>
        <div class="conflict-col__body">
          <div v-for="row in localRows" :key="row.key" class="conflict-row">
            <span class="conflict-row__key">{{ row.key }}</span>
            <span class="conflict-row__value">{{ row.value }}</span>
          </div>
          <p v-if="!localRows.length" class="conflict-empty">无本地草稿快照</p>
        </div>
      </div>
      <div class="conflict-col">
        <div class="conflict-col__head">远端版本（数据库当前内容）</div>
        <div class="conflict-col__body">
          <div v-for="row in remoteRows" :key="row.key" class="conflict-row">
            <span class="conflict-row__key">{{ row.key }}</span>
            <span class="conflict-row__value">{{ row.value }}</span>
          </div>
          <p v-if="!remoteRows.length" class="conflict-empty">无远端快照</p>
        </div>
      </div>
    </div>

    <el-divider content-position="left">处理方式</el-divider>
    <el-radio-group v-model="resolution" class="conflict-resolution">
      <el-radio value="merged">
        <strong>合并</strong>：以本地草稿为基础，合并远端的最新改动后保存（推荐）
      </el-radio>
      <el-radio value="kept-local">
        <strong>保留本地</strong>：放弃远端改动，强制保存本地草稿
      </el-radio>
      <el-radio value="kept-remote">
        <strong>保留远端</strong>：放弃本地草稿，采用远端当前版本
      </el-radio>
    </el-radio-group>

    <template #footer>
      <el-button @click="visible = false">稍后处理</el-button>
      <el-button type="primary" @click="confirm">确认处理</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conflict-meta {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--gb-muted);
  margin-bottom: 12px;
}
.conflict-meta strong {
  color: var(--gb-ink);
}
.conflict-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 720px) {
  .conflict-compare {
    grid-template-columns: 1fr;
  }
}
.conflict-col {
  border: 1px solid var(--gb-line);
  border-radius: 8px;
  overflow: hidden;
}
.conflict-col__head {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  background: var(--gb-surface);
  color: var(--gb-ink);
}
.conflict-col__body {
  padding: 8px 12px;
  max-height: 280px;
  overflow-y: auto;
}
.conflict-row {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px dashed var(--gb-line);
}
.conflict-row:last-child {
  border-bottom: none;
}
.conflict-row__key {
  color: var(--gb-muted);
  min-width: 110px;
  flex-shrink: 0;
}
.conflict-row__value {
  color: var(--gb-ink);
  word-break: break-all;
}
.conflict-empty {
  font-size: 12px;
  color: var(--gb-muted);
  margin: 8px 0;
}
.conflict-resolution {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
