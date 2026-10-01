<script setup lang="ts">
/**
 * `/sites/:id` 营位详情 —— 上部地图定位与基本信息，中部因子打分表，下部否决记录与多轮复核。
 * 消费四个模型；复用 <MapPanel>、<FactorScoreBar>、<GradeBadge>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import MapPanel from '@/components/common/MapPanel.vue'
import FactorScoreBar from '@/components/common/FactorScoreBar.vue'
import GradeBadge from '@/components/common/GradeBadge.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ProfileAssignmentPanel from '@/components/common/ProfileAssignmentPanel.vue'
import ConflictHistory from '@/components/common/ConflictHistory.vue'
import ConflictResolveDialog from '@/components/common/ConflictResolveDialog.vue'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useConflictStore } from '@/stores/conflictStore'
import { useRanking } from '@/hooks/useRanking'
import { FACTOR_META, NORMALIZE_LABELS } from '@/types/score'
import { ASPECT_TYPES, SURFACE_TYPES, ACCESS_MODES } from '@/types/campsite'
import type { AspectType, AccessMode, SurfaceType } from '@/types/campsite'
import type { Grade } from '@/utils/score'
import type { RockfallRisk, WindDir, WindForce } from '@/types/factor'
import { ROCKFALL_RISKS, WIND_DIRS, WIND_FORCES } from '@/types/factor'
import { VETO_TYPES, VETO_HINTS } from '@/types/veto'
import type { VetoType } from '@/types/veto'
import { formatDate, formatDateTime, todayIso } from '@/utils/format'
import { formatLat, formatLng } from '@/utils/geo'

const route = useRoute()
const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()
const conflictStore = useConflictStore()

const siteId = computed(() => Number(route.params.id))
const site = computed(() => siteStore.byId(siteId.value))

const { scoreOf } = useRanking({
  sites: () => siteStore.list,
  factorOf: (id: number) => siteStore.latestFactor(id),
  assignmentOf: (s) => profileStore.assignmentOf(s),
  vetoedIds: () => uiStore.vetoedSiteIds
})

const scoreRow = computed(() => scoreOf(siteId.value))

/** 供 MapPanel 与地图标记回调使用（待选择营位在地图上显示灰色「待」标记） */
function gradeOfSite(id: number): Grade | 'pending' {
  const target = siteStore.byId(id)
  if (target && profileStore.assignmentOf(target).pending) return 'pending'
  return scoreOf(id)?.grade ?? 'C'
}

function openSite(id: number): void {
  void router.push(`/sites/${id}`)
}
const grade = computed(() => scoreRow.value?.grade ?? 'C')
const factorHistory = computed(() => siteStore.factorsOf(siteId.value))
const vetoList = computed(() => uiStore.vetosOf(siteId.value))
const assignment = computed(() => profileStore.assignmentOf(site.value))
const siteConflicts = computed(() => conflictStore.ofSite(siteId.value))

/* --------------------------- 营位指定冲突合并 --------------------------- */
const dialogVisible = ref(false)
const activeConflictId = ref<number | null>(null)
const activeConflict = computed(() =>
  activeConflictId.value == null
    ? null
    : conflictStore.list.find((c) => c.id === activeConflictId.value) ?? null
)

function openConflict(id: number): void {
  activeConflictId.value = id
  dialogVisible.value = true
}

async function onMergeSite(conflictId: number, profileId: number | null): Promise<void> {
  await siteStore.resolveAssignmentConflict(conflictId, profileId)
  ElMessage.success('营位指定已合并，名次已按最新方案重算')
}

async function onMergeProfile(conflictId: number, merged: import('@/utils/conflict').ProfileContent): Promise<void> {
  const result = await profileStore.resolveProfileConflict(conflictId, merged)
  if (result.ok) ElMessage.success('双方方案改动已合并启用，受影响营位已统一重算')
}

async function onDiscardConflict(conflictId: number): Promise<void> {
  await conflictStore.markMerged(conflictId, '已放弃本地草稿')
  ElMessage.info('已放弃本地草稿')
}

async function onSaveAsNew(
  conflictId: number,
  content: import('@/utils/conflict').ProfileContent
): Promise<void> {
  const id = await profileStore.createProfile({ ...content, active: true })
  await profileStore.activate(id)
  await conflictStore.markMerged(conflictId, `权重草稿另存为新方案「${content.name}」并启用`)
  ElMessage.success(`已另存为「${content.name}」并启用`)
}

function profileNameOf(id: number | null): string {
  return profileStore.byId(id)?.name ?? (id == null ? '待选择' : `方案 #${id}`)
}

