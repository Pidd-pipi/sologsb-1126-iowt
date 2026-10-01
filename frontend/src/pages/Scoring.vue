<script setup lang="ts">
/**
 * `/scoring` 权重与评分 —— 拖动各因子权重条，名次随权重实时刷新；
 * 「保存修改到当前方案」走乐观锁版本核对：别人先改过则列变化、保留双方草稿，合并后统一启用重算。
 * 方案可另存为季节方案；可停用（引用营位转待选择）或移除；方案库展示版本号。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import WeightEditor from '@/components/common/WeightEditor.vue'
import GradeBadge from '@/components/common/GradeBadge.vue'
import ConflictResolveDialog from '@/components/common/ConflictResolveDialog.vue'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useConflictStore } from '@/stores/conflictStore'
import { useRanking } from '@/hooks/useRanking'
import { NORMALIZE_LABELS, SEASONS, weightSumGuard } from '@/types/score'
import type {
  FactorWeights,
  NormalizeMethod,
  ScoreProfile
} from '@/types/score'
import type { ChangeConflict } from '@/types/conflict'
import type { ProfileContent } from '@/utils/conflict'
import { profileContent } from '@/utils/conflict'
import { formatScore } from '@/utils/format'
import { weightSum } from '@/utils/score'

const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()
const conflictStore = useConflictStore()

/** 当前编辑所基于的启用方案快照（含内容版本），用于版本核对与三方对比的 base */
const activeSnapshot = ref<{
  profileId: number
  version: number
  content: ProfileContent
} | null>(null)

/** 实时预览用的「虚拟方案」：以页面上正在调整的工作副本为内容，不入库 */
const workingProfile = computed<ScoreProfile>(() => ({
  id: -1,
  name: '工作副本',
  weights: { ...uiStore.workingWeights },
  normalize: uiStore.workingNormalize,
  thresholds: { ...uiStore.workingThresholds },
  season: uiStore.workingSeason,
  active: true,
  version: -1,
  retiredAt: null,
  note: '',
  createdAt: '',
  updatedAt: ''
}))

function snapshotActive(): void {
  const p = profileStore.activeProfile
  if (!p) {
    activeSnapshot.value = null
    return
  }
  activeSnapshot.value = { profileId: p.id as number, version: p.version, content: profileContent(p) }
  uiStore.syncFromProfile(p.weights, p.normalize, p.thresholds, p.season)
}

onMounted(() => {
  snapshotActive()
})

watch(
  () => profileStore.activeProfile?.id,
  () => snapshotActive()
)

/** 启用方案在别处被改动（且本地有未保存调整）时给出提示 */
const remoteChangedWhileEditing = ref(false)
watch(
  () => profileStore.activeProfile?.version,
  (v, old) => {
    if (old !== undefined && v !== undefined && v !== old && uiStore.dirty && activeSnapshot.value) {
      remoteChangedWhileEditing.value = true
    }
  }
)

const { ranked, best } = useRanking({
  sites: () => siteStore.list,
  factorOf: (id: number) => siteStore.latestFactor(id),
  // 实时预览：所有营位都按页面上的工作副本评分
  assignmentOf: () => ({ profile: workingProfile.value, pending: false, pendingReason: '' as const, stale: false }),
  vetoedIds: () => uiStore.vetoedSiteIds
})

const totalWeight = computed(() => weightSum(uiStore.workingWeights))

const gradeDistribution = computed(() => {
  const rows = ranked.value
  return {
    A: rows.filter((r) => r.grade === 'A').length,
    B: rows.filter((r) => r.grade === 'B').length,
    C: rows.filter((r) => r.grade === 'C').length
  }
})

/** 权重改变 → 标记为未保存，名次由 computed 自动重算 */
function onWeightsChange(next: FactorWeights): void {
  uiStore.workingWeights = next
  uiStore.dirty = true
}

function onPreset(next: FactorWeights): void {
  uiStore.workingWeights = { ...next }
  uiStore.dirty = true
}

function onNormalizeChange(): void {
  uiStore.dirty = true
}

function setNormalize(value: unknown): void {
  uiStore.workingNormalize = value === 'threshold' ? 'threshold' : 'minmax'
  onNormalizeChange()
}

function setGradeA(value: number | number[] | undefined): void {
  const num = Array.isArray(value) ? value[0] : value
  if (typeof num !== 'number') return
  uiStore.workingThresholds = { ...uiStore.workingThresholds, gradeA: num }
  onThresholdChange()
}

