<script setup lang="ts">
/**
 * `/scoring` 权重与评分 —— 拖动各因子权重条，名次随权重实时刷新，可另存为季节方案。
 * 消费 ScoreProfile、Campsite；复用 <WeightEditor>、<GradeBadge>、<ConflictDialog>。
 * 保存时做乐观并发核对：若方案在别处被改过，弹出冲突框并列变化、留草稿、合并后再启用重算。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import WeightEditor from '@/components/common/WeightEditor.vue'
import GradeBadge from '@/components/common/GradeBadge.vue'
import ConflictDialog from '@/components/common/ConflictDialog.vue'
import ConflictHistory from '@/components/common/ConflictHistory.vue'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useConflictStore } from '@/stores/conflictStore'
import { useRanking } from '@/hooks/useRanking'
import { NORMALIZE_LABELS, SEASONS, weightSumGuard } from '@/types/score'
import type { FactorWeights, NormalizeMethod, GradeThresholds, ScoreProfile } from '@/types/score'
import type { ConflictResolution } from '@/types/conflict'
import { formatScore } from '@/utils/format'
import { weightSum } from '@/utils/score'

const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()
const conflictStore = useConflictStore()

/** 当前启用的方案快照，用于「恢复当前方案」与版本核对 */
const activeSnapshot = ref<{
  weights: FactorWeights
  normalize: NormalizeMethod
  thresholds: GradeThresholds
  season: string
  version: number
} | null>(null)

function snapshotActive(): void {
  const p = profileStore.activeProfile
  if (!p) return
  activeSnapshot.value = {
    weights: { ...p.weights },
    normalize: p.normalize,
    thresholds: { ...p.thresholds },
    season: p.season,
    version: p.version
  }
  uiStore.syncFromProfile(p.weights, p.normalize, p.thresholds, p.season)
}

onMounted(() => {
  snapshotActive()
  void conflictStore.load()
})

watch(
  () => profileStore.activeProfile?.id,
  () => snapshotActive()
)

const { ranked, best } = useRanking({
  sites: () => siteStore.list,
  factorOf: (id: number) => siteStore.latestFactor(id),
  weights: () => uiStore.workingWeights,
  normalize: () => uiStore.workingNormalize,
  thresholds: () => uiStore.workingThresholds,
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
  if (!snap) {
    ElMessage.info('当前没有启用中的方案')
    return
  }
  uiStore.syncFromProfile(snap.weights, snap.normalize, snap.thresholds, snap.season)
  ElMessage.success('已恢复到当前启用方案的权重')
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
    version: 1,
    note:
      saveForm.value.note.trim() ||
      `权重合计 ${totalWeight.value}，由「${profileStore.activeProfile?.name ?? '默认'}」另存`,
    createdAt: '',
    updatedAt: ''
  })
  if (saveForm.value.activate) {
    await profileStore.activate(id)
  }
  snapshotActive()
  uiStore.dirty = false
  saveDialog.value = false
  ElMessage.success(`方案「${name}」已保存${saveForm.value.activate ? '并启用' : ''}`)
}

/* --------------------------- 保存当前方案（带版本核对） --------------------------- */
const conflictDialog = ref(false)
const conflictData = ref<{
  localDraft: unknown
  remoteSnapshot: unknown
  baseVersion: number
  remoteVersion: number
  remoteUpdatedAt?: string
  profileId: number
} | null>(null)

async function saveCurrentProfile(): Promise<void> {
  const active = profileStore.activeProfile
  if (!active || typeof active.id !== 'number') {
    ElMessage.warning('当前没有启用中的方案')
    return
  }
  const baseVersion = activeSnapshot.value?.version ?? active.version
  const patch: Partial<ScoreProfile> = {
    weights: { ...uiStore.workingWeights },
    normalize: uiStore.workingNormalize,
    thresholds: { ...uiStore.workingThresholds }
  }
  const result = await profileStore.updateProfile(active.id, patch, baseVersion)
  if (result.conflict && result.current) {
    // 版本冲突：弹出核对框
    conflictData.value = {
      localDraft: patch,
      remoteSnapshot: result.current,
      baseVersion,
      remoteVersion: result.current.version,
      remoteUpdatedAt: result.current.updatedAt,
      profileId: active.id
    }
    conflictDialog.value = true
    // 先落一条「待处理」冲突记录
    await conflictStore.add({
      entityType: 'profile',
      entityId: active.id,
      entityName: active.name,
      conflictType: 'version-mismatch',
      summary: `保存时发现方案已被别处修改（v${baseVersion} → v${result.current.version}）`,
      localDraft: patch,
      remoteSnapshot: result.current,
      baseVersion,
      remoteVersion: result.current.version,
      resolution: 'pending'
    })
  } else {
    snapshotActive()
    uiStore.dirty = false
    ElMessage.success('方案已保存，名次已按新权重重算')
  }
}

