<script setup lang="ts">
/**
 * ConflictResolveDialog —— 保存时发现「别处已改动」时的三方合并对话框。
 *
 * 列出每个变化字段的：原值（共同基线）/ 对方已保存 / 我的草稿，
 * 双方都改过的字段逐字段二选一，只有一方改的自动采用，合并后由调用方统一启用并重算。
 * 方案被停用/移除时支持把本地草稿「另存为新方案」。
 */
import { computed, ref, watch } from 'vue'
import type { ChangeConflict } from '@/types/conflict'
import { CONFLICT_REASON_LABELS } from '@/types/conflict'
import {
  buildFieldDiffs,
  formatFieldValue,
  unflattenProfile,
  type FieldDiff,
  type FieldSide,
  type ProfileContent
} from '@/utils/conflict'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{
  modelValue: boolean
  conflict: ChangeConflict | null
  /** 方案 id → 方案名（营位指定冲突时把 id 转成可读名称） */
  profileNameOf?: (id: number | null) => string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  /** 方案冲突：返回合并后的完整方案内容 */
  (e: 'merge-profile', conflict: ChangeConflict, merged: ProfileContent): void
  /** 营位指定冲突：返回选定的方案 id */
  (e: 'merge-site', conflict: ChangeConflict, profileId: number | null): void
  /** 放弃本地草稿，保留对方已保存内容 */
  (e: 'discard', conflict: ChangeConflict): void
  /** 方案已停用/移除：把草稿另存为新方案 */
  (e: 'save-as-new', conflict: ChangeConflict, content: ProfileContent): void
}>()

const selection = ref<Record<string, FieldSide>>({})
const saveAsNew = ref(false)
const newProfileName = ref('')

const diffs = computed<FieldDiff[]>(() => (props.conflict ? buildFieldDiffs(props.conflict) : []))

watch(
  () => props.conflict?.id,
  () => {
    selection.value = {}
    saveAsNew.value = false
    newProfileName.value = props.conflict ? `${props.conflict.profileName ?? '权重方案'}（合并副本）` : ''
    for (const d of diffs.value) {
      selection.value[d.key] = d.preferred
    }
  },
  { immediate: true }
)

function nameOf(id: number | null): string {
  return props.profileNameOf ? props.profileNameOf(id) : id == null ? '待选择' : `方案 #${id}`
}

function valueText(key: string, value: unknown): string {
  return formatFieldValue(key, value, nameOf)
}

const isProfile = computed(() => props.conflict?.resource === 'profile')
const isSite = computed(() => props.conflict?.resource === 'site')
const bothChangedFields = computed(() => diffs.value.filter((d) => d.bothChanged))

/** 按字段选择合并方案内容。未出现在 diff 的字段取 current（库内最新）。 */
const mergedProfile = computed<ProfileContent | null>(() => {
  if (!props.conflict || !isProfile.value) return null
  const current = (props.conflict.current ?? {}) as Record<string, string | number>
  const incoming = (props.conflict.incoming ?? {}) as Record<string, string | number>
  const flat: Record<string, string | number> = { ...current }
  for (const d of diffs.value) {
    const pick = selection.value[d.key] ?? d.preferred
    flat[d.key] = pick === 'incoming' ? (incoming[d.key] ?? current[d.key]) : current[d.key]
  }
  // current/incoming 只摊平了内容字段；补齐可能缺省的键
  return unflattenProfile(flat) as ProfileContent
})

const mergedSiteProfileId = computed<number | null>(() => {
  if (!props.conflict || !isSite.value) return null
  const field = diffs.value.find((d) => d.key === 'defaultProfileId')
  if (!field) return null
  const pick = selection.value['defaultProfileId'] ?? field.preferred
  const chosen = pick === 'incoming' ? field.incoming : field.current
  return chosen == null || chosen === '' ? null : Number(chosen)
})

function chooseAll(side: FieldSide): void {
  for (const d of diffs.value) selection.value[d.key] = side
}

function close(): void {
  emit('update:modelValue', false)
}

function confirmMerge(): void {
  if (!props.conflict) return
  if (isProfile.value && mergedProfile.value) {
    emit('merge-profile', props.conflict, mergedProfile.value)
  } else if (isSite.value) {
    emit('merge-site', props.conflict, mergedSiteProfileId.value)
  }
  close()
}