function setGradeB(value: number | number[] | undefined): void {
  const num = Array.isArray(value) ? value[0] : value
  if (typeof num !== 'number') return
  uiStore.workingThresholds = { ...uiStore.workingThresholds, gradeB: num }
  onThresholdChange()
}

function onThresholdChange(): void {
  uiStore.dirty = true
}

function revertToActive(): void {
  const snap = activeSnapshot.value
  const p = snap ? profileStore.byId(snap.profileId) : profileStore.activeProfile
  if (!p) {
    ElMessage.info('当前没有启用中的方案')
    return
  }
  uiStore.syncFromProfile(p.weights, p.normalize, p.thresholds, p.season)
  activeSnapshot.value = { profileId: p.id as number, version: p.version, content: profileContent(p) }
  remoteChangedWhileEditing.value = false
  ElMessage.success('已恢复到当前启用方案的权重')
}

/** 把工作副本的内容收集成方案内容 */
function workingContent(): ProfileContent {
  return {
    name: activeSnapshot.value ? profileStore.byId(activeSnapshot.value.profileId)?.name ?? '启用方案' : '启用方案',
    weights: { ...uiStore.workingWeights },
    normalize: uiStore.workingNormalize,
    thresholds: { ...uiStore.workingThresholds },
    season: uiStore.workingSeason,
    note: profileStore.byId(activeSnapshot.value?.profileId ?? -1)?.note ?? ''
  }
}

/** 保存修改到当前启用方案（带版本核对） */
const saving = ref(false)
async function saveToActive(): Promise<void> {
  const snap = activeSnapshot.value
  if (!snap) {
    ElMessage.info('当前没有启用中的方案，请用「另存为季节方案」')
    return
  }
  saving.value = true
  try {
    const result = await profileStore.saveProfile(
      snap.profileId,
      workingContent(),
      snap.version,
      snap.content
    )
    if (result.ok) {
      ElMessage.success('方案修改已保存并启用，受影响营位已统一重算')
      snapshotActive()
      uiStore.dirty = false
      remoteChangedWhileEditing.value = false
    } else if (result.conflictId !== undefined) {
      activeConflictId.value = result.conflictId
      dialogVisible.value = true
    }
  } finally {
    saving.value = false
  }
}

/* ----------------------------- 冲突合并对话框 ----------------------------- */
const dialogVisible = ref(false)
const activeConflictId = ref<number | null>(null)
const activeConflict = computed(() =>
  activeConflictId.value == null
    ? null
    : conflictStore.list.find((c) => c.id === activeConflictId.value) ?? null
)

async function onMergeProfile(conflict: ChangeConflict, merged: ProfileContent): Promise<void> {
  if (typeof conflict.id !== 'number') return
  const result = await profileStore.resolveProfileConflict(conflict.id, merged)
  if (result.ok) {
    ElMessage.success('双方改动已合并启用，受影响营位已统一重算')
    snapshotActive()
    uiStore.dirty = false
    remoteChangedWhileEditing.value = false
  }
}

async function onDiscard(conflict: ChangeConflict): Promise<void> {
  if (typeof conflict.id !== 'number') return
  await conflictStore.markMerged(conflict.id, '已放弃本地权重草稿，采用先保存的方案')
  ElMessage.info('已放弃本地草稿')
  snapshotActive()
  uiStore.dirty = false
  remoteChangedWhileEditing.value = false
}

async function onSaveAsNew(conflict: ChangeConflict, content: ProfileContent): Promise<void> {
  const id = await profileStore.createProfile({ ...content, active: true })
  await profileStore.activate(id)
  if (typeof conflict.id === 'number') {
    await conflictStore.markMerged(conflict.id, `权重草稿另存为新方案「${content.name}」并启用`)
  }
  ElMessage.success(`已另存为「${content.name}」并启用`)
  snapshotActive()
  uiStore.dirty = false
}

function profileNameOf(id: number | null): string {
  return profileStore.byId(id)?.name ?? (id == null ? '待选择' : `方案 #${id}`)
}

/* --------------------------- 另存为季节方案 --------------------------- */
const saveDialog = ref(false)
const saveForm = ref({ name: '', season: '夏季', note: '', activate: true })