/* --------------------------- 多轮因子复核录入 --------------------------- */
const showFactorForm = ref(false)
const factorForm = reactive({
  waterDistance: 60,
  windDir: '东南' as WindDir,
  windForce: 1 as WindForce,
  signalBars: 4,
  sunHours: 5,
  rockfallRisk: '无' as RockfallRisk,
  shade: 35,
  distanceToCar: 40,
  distanceToTrail: 50,
  assessor: '',
  assessedAt: todayIso()
})

function prefillFactor(): void {
  const latest = siteStore.latestFactor(siteId.value)
  if (latest) {
    factorForm.waterDistance = latest.waterDistance
    factorForm.windDir = latest.windDir
    factorForm.windForce = latest.windForce
    factorForm.signalBars = latest.signalBars
    factorForm.sunHours = latest.sunHours
    factorForm.rockfallRisk = latest.rockfallRisk
    factorForm.shade = latest.shade
    factorForm.distanceToCar = latest.distanceToCar
    factorForm.distanceToTrail = latest.distanceToTrail
    factorForm.assessor = latest.assessor
  }
  factorForm.assessedAt = todayIso()
}

async function submitFactor(): Promise<void> {
  if (!site.value) return
  try {
    await siteStore.addFactor({
      siteId: siteId.value,
      waterDistance: Number(factorForm.waterDistance),
      windDir: factorForm.windDir,
      windForce: factorForm.windForce,
      signalBars: Number(factorForm.signalBars),
      sunHours: Number(factorForm.sunHours),
      rockfallRisk: factorForm.rockfallRisk,
      shade: Number(factorForm.shade),
      distanceToCar: Number(factorForm.distanceToCar),
      distanceToTrail: Number(factorForm.distanceToTrail),
      assessor: factorForm.assessor.trim() || '未署名',
      assessedAt: factorForm.assessedAt || todayIso(),
      createdAt: '',
      updatedAt: ''
    })
    showFactorForm.value = false
    ElMessage.success('已追加一轮因子评估，名次与等级同步刷新')
  } catch (err) {
    ElMessage.error(`追加失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function removeFactor(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  try {
    await ElMessageBox.confirm('确认删除这一轮因子评估？删除后名次会立即重算。', '提示', {
      type: 'warning'
    })
    await siteStore.removeFactor(id)
    ElMessage.success('已删除该轮评估')
  } catch {
    /* 用户取消 */
  }
}

/* ------------------------------ 否决记录 ------------------------------ */
const vetoForm = reactive({
  type: '山洪沟' as VetoType,
  description: '',
  judge: '',
  judgedAt: todayIso()
})

async function addVetoHere(): Promise<void> {
  if (!site.value) return
  if (!vetoForm.description.trim()) {
    ElMessage.warning('请填写否决说明')
    return
  }
  await uiStore.addVeto({
    siteId: siteId.value,
    type: vetoForm.type,
    description: vetoForm.description.trim(),
    judge: vetoForm.judge.trim() || '未署名',
    judgedAt: vetoForm.judgedAt || todayIso(),
    createdAt: '',
    updatedAt: ''
  })
  vetoForm.description = ''
  ElMessage.success('已登记否决项，该营位在名次表与地图上标红且禁止评 A')
}

async function removeVeto(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  await uiStore.removeVeto(id)
  ElMessage.success('已解除该否决项')
}

/* ------------------------------ 基本信息编辑 ------------------------------ */
const editing = ref(false)
const editForm = reactive({
  name: '',
  campName: '',
  elevation: 0,
  slope: 0,
  aspect: '东南' as AspectType,
  surface: '草地' as SurfaceType,
  tentCapacity: 1,
  flatness: 80,
  access: '车行' as AccessMode,
  note: ''
})

function startEdit(): void {
  const s = site.value
  if (!s) return
  editForm.name = s.name
  editForm.campName = s.campName
  editForm.elevation = s.elevation
  editForm.slope = s.slope
  editForm.aspect = s.aspect
  editForm.surface = s.surface
  editForm.tentCapacity = s.tentCapacity
  editForm.flatness = s.flatness
  editForm.access = s.access
  editForm.note = s.note
  editing.value = true
}

async function saveEdit(): Promise<void> {
  if (!site.value) return
  await siteStore.updateSite(siteId.value, {
    name: editForm.name.trim() || site.value.name,
    campName: editForm.campName.trim() || site.value.campName,
    elevation: Number(editForm.elevation),
    slope: Number(editForm.slope),
    aspect: editForm.aspect,
    surface: editForm.surface,
    tentCapacity: Number(editForm.tentCapacity),
    flatness: Number(editForm.flatness),
    access: editForm.access,
    note: editForm.note.trim()
  })
  editing.value = false
  ElMessage.success('营位基础信息已更新')
}

/** 因子明细行，附带原始值与权重信息 */
const factorRows = computed(() => {
  const row = scoreRow.value
  if (!row) return []
  return row.rows.map((r) => ({ ...r, higherIsBetter: metaOf(r.key)?.higherIsBetter ?? true }))
})

function metaOf(key: string) {
  return FACTOR_META.find((m) => m.key === key)
}

watch(
  () => route.params.id,
  () => {
    showFactorForm.value = false
    editing.value = false
    prefillFactor()
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="site" class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>{{ site.code }} · {{ site.name }}</h1>
        <p>
          {{ site.campName }} · {{ site.surface }} · 容 {{ site.tentCapacity }} 帐 ·
          {{ site.access }} · 海拔 {{ site.elevation }} m
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
        <el-button @click="router.push('/map')">地图视图</el-button>
        <el-button type="primary" @click="startEdit">编辑基础信息</el-button>
      </div>
    </div>

    <el-alert
      v-if="vetoList.length"
      type="error"
      show-icon
      :closable="false"
      title="该营位命中风险否决项，综合等级已被压到 C 级（禁止评 A）"
      :description="vetoList.map((v) => `${v.type}：${v.description}`).join(' ｜ ')"
    />

    <el-alert
      v-if="assignment.pending"
      type="warning"
      show-icon
      :closable="false"
      class="detail-alert"
      title="该营位处于「待选择」：未指定评分方案或所引方案已停用/移除"
      description="此状态下不参与名次与等级计算，也不会自动换回别的方案；请在下方显式指定一个方案后重算。"
    />
    <el-alert
      v-else-if="assignment.stale"
      type="info"
      show-icon
      :closable="false"
      class="detail-alert"
      title="指定方案内容被调整过，该营位的名次已按最新版本失效重算"
      description="变化明细见页面底部的并发改动记录。"
    />

    <MapPanel
      :sites="siteStore.list"
      :selected-id="siteId"
      :grade-of="gradeOfSite"
      height="360px"
      :title="`营位定位 · ${site.code}`"
      @select="openSite"
    />

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">综合得分</div>
        <div class="stat-card__value">{{ assignment.pending ? '待选择' : (scoreRow?.total ?? '—') }}</div>
        <div class="stat-card__extra">
          方案 {{ assignment.profile?.name ?? '—' }}
          <template v-if="!assignment.pending"> · v{{ assignment.profile?.version }}</template>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">推荐等级</div>
        <div class="stat-card__value">
          <GradeBadge
            v-if="!assignment.pending"
            :grade="grade"
            size="large"
            :vetoed="vetoList.length > 0"
          />
          <el-tag v-else type="warning" size="large">待选择</el-tag>
        </div>
        <div class="stat-card__extra">
          {{ assignment.pending ? '指定方案后参与排名' : `名次第 ${scoreRow?.rank ?? '—'} 位` }}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">坐标</div>
        <div class="stat-card__value coord">{{ formatLng(site.lng) }}</div>
        <div class="stat-card__extra">{{ formatLat(site.lat) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">评估轮次</div>
        <div class="stat-card__value">{{ factorHistory.length }}</div>
        <div class="stat-card__extra">否决项 {{ vetoList.length }} 条</div>
      </div>
    </div>

    <section class="panel">
      <div class="panel__head">
        <h2>评分方案指定</h2>
        <span class="weight-note">该营位按指定方案评分；方案停用或移除后转入待选择，不会被悄悄换方案</span>
      </div>
      <ProfileAssignmentPanel :site="site" @conflict="openConflict" />
    </section>

    <section v-if="editing" class="panel">
      <div class="panel__head">
        <h2>编辑基础信息</h2>
      </div>
      <el-form label-width="112px" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="营位名称">
            <el-input id="edit-name" v-model="editForm.name" />
          </el-form-item>
          <el-form-item label="所属营地">
            <el-input id="edit-camp" v-model="editForm.campName" />
          </el-form-item>
          <el-form-item label="海拔（m）">
            <el-input-number
              id="edit-elevation"
              v-model="editForm.elevation"
              :min="0"
              :max="6000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="坡度（°）">
            <el-input-number
              id="edit-slope"
              v-model="editForm.slope"
              :min="0"
              :max="45"
              :step="0.1"
              :precision="1"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="坡向">
            <el-select id="edit-aspect" v-model="editForm.aspect" style="width: 100%">
              <el-option v-for="a in ASPECT_TYPES" :key="a" :label="a" :value="a" />
            </el-select>
          </el-form-item>
          <el-form-item label="地表类型">
            <el-select id="edit-surface" v-model="editForm.surface" style="width: 100%">
              <el-option v-for="s in SURFACE_TYPES" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="可容帐篷数">
            <el-input-number
              id="edit-capacity"
              v-model="editForm.tentCapacity"
              :min="1"
              :max="60"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="平整度评分">
            <el-input-number
              id="edit-flatness"
              v-model="editForm.flatness"
              :min="0"
              :max="100"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="进出方式">
            <el-radio-group v-model="editForm.access">
              <el-radio v-for="a in ACCESS_MODES" :key="a" :value="a">{{ a }}</el-radio>
            </el-radio-group>
          </el-form-item>
        </div>
        <el-form-item label="备注">
          <el-input v-model="editForm.note" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="saveEdit">保存</el-button>
          <el-button @click="editing = false">取消</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>因子打分表</h2>
        <span class="weight-note">
          <template v-if="scoreRow">
            方案：{{ scoreRow.profile.name }}（v{{ scoreRow.profile.version }}） ·
            归一方式：{{ NORMALIZE_LABELS[scoreRow.profile.normalize] }}
            · 等级阈值 A ≥ {{ scoreRow.profile.thresholds.gradeA }} / B ≥
            {{ scoreRow.profile.thresholds.gradeB }}
            <el-tag v-if="scoreRow.stale" type="warning" size="small" class="ml6">方案改动后已重算</el-tag>
          </template>
          <template v-else>该营位待选择方案，指定方案后显示评分明细</template>
        </span>
      </div>
      <div v-if="scoreRow" class="factor-grid">
        <FactorScoreBar
          v-for="row in factorRows"
          :key="row.key"
          :factor-key="row.key"
          :label="row.label"
          :raw="row.raw"
          :normalized="row.normalized"
          :weight="row.weight"
          :weight-ratio="row.weightRatio"
          :higher-is-better="row.higherIsBetter"
          :contribution="row.contribution"
        />
      </div>
      <p v-if="scoreRow" class="panel__hint">
        当前名次所用因子来自最新一轮评估（{{ siteStore.latestFactor(siteId)?.assessedAt ?? '暂无' }}，
        评估人 {{ siteStore.latestFactor(siteId)?.assessor ?? '—' }}）。
      </p>
      <p v-else class="panel__hint">该营位未参与评分：请先在上方「评分方案指定」中选择一个有效方案。</p>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>多轮因子复核</h2>
        <el-button
          size="small"
          type="primary"
          plain
          @click="
            () => {
              prefillFactor()
              showFactorForm = !showFactorForm
            }
          "
        >
          {{ showFactorForm ? '收起录入' : '追加一轮评估' }}
        </el-button>
      </div>

      <el-form v-if="showFactorForm" label-width="112px" class="review-form" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="水源距离（m）">
            <el-input-number
              id="review-water"
              v-model="factorForm.waterDistance"
              :min="0"
              :max="5000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="风向">
            <el-select id="review-windDir" v-model="factorForm.windDir" style="width: 100%">
              <el-option v-for="d in WIND_DIRS" :key="d" :label="d" :value="d" />
            </el-select>
          </el-form-item>
          <el-form-item label="风力等级">
            <el-select id="review-windForce" v-model="factorForm.windForce" style="width: 100%">
              <el-option v-for="f in WIND_FORCES" :key="f" :label="`${f} 级`" :value="f" />
            </el-select>
          </el-form-item>
          <el-form-item label="信号强度（格）">
            <el-input-number
              id="review-signal"
              v-model="factorForm.signalBars"
              :min="0"
              :max="5"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="日照时长（h）">
            <el-input-number
              id="review-sun"
              v-model="factorForm.sunHours"
              :min="0"
              :max="14"
              :step="0.1"
              :precision="1"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="落石落枝风险">
            <el-select id="review-rockfall" v-model="factorForm.rockfallRisk" style="width: 100%">
              <el-option v-for="r in ROCKFALL_RISKS" :key="r" :label="r" :value="r" />
            </el-select>
          </el-form-item>
          <el-form-item label="植被遮蔽度">
            <el-input-number
              id="review-shade"
              v-model="factorForm.shade"
              :min="0"
              :max="100"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="离车距离（m）">
            <el-input-number
              id="review-car"
              v-model="factorForm.distanceToCar"
              :min="0"
              :max="5000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="离步道（m）">
            <el-input-number
              id="review-trail"
              v-model="factorForm.distanceToTrail"
              :min="0"
              :max="5000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="评估人">
            <el-input id="review-assessor" v-model="factorForm.assessor" />
          </el-form-item>
          <el-form-item label="评估日期">
            <el-date-picker
              id="review-date"
              v-model="factorForm.assessedAt"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <el-form-item>
          <el-button type="primary" @click="submitFactor">提交本轮评估</el-button>
        </el-form-item>
      </el-form>

      <el-table v-if="factorHistory.length" :data="factorHistory" size="small" border>
        <el-table-column label="序号" width="64" type="index" />
        <el-table-column prop="assessedAt" label="评估日期" width="118">
          <template #default="{ row }">{{ formatDate(row.assessedAt) }}</template>
        </el-table-column>
        <el-table-column prop="assessor" label="评估人" width="110" />
        <el-table-column label="水源" width="90">
          <template #default="{ row }">{{ row.waterDistance }} m</template>
        </el-table-column>
        <el-table-column label="风向 / 风力" width="130">
          <template #default="{ row }">{{ row.windDir }} {{ row.windForce }} 级</template>
        </el-table-column>
        <el-table-column label="信号" width="80">
          <template #default="{ row }">{{ row.signalBars }} 格</template>
        </el-table-column>
        <el-table-column label="日照" width="86">
          <template #default="{ row }">{{ row.sunHours }} h</template>
        </el-table-column>
        <el-table-column label="落石落枝" width="100">
          <template #default="{ row }">{{ row.rockfallRisk }}</template>
        </el-table-column>
        <el-table-column label="遮蔽度" width="88">
          <template #default="{ row }">{{ row.shade }}</template>
        </el-table-column>
        <el-table-column label="离车 / 离步道" width="140">
          <template #default="{ row }">{{ row.distanceToCar }} / {{ row.distanceToTrail }} m</template>
        </el-table-column>
        <el-table-column label="录入时间" width="150">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="danger" @click="removeFactor(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="panel__hint">暂无因子评估记录，点击「追加一轮评估」开始录入。</p>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>风险否决记录</h2>
        <span class="weight-note">命中任一条即整行标红并禁止评 A</span>
      </div>

      <el-table v-if="vetoList.length" :data="vetoList" size="small" border>
        <el-table-column prop="type" label="否决类型" width="130">
          <template #default="{ row }">
            <el-tag type="danger" size="small">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="260" />
        <el-table-column prop="judge" label="判定人" width="110" />
        <el-table-column label="判定日期" width="120">
          <template #default="{ row }">{{ formatDate(row.judgedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="danger" @click="removeVeto(row.id)">解除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="panel__hint">该营位暂无否决记录，可在下方直接登记。</p>

      <el-divider content-position="left">登记新的否决项</el-divider>
      <el-form label-width="100px" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="否决类型">
            <el-select id="veto-type" v-model="vetoForm.type" style="width: 100%">
              <el-option v-for="t in VETO_TYPES" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
          <el-form-item label="判定人">
            <el-input id="veto-judge" v-model="vetoForm.judge" placeholder="如 周勘" />
          </el-form-item>
          <el-form-item label="判定日期">
            <el-date-picker
              id="veto-date"
              v-model="vetoForm.judgedAt"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <el-form-item label="说明">
          <el-input
            id="veto-desc"
            v-model="vetoForm.description"
            type="textarea"
            :rows="2"
            :placeholder="VETO_HINTS[vetoForm.type]"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="danger" plain @click="addVetoHere">登记否决项</el-button>
        </el-form-item>
      </el-form>
    </section>

    <ConflictHistory
      :conflicts="siteConflicts"
      title="本营位的并发改动与重算记录"
      :show-site="false"
      @resolve="(c) => openConflict(c.id as number)"
    />

    <ConflictResolveDialog
      v-model="dialogVisible"
      :conflict="activeConflict"
      :profile-name-of="profileNameOf"
      @merge-profile="(c, merged) => onMergeProfile(c.id as number, merged)"
      @merge-site="(c, pid) => onMergeSite(c.id as number, pid)"
      @discard="(c) => onDiscardConflict(c.id as number)"
      @save-as-new="(c, content) => onSaveAsNew(c.id as number, content)"
    />
  </div>

  <div v-else class="page">
    <section class="panel">
      <EmptyState
        title="没有找到这个营位"
        description="该营位可能已被删除，或链接中的编号不正确。返回名次表查看全部候选营位，或直接新增一个。"
        action-text="新增营位"
        @action="router.push('/sites/new')"
      />
    </section>
  </div>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 0 18px;
}
.factor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 8px;
}
.coord {
  font-size: 15px;
}
.review-form {
  margin-bottom: 12px;
}
.detail-alert {
  margin-bottom: 12px;
}
.ml6 {
  margin-left: 6px;
}
</style>