function confirmDiscard(): void {
  if (!props.conflict) return
  emit('discard', props.conflict)
  close()
}

function confirmSaveAsNew(): void {
  if (!props.conflict || !mergedProfile.value) return
  emit('save-as-new', props.conflict, { ...mergedProfile.value, name: newProfileName.value.trim() || mergedProfile.value.name })
  close()
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="conflict ? CONFLICT_REASON_LABELS[conflict.reason] : '保存冲突'"
    width="860px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="conflict" class="conflict">
      <el-alert type="warning" :closable="false" show-icon class="conflict__alert">
        <template #title>{{ conflict.summary }}</template>
        <template #default>
          检测时间 {{ formatDateTime(conflict.createdAt) }} · 保存方：{{ conflict.author ?? '—' }}。
          双方的改动都已保留为草稿，逐字段确认后再统一启用并重算名次。
        </template>
      </el-alert>

      <el-alert
        v-if="conflict.profileMissing"
        type="error"
        :closable="false"
        show-icon
        title="原方案已被停用或移除，无法就地保存"
        description="可以把你的权重调整另存为一个新方案；引用原方案的营位仍处于待选择，需要重新指定。"
        class="conflict__alert"
      />

      <el-table :data="diffs" size="small" border class="conflict__table">
        <el-table-column label="字段" width="120">
          <template #default="{ row }">
            <strong>{{ row.label }}</strong>
            <el-tag v-if="row.bothChanged" type="danger" size="small" class="mt2">双方都改</el-tag>
            <el-tag v-else-if="row.changedByMe" type="success" size="small" class="mt2">仅我改</el-tag>
            <el-tag v-else type="info" size="small" class="mt2">对方改</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原值（共同基线）" min-width="150">
          <template #default="{ row }">
            <span class="conflict__base">{{ valueText(row.key, row.base) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="对方已保存" min-width="150">
          <template #default="{ row }">
            <el-radio
              :model-value="selection[row.key]"
              value="current"
              @update:model-value="selection[row.key] = 'current'"
            >
              <span :class="{ 'conflict__pick': selection[row.key] === 'current' }">
                {{ valueText(row.key, row.current) }}
              </span>
            </el-radio>
          </template>
        </el-table-column>
        <el-table-column label="我的草稿" min-width="150">
          <template #default="{ row }">
            <el-radio
              :model-value="selection[row.key]"
              value="incoming"
              @update:model-value="selection[row.key] = 'incoming'"
            >
              <span :class="{ 'conflict__pick': selection[row.key] === 'incoming' }">
                {{ valueText(row.key, row.incoming) }}
              </span>
            </el-radio>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="conflict.profileMissing && isProfile" class="conflict__saveas">
        <el-checkbox v-model="saveAsNew">把我的权重调整另存为新方案</el-checkbox>
        <el-input v-if="saveAsNew" v-model="newProfileName" placeholder="新方案名称" style="width: 320px" />
      </div>
    </div>

    <template #footer>
      <template v-if="conflict">
        <el-button @click="confirmDiscard">放弃我的草稿</el-button>
        <el-button
          v-if="!conflict.profileMissing && bothChangedFields.length > 1"
          @click="chooseAll('current')"
        >
          全部采用对方
        </el-button>
        <el-button
          v-if="!conflict.profileMissing && bothChangedFields.length > 1"
          @click="chooseAll('incoming')"
        >
          全部采用我的
        </el-button>
        <el-button
          v-if="conflict.profileMissing && isProfile && saveAsNew"
          type="primary"
          @click="confirmSaveAsNew"
        >
          另存为新方案
        </el-button>
        <el-button
          v-else-if="!conflict.profileMissing"
          type="primary"
          @click="confirmMerge"
        >
          合并后启用并重算
        </el-button>
      </template>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conflict {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.conflict__alert {
  flex-shrink: 0;
}
.conflict__table {
  width: 100%;
}
.conflict__base {
  color: var(--gb-muted);
}
.conflict__pick {
  font-weight: 600;
}
.mt2 {
  margin-top: 2px;
}
.conflict__saveas {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