function openSaveDialog(): void {
  const base = profileStore.activeProfile?.name ?? '均衡型方案'
  saveForm.value = {
    name: `${saveForm.value.season || '季节'}方案 · ${base}`,
    season: saveForm.value.season || '夏季',
    note: '',
    activate: true
  }
  saveDialog.value = true
}

async function confirmSave(): Promise<void> {
  const name = saveForm.value.name.trim()
  if (!name) {
    ElMessage.warning('请填写方案名')
    return
  }
  const id = await profileStore.createProfile({
    name,
    weights: { ...uiStore.workingWeights },
    normalize: uiStore.workingNormalize,
    thresholds: { ...uiStore.workingThresholds },
    season: saveForm.value.season,
    active: saveForm.value.activate,
    note:
      saveForm.value.note.trim() ||
      `权重合计 ${totalWeight.value}，由「${profileStore.activeProfile?.name ?? '默认'}」另存`
  })
  if (saveForm.value.activate) {
    await profileStore.activate(id)
  }
  snapshotActive()
  uiStore.dirty = false
  saveDialog.value = false
  ElMessage.success(`方案「${name}」已保存${saveForm.value.activate ? '并启用' : ''}`)
}

async function useProfile(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  await profileStore.activate(id)
  snapshotActive()
  ElMessage.success('已切换启用方案，名次表与详情页同步更新')
}

async function copyProfile(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  const src = profileStore.byId(id)
  if (!src) return
  const name = `${src.name} 副本`
  const newId = await profileStore.duplicateProfile(id, name, src.season)
  await profileStore.activate(newId)
  snapshotActive()
  ElMessage.success(`已复制为「${name}」并启用`)
}

/** 停用方案（不删除）：引用营位转待选择 */
async function retireProfileRow(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  const p = profileStore.byId(id)
  try {
    await ElMessageBox.confirm(
      `确认停用「${p?.name ?? '该方案'}」？引用它的营位将转入待选择，需要逐个重新指定，不会自动换用其它方案。`,
      '停用方案',
      { type: 'warning' }
    )
    await profileStore.retireProfile(id)
    if (profileStore.activeProfile?.id === id) snapshotActive()
    ElMessage.success('方案已停用，引用营位已转入待选择')
  } catch {
    /* 用户取消 */
  }
}