async function onConflictResolve(resolution: ConflictResolution): Promise<void> {
  const data = conflictData.value
  if (!data) return
  const active = profileStore.activeProfile
  if (!active || typeof active.id !== 'number') return

  if (resolution === 'kept-remote') {
    // 放弃本地，采用远端
    const remote = data.remoteSnapshot as ScoreProfile
    uiStore.syncFromProfile(remote.weights, remote.normalize, remote.thresholds, remote.season)
    uiStore.dirty = false
    snapshotActive()
  } else if (resolution === 'kept-local') {
    // 保留本地：强制保存（不带版本核对）
    const patch = data.localDraft as Partial<ScoreProfile>
    await profileStore.updateProfile(data.profileId, patch)
    snapshotActive()
    uiStore.dirty = false
  } else {
    // 合并：以本地为基础，合并远端的非冲突字段（这里简单采用本地权重 + 远端阈值）
    const patch = data.localDraft as Partial<ScoreProfile>
    const remote = data.remoteSnapshot as ScoreProfile
    const merged: Partial<ScoreProfile> = {
      ...patch,
      thresholds: patch.thresholds ?? remote.thresholds
    }
    await profileStore.updateProfile(data.profileId, merged)
    snapshotActive()
    uiStore.dirty = false
  }

  // 更新最近一条冲突记录的处理结果
  const records = conflictStore.ofEntity('profile', data.profileId)
  const pending = records.find((r) => r.resolution === 'pending')
  if (pending && typeof pending.id === 'number') {
    await conflictStore.resolve(pending.id, resolution)
  }
  conflictDialog.value = false
  conflictData.value = null
  ElMessage.success('冲突已处理，方案已保存并启用')
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

async function removeProfileRow(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  if (profileStore.total <= 1) {
    ElMessage.warning('至少保留一个权重方案')
    return
  }
  try {
    await ElMessageBox.confirm(
      '确认删除该权重方案？引用它的营位将转入「待选择方案」，不会静默回退到别的方案。',
      '提示',
      { type: 'warning' }
    )
    await profileStore.removeProfile(id)
    const fallback = profileStore.list[0]
    if (fallback && typeof fallback.id === 'number' && !profileStore.activeProfile) {
      await profileStore.activate(fallback.id)
    }
    snapshotActive()
    ElMessage.success('方案已删除，引用它的营位已转入待选择')
  } catch {
    /* 用户取消 */
  }
}

/** 显式停用方案：引用它的营位转入待选择，不静默回退。 */
async function disableProfile(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  const profile = profileStore.byId(id)
  if (!profile) return
  try {
    await ElMessageBox.confirm(
      `确认停用方案「${profile.name}」？引用它的营位将转入「待选择方案」，需手动指定新方案。`,
      '提示',
      { type: 'warning' }
    )
    const result = await profileStore.updateProfile(id, { active: false }, profile.version)
    if (result.conflict && result.current) {
      ElMessage.warning('方案已被别处修改，请刷新后重试')
      return
    }
    // 若停用的是当前启用方案，自动启用另一个（但不回退营位的 defaultProfileId）
    if (profile.active) {
      const other = profileStore.list.find((p) => p.id !== id)
      if (other && typeof other.id === 'number') {
        await profileStore.activate(other.id)
      }
    }
    snapshotActive()
    ElMessage.success('方案已停用，引用它的营位已转入待选择')
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
        <el-button @click="saveCurrentProfile">保存当前方案</el-button>
        <el-button type="primary" @click="openSaveDialog">另存为季节方案</el-button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">启用方案</div>
        <div class="stat-card__value profile-name">{{ profileStore.activeProfile?.name ?? '—' }}</div>
        <div class="stat-card__extra">
          适用季节 {{ profileStore.activeProfile?.season ?? '—' }} ·
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
        <span class="weight-note">启用中的方案会被首页、详情页与地图共同采用；停用或删除方案会使引用它的营位转入待选择</span>
      </div>
      <el-table :data="profileStore.list" size="small" border>
        <el-table-column label="方案名" min-width="180">
          <template #default="{ row }">
            <span class="profile-cell">{{ row.name }}</span>
            <el-tag v-if="row.active" type="success" size="small" class="ml6">启用中</el-tag>
            <div class="cell-sub">{{ row.note }}</div>
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
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" :disabled="row.active" @click="useProfile(row.id)">
              启用
            </el-button>
            <el-button size="small" text type="warning" :disabled="!row.active" @click="disableProfile(row.id)">
              停用
            </el-button>
            <el-button size="small" text @click="copyProfile(row.id)">复制</el-button>
            <el-button size="small" text type="danger" @click="removeProfileRow(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>方案冲突记录</h2>
        <span class="weight-note">多人同时编辑或方案被停用/移除时的版本核对与处理留痕</span>
      </div>
      <ConflictHistory v-if="profileStore.activeProfile" entity-type="profile" :entity-id="profileStore.activeProfile.id" :limit="8" />
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

    <ConflictDialog
      v-if="conflictData"
      v-model="conflictDialog"
      entity-type="profile"
      :entity-name="profileStore.activeProfile?.name ?? '方案'"
      conflict-type="version-mismatch"
      :summary="`保存时发现方案已被别处修改（v${conflictData.baseVersion} → v${conflictData.remoteVersion}），请核对后选择处理方式`"
      :local-draft="conflictData.localDraft"
      :remote-snapshot="conflictData.remoteSnapshot"
      :base-version="conflictData.baseVersion"
      :remote-version="conflictData.remoteVersion"
      :remote-updated-at="conflictData.remoteUpdatedAt"
      @resolve="onConflictResolve"
    />
  </div>
</template>

<style scoped>
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
