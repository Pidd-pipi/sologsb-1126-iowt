<script setup lang="ts">
/**
 * ConflictHistory —— 并发改动 / 失效重算记录列表。
 * 名次表传入与营位相关的全部记录（含「待合并」快捷处理入口），
 * 营位详情只传该营位的记录。点击待处理记录由外层打开合并对话框。
 */
import { computed } from 'vue'
import type { ChangeConflict } from '@/types/conflict'
import { CONFLICT_REASON_LABELS, CONFLICT_STATUS_LABELS } from '@/types/conflict'
import { formatDateTime } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    conflicts: ChangeConflict[]
    title?: string
    /** 最多展示条数，默认全部 */
    limit?: number
    /** 是否展示「营位」列（详情页传 false） */
    showSite?: boolean
  }>(),
  {
    title: '并发改动与重算记录',
    limit: 0,
    showSite: true
  }
)

const emit = defineEmits<{
  (e: 'resolve', conflict: ChangeConflict): void
}>()

const rows = computed(() => (props.limit > 0 ? props.conflicts.slice(0, props.limit) : props.conflicts))
</script>

<template>
  <section class="panel conflict-panel">
    <div class="panel__head">
      <h2>{{ title }}</h2>
      <span class="weight-note">{{ conflicts.length }} 条记录 · open 记录合并后才统一启用重算</span>
    </div>

    <el-table v-if="rows.length" :data="rows" size="small" border>
      <el-table-column label="状态" width="92">
        <template #default="{ row }">
          <el-tag :type="row.status === 'open' ? 'danger' : 'success'" size="small">
            {{ CONFLICT_STATUS_LABELS[row.status as ChangeConflict['status']] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="190">
        <template #default="{ row }">
          {{ CONFLICT_REASON_LABELS[row.reason as ChangeConflict['reason']] }}
        </template>
      </el-table-column>
      <el-table-column v-if="showSite" label="营位" width="200">
        <template #default="{ row }">{{ row.siteLabel ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="变化说明" min-width="280" prop="summary" />
      <el-table-column v-if="showSite" label="涉及方案" width="140">
        <template #default="{ row }">{{ row.profileName ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="保存方" width="100">
        <template #default="{ row }">{{ row.author ?? '系统' }}</template>
      </el-table-column>
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'open'"
            size="small"
            type="primary"
            @click="emit('resolve', row)"
          >
            查看并合并
          </el-button>
          <span v-else class="muted">{{ row.resolvedNote ?? '已处理' }}</span>
        </template>
      </el-table-column>
    </el-table>
    <p v-else class="panel__hint">暂无并发改动记录。</p>
  </section>
</template>