async function removeProfileRow(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  if (profileStore.liveTotal <= 1) {
    ElMessage.warning('至少保留一个未停用的权重方案')
    return
  }
  const p = profileStore.byId(id)
  try {
    await ElMessageBox.confirm(
      `确认移除「${p?.name ?? '该方案'}」？引用它的营位将转入待选择，需要逐个重新指定，不会自动换用其它方案。`,
      '移除方案',
      { type: 'warning' }
    )
    await profileStore.removeProfile(id)
    snapshotActive()
    ElMessage.success('方案已移除，引用营位已转入待选择')
  } catch {
    /* 用户取消 */
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>权重与评分</h1>
        <p>
          拖动下方各因子权重条，右侧名次会实时重排；调整归一方式与 A/B/C 阈值可改变整体松紧。
          满意后可另存为季节方案，首页与详情页会立即采用启用中的方案。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="revertToActive">恢复当前方案</el-button>
        <el-button @click="openSaveDialog">另存为季节方案</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!uiStore.dirty || !activeSnapshot"
          @click="saveToActive"
        >
          保存修改到当前方案
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="remoteChangedWhileEditing"
      type="warning"
      :closable="false"
      show-icon
      class="remote-alert"
      title="启用方案在别处被改动了"
      description="你的调整仍保留在工作区。点「保存修改到当前方案」会先列出双方变化并保留两份草稿，合并后再统一启用和重算；点「恢复当前方案」则放弃本地调整。"
    />

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">启用方案</div>
        <div class="stat-card__value profile-name">
          {{ profileStore.activeProfile?.name ?? '无启用方案' }}
        </div>
        <div class="stat-card__extra">
          版本 v{{ profileStore.activeProfile?.version ?? '—' }} · 适用季节
          {{ profileStore.activeProfile?.season ?? '—' }} ·
          {{ profileStore.activeProfile ? NORMALIZE_LABELS[profileStore.activeProfile.normalize] : '—' }}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">权重合计</div>
        <div class="stat-card__value">{{ totalWeight }}</div>
        <div class="stat-card__extra">{{ uiStore.dirty ? '有未保存的调整' : '与启用方案一致' }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">A / B / C 分布</div>
        <div class="stat-card__value">
          {{ gradeDistribution.A }} / {{ gradeDistribution.B }} / {{ gradeDistribution.C }}
        </div>
        <div class="stat-card__extra">随权重实时变化</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">当前第一名</div>
        <div class="stat-card__value">{{ formatScore(best?.total ?? 0) }}</div>
        <div class="stat-card__extra">
          {{ best ? `${best.site.code} ${best.site.name}` : '暂无营位' }}
        </div>
      </div>
    </div>

    <section class="panel">
      <div class="panel__head">
        <h2>因子权重</h2>
        <span class="weight-note">权重为 0 的因子不参与加权求和</span>
      </div>
      <WeightEditor
        :weights="uiStore.workingWeights"
        @change="onWeightsChange"
        @preset="onPreset"
      />

      <el-divider content-position="left">归一方式与等级阈值</el-divider>
      <div class="scoring-config">
        <div class="scoring-config__item">
          <span class="scoring-config__label">归一化方式</span>
          <el-radio-group
            :model-value="uiStore.workingNormalize"
            @update:model-value="setNormalize"
          >
            <el-radio-button value="minmax">极差归一</el-radio-button>
            <el-radio-button value="threshold">阈值分段</el-radio-button>
          </el-radio-group>
          <span class="weight-note">
            极差归一看同批营位相对位置；阈值分段按固定档位给分，结果不受同批数据影响。
          </span>
        </div>
        <div class="scoring-config__item">
          <span class="scoring-config__label">A 级阈值</span>
          <el-slider
            :model-value="uiStore.workingThresholds.gradeA"
            :min="50"
            :max="98"
            :step="1"
            style="width: 220px"
            @update:model-value="setGradeA"
          />
          <el-input-number
            :model-value="uiStore.workingThresholds.gradeA"
            :min="50"
            :max="99"
            size="small"
            style="width: 110px"
            controls-position="right"
            @update:model-value="setGradeA"
          />
        </div>
        <div class="scoring-config__item">
          <span class="scoring-config__label">B 级阈值</span>
          <el-slider
            :model-value="uiStore.workingThresholds.gradeB"
            :min="30"
            :max="90"
            :step="1"
            style="width: 220px"
            @update:model-value="setGradeB"
          />
          <el-input-number
            :model-value="uiStore.workingThresholds.gradeB"
            :min="10"
            :max="95"
            size="small"
            style="width: 110px"
            controls-position="right"
            @update:model-value="setGradeB"
          />
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>实时名次（跟随权重刷新）</h2>
        <span class="weight-note">共 {{ ranked.length }} 个营位</span>
      </div>
      <el-table :data="ranked" size="small" border stripe>
        <el-table-column label="名次" width="72" align="center">
          <template #default="{ row }">
            <strong class="rank">{{ row.rank }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="营位" min-width="200">
          <template #default="{ row }">
            <el-link type="primary" underline="never" @click="router.push(`/sites/${row.siteId}`)">
              {{ row.site.code }} · {{ row.site.name }}
            </el-link>
            <div class="cell-sub">{{ row.site.campName }} · {{ row.site.surface }}</div>
          </template>
        </el-table-column>
        <el-table-column label="坡度" width="88" align="right">
          <template #default="{ row }">{{ row.raw.slope.toFixed(1) }}°</template>
        </el-table-column>
        <el-table-column label="水源" width="92" align="right">
          <template #default="{ row }">{{ row.raw.waterDistance }} m</template>
        </el-table-column>
        <el-table-column label="信号" width="84" align="right">
          <template #default="{ row }">{{ row.raw.signal }} 格</template>
        </el-table-column>
        <el-table-column label="综合得分" width="104" align="right">
          <template #default="{ row }">
            <strong class="total">{{ formatScore(row.total) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="等级" width="190">
          <template #default="{ row }">
            <GradeBadge :grade="row.grade" :score="row.total" :vetoed="row.vetoed" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="否决" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.vetoed" type="danger" size="small">命中否决</el-tag>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="router.push(`/sites/${row.siteId}`)">
              详情
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>权重方案库</h2>
        <span class="weight-note">停用方案不参与排名；其引用营位处于待选择，需重新指定</span>
      </div>
      <el-table :data="profileStore.liveList" size="small" border>
        <el-table-column label="方案名" min-width="180">
          <template #default="{ row }">
            <span class="profile-cell">{{ row.name }}</span>
            <el-tag v-if="row.active" type="success" size="small" class="ml6">启用中</el-tag>
            <div class="cell-sub">{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column label="版本" width="80" align="center">
          <template #default="{ row }">
            <el-tag effect="plain" size="small">v{{ row.version }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="适用季节" width="110" prop="season" />
        <el-table-column label="归一方式" width="120">
          <template #default="{ row }">{{ NORMALIZE_LABELS[row.normalize as NormalizeMethod] }}</template>
        </el-table-column>
        <el-table-column label="阈值 A / B" width="120" align="center">
          <template #default="{ row }">{{ row.thresholds.gradeA }} / {{ row.thresholds.gradeB }}</template>
        </el-table-column>
        <el-table-column label="权重合计" width="106" align="center">
          <template #default="{ row }">{{ weightSum(row.weights) }}</template>
        </el-table-column>
        <el-table-column label="引用营位" width="90" align="center">
          <template #default="{ row }">
            {{ siteStore.list.filter((s) => s.defaultProfileId === row.id).length }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" :disabled="row.active" @click="useProfile(row.id)">
              启用
            </el-button>
            <el-button size="small" text @click="copyProfile(row.id)">复制</el-button>
            <el-button size="small" text type="warning" @click="retireProfileRow(row.id)">停用</el-button>
            <el-button size="small" text type="danger" @click="removeProfileRow(row.id)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <template v-if="profileStore.list.some((p) => p.retiredAt)">
        <el-divider content-position="left">已停用方案</el-divider>
        <el-table :data="profileStore.list.filter((p) => p.retiredAt)" size="small" border>
          <el-table-column label="方案名" min-width="180">
            <template #default="{ row }">
              <span class="profile-cell">{{ row.name }}</span>
              <el-tag type="info" size="small" class="ml6">已停用</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="版本" width="80" align="center">
            <template #default="{ row }">v{{ row.version }}</template>
          </el-table-column>
          <el-table-column label="适用季节" width="110" prop="season" />
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button size="small" text type="danger" @click="removeProfileRow(row.id)">彻底移除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </section>

    <el-dialog v-model="saveDialog" title="另存为季节方案" width="520px">
      <el-form label-width="100px">
        <el-form-item label="方案名">
          <el-input id="profile-name" v-model="saveForm.name" placeholder="如 雨季防风方案" />
        </el-form-item>
        <el-form-item label="适用季节">
          <el-select id="profile-season" v-model="saveForm.season" style="width: 100%">
            <el-option v-for="s in SEASONS" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            id="profile-note"
            v-model="saveForm.note"
            type="textarea"
            :rows="2"
            placeholder="记录本方案偏重的现场条件"
          />
        </el-form-item>
        <el-form-item label="立即启用">
          <el-switch id="profile-activate" v-model="saveForm.activate" />
        </el-form-item>
        <el-form-item label="将保存">
          <span class="weight-note">
            权重合计 {{ totalWeight }} · {{ NORMALIZE_LABELS[uiStore.workingNormalize] }} · 阈值 A ≥
            {{ uiStore.workingThresholds.gradeA }} / B ≥ {{ uiStore.workingThresholds.gradeB }}
          </span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="saveDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmSave">保存方案</el-button>
      </template>
    </el-dialog>

    <ConflictResolveDialog
      v-model="dialogVisible"
      :conflict="activeConflict"
      :profile-name-of="profileNameOf"
      @merge-profile="onMergeProfile"
      @discard="onDiscard"
      @save-as-new="onSaveAsNew"
    />
  </div>
</template>

<style scoped>
.remote-alert {
  margin-bottom: 14px;
}
.scoring-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.scoring-config__item {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.scoring-config__label {
  width: 92px;
  font-size: 13px;
  color: var(--gb-ink);
}
.profile-name {
  font-size: 16px;
}
.profile-cell {
  font-weight: 600;
}
.total {
  color: var(--gb-accent-strong);
  font-variant-numeric: tabular-nums;
}
.rank {
  color: var(--gb-accent-strong);
  font-variant-numeric: tabular-nums;
}
.cell-sub {
  font-size: 11px;
  color: var(--gb-muted);
}
.ml6 {
  margin-left: 6px;
}
</style>
