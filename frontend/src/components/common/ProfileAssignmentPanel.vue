<script setup lang="ts">
/**
 * ProfileAssignmentPanel —— 营位的「权重方案指定」面板。
 *
 * 保存时带乐观锁：进入面板时记下营位 updatedAt 与所选方案版本，
 * 若期间营位被别处保存、或方案被别人改动，则保留双方选择并弹出三方合并。
 * 待选择（未指定 / 方案停用 / 移除）的营位必须在此显式重新指定，不会自动换方案。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Campsite } from '@/types/campsite'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useConflictStore } from '@/stores/conflictStore'

const props = defineProps<{
  site: Campsite
  /** 紧凑模式（名次表待选择行内使用） */
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'assigned', siteId: number): void
  /** 发生保存冲突，或点击未处理冲突时，请求页面打开合并对话框 */
  (e: 'conflict', conflictId: number): void
}>()

const siteStore = useSiteStore()
const profileStore = useProfileStore()
const conflictStore = useConflictStore()

const selectId = ref<number | null>(null)
const editing = ref(false)
const baseUpdatedAt = ref('')
const baseProfileId = ref<number | null>(null)
/** 打开面板时「当前下拉所选方案」的版本（改选其它方案时按它核对） */
const selectedProfileVersion = ref<number | null>(null)
const saving = ref(false)

const assignment = computed(() => profileStore.assignmentOf(props.site))

/** 同步下拉所选方案在打开面板这一刻的版本，避免改选到已被改动的方案时误判。 */
function syncSelectedVersion(): void {
  const p = profileStore.byId(selectId.value)
  selectedProfileVersion.value = p && !p.retiredAt ? p.version : null
}

watch(
  () => props.site.id,
  () => {
    selectId.value = props.site.defaultProfileId ?? null
    editing.value = false
  },
  { immediate: true }
)

function startAssign(): void {
  selectId.value = props.site.defaultProfileId ?? null
  baseUpdatedAt.value = props.site.updatedAt
  baseProfileId.value = props.site.defaultProfileId ?? null
  syncSelectedVersion()
  editing.value = true
}

function onSelectChange(value: number | null): void {
  selectId.value = value
  syncSelectedVersion()
}

function cancelAssign(): void {
  editing.value = false
  selectId.value = props.site.defaultProfileId ?? null
}

async function saveAssign(): Promise<void> {
  if (typeof props.site.id !== 'number') return
  saving.value = true
  try {
    const result = await siteStore.saveAssignment({
      siteId: props.site.id,
      profileId: selectId.value,
      expectedUpdatedAt: baseUpdatedAt.value,
      // 按「打开面板时所选方案」的版本核对，而不是原方案版本
      expectedProfileVersion: selectedProfileVersion.value,
      baseProfileId: baseProfileId.value
    })
    if (result.ok) {
      editing.value = false
      ElMessage.success('营位方案指定已保存，名次与等级已按该方案重算')
      emit('assigned', props.site.id)
    } else if (result.conflictId !== undefined) {
      ElMessage.warning('保存前发现别处改动，双方选择均已保留，请先合并')
      emit('conflict', result.conflictId)
    }
  } finally {
    saving.value = false
  }
}

/** 该营位尚未处理的指定冲突，供详情页外的入口提示。 */
const openConflict = computed(() =>
  conflictStore.ofSite(props.site.id).find((c) => c.status === 'open' && c.resource === 'site') ?? null
)

defineExpose({ startAssign })
</script>

<template>
  <div class="assign" :class="{ 'assign--compact': compact }">
    <template v-if="!editing">
      <div class="assign__view">
        <template v-if="assignment.pending">
          <el-tag type="warning" size="small">待选择</el-tag>
          <span class="assign__reason">
            <template v-if="assignment.pendingReason === 'retired'">
              原方案「{{ assignment.profile?.name }}」已停用，未自动切换其它方案
            </template>
            <template v-else-if="assignment.pendingReason === 'removed'">
              原方案（#{{ site.defaultProfileId }}）已移除，未自动切换其它方案
            </template>
            <template v-else>尚未指定评分方案</template>
          </span>
          <el-button size="small" type="primary" plain @click="startAssign">指定方案</el-button>
        </template>
        <template v-else>
          <el-tag type="success" size="small">方案：{{ assignment.profile?.name }}</el-tag>
          <el-tag v-if="assignment.stale" type="warning" size="small">
            方案已更新至 v{{ assignment.profile?.version }}，名次已重算
          </el-tag>
          <el-button size="small" text type="primary" @click="startAssign">改指定</el-button>
        </template>
        <el-button
          v-if="openConflict"
          size="small"
          type="danger"
          plain
          @click="emit('conflict', openConflict.id as number)"
        >
          有待合并的指定冲突
        </el-button>
      </div>
    </template>

    <template v-else>
      <div class="assign__edit">
        <el-select
          :model-value="selectId"
          placeholder="选择权重方案"
          style="width: 240px"
          @update:model-value="onSelectChange"
        >
          <el-option
            v-for="p in profileStore.liveList"
            :key="p.id"
            :label="`${p.name} · ${p.season}（v${p.version}）`"
            :value="p.id as number"
          />
        </el-select>
        <el-button size="small" type="primary" :loading="saving" @click="saveAssign">保存指定</el-button>
        <el-button size="small" @click="cancelAssign">取消</el-button>
        <span class="assign__hint">保存时会核对营位与方案版本，发现别人改动会先列变化、保留双方草稿</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.assign__view,
.assign__edit {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.assign__reason {
  font-size: 12px;
  color: #92400e;
}
.assign__hint {
  font-size: 11px;
  color: var(--gb-muted);
}
.assign--compact .assign__reason {
  font-size: 11px;
}
</style>
