<script setup lang="ts">
/**
 * `/` 营位名次表 —— 按每个营位「指定的权重方案」加权评分并降序排列；
 * 未指定 / 方案停用或移除的营位进入「待选择」区，不参与排名、不悄悄换方案；
 * 方案改动后已重算的营位与名次行给出标记；页面底部保留并发改动与重算记录。
 * 消费 Campsite、FactorAssessment、RiskVeto、ChangeConflict；复用 <GradeBadge>、<EmptyState>。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useConflictStore } from '@/stores/conflictStore'
import { useRanking } from '@/hooks/useRanking'
import { FACTOR_META } from '@/types/score'
import { SURFACE_TYPES, ACCESS_MODES } from '@/types/campsite'
import GradeBadge from '@/components/common/GradeBadge.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ProfileAssignmentPanel from '@/components/common/ProfileAssignmentPanel.vue'
import ConflictHistory from '@/components/common/ConflictHistory.vue'
import ConflictResolveDialog from '@/components/common/ConflictResolveDialog.vue'
import { formatScore } from '@/utils/format'
import { NORMALIZE_LABELS } from '@/types/score'
import type { ChangeConflict } from '@/types/conflict'
import type { ProfileContent } from '@/utils/conflict'

const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()
const conflictStore = useConflictStore()

const inputSites = computed(() =>
  siteStore.list.filter((site) => {
    if (uiStore.filterCamp && site.campName !== uiStore.filterCamp) return false
    if (uiStore.filterSurface && site.surface !== uiStore.filterSurface) return false
    if (uiStore.filterAccess && site.access !== uiStore.filterAccess) return false
    const kw = uiStore.keyword.trim()
    if (kw) {
      const hay = `${site.code} ${site.name} ${site.campName} ${site.note}`
      if (!hay.includes(kw)) return false
    }
    return true
  })
)

const { ranked, pending } = useRanking({
  sites: () => inputSites.value,
  factorOf: (siteId: number) => siteStore.latestFactor(siteId),
  assignmentOf: (site) => profileStore.assignmentOf(site),
  vetoedIds: () => uiStore.vetoedSiteIds
})

const factorMetaOf = (key: string) => FACTOR_META.find((m) => m.key === key)

/** 从某行的因子明细里取某一项的归一化得分，供表格单元格内联展示 */
function normalizedOf(
  row: { rows: Array<{ key: string; normalized: number }> },
  key: string
): number | string {
  return row.rows.find((r) => r.key === key)?.normalized ?? '—'
}

/** 命中否决项的营位整行标红；方案改动后重算的行追加提示样式 */
function rowClass({ row }: { row: { vetoed: boolean; stale: boolean } }): string {
  if (row.vetoed) return 'veto-row'
  return row.stale ? 'stale-row' : ''
}

const stats = computed(() => {
  const rows = ranked.value
  return {
    total: rows.length,
    gradeA: rows.filter((r) => r.grade === 'A').length,
    vetoed: rows.filter((r) => r.vetoed).length,
    top: rows[0]?.total ?? 0,
    topName: rows[0] ? `${rows[0].site.code} ${rows[0].site.name}` : '—'
  }
})

const activeProfileName = computed(() => profileStore.activeProfile?.name ?? '无启用方案')

const pendingInScope = computed(() => pending.value)

const siteConflicts = computed(() =>
  // 与营位相关的记录（停用/移除/重算/营位冲突）都带 siteId；
  // 方案保存冲突没有具体营位，但名次表作为总览页也需要能处理，故一并展示。
  conflictStore.list.filter((c) => typeof c.siteId === 'number' || c.resource === 'profile')
)

/** 名次表上的待合并冲突（含方案类，供直接打开合并） */
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

async function onMergeProfile(conflict: ChangeConflict, merged: ProfileContent): Promise<void> {
  const id = typeof conflict.id === 'number' ? conflict.id : -1
  const result = await profileStore.resolveProfileConflict(id, merged)
  if (result.ok) {
    ElMessage.success('双方权重调整已合并并启用，受影响营位已统一重算')
  } else if (result.missing) {
    ElMessage.warning('原方案已停用或移除，请改用「另存为新方案」')
  }
}

async function onMergeSite(conflict: ChangeConflict, profileId: number | null): Promise<void> {
  if (typeof conflict.id !== 'number') return
  await siteStore.resolveAssignmentConflict(conflict.id, profileId)
  ElMessage.success('营位指定已合并，名次已按最新方案重算')
}

async function onDiscard(conflict: ChangeConflict): Promise<void> {
  if (typeof conflict.id !== 'number') return
  await conflictStore.markMerged(conflict.id, '已放弃本地草稿，保留先保存的一方')
  ElMessage.info('已放弃本地草稿')
}

async function onSaveAsNew(conflict: ChangeConflict, content: ProfileContent): Promise<void> {
  const id = await profileStore.createProfile({
    ...content,
    active: true
  })
  await profileStore.activate(id)
  if (typeof conflict.id === 'number') {
    await conflictStore.markMerged(conflict.id, `权重草稿已另存为新方案「${content.name}」并启用`)
  }
  ElMessage.success(`已另存为新方案「${content.name}」并启用；引用旧方案的营位仍需重新指定`)
}

function profileNameOf(id: number | null): string {
  return profileStore.byId(id)?.name ?? (id == null ? '待选择' : `方案 #${id}`)
}

function openDetail(siteId: number | undefined): void {
  if (typeof siteId !== 'number') return
  void router.push(`/sites/${siteId}`)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>营位名次表</h1>
        <p>
          按当前权重方案对全部候选营位加权求和后降序排列，实时给出 A/B/C 推荐等级；
          命中风险否决项的营位整行标红并自动降为 C 级。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/scoring')">调权重</el-button>
        <el-button @click="router.push('/map')">看地图</el-button>
        <el-button type="primary" @click="router.push('/sites/new')">新增营位</el-button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">参与排名</div>
        <div class="stat-card__value" data-testid="stat-total">{{ stats.total }}</div>
        <div class="stat-card__extra">共 {{ siteStore.total }} 个已登记 · {{ pendingInScope.length }} 个待选择</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">A 级推荐</div>
        <div class="stat-card__value">{{ stats.gradeA }}</div>
        <div class="stat-card__extra">阈值来自各营位指定方案</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">命中否决</div>
        <div class="stat-card__value" :style="{ color: stats.vetoed ? '#b91c1c' : undefined }">
          {{ stats.vetoed }}
        </div>
        <div class="stat-card__extra">否决后禁止评 A</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">待合并改动</div>
        <div class="stat-card__value" :style="{ color: conflictStore.openCount ? '#b91c1c' : undefined }">
          {{ conflictStore.openCount }}
        </div>
        <div class="stat-card__extra">合并后统一启用重算</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">最高综合得分</div>
        <div class="stat-card__value">{{ formatScore(stats.top) }}</div>
        <div class="stat-card__extra">{{ stats.topName }}</div>
      </div>
    </div>

    <el-alert
      v-if="pendingInScope.length"
      type="warning"
      :closable="false"
      show-icon
      class="pending-alert"
      :title="`${pendingInScope.length} 个营位处于「待选择」：未指定方案或所引方案已停用/移除，不参与名次，也未自动换用其它方案`"
    />

    <el-alert
      v-if="ranked.some((r) => r.stale)"
      type="info"
      :closable="false"
      show-icon
      class="pending-alert"
      title="部分营位的指定方案内容被调整过，相关名次已失效并按最新方案重算（行内有「已重算」标记，记录见页面底部）"
    />

    <section class="panel">
      <div class="panel__head">
        <h2>筛选条件</h2>
        <span class="weight-note">
          全局启用方案：{{ activeProfileName }} · 各营位按其指定方案评分
        </span>
      </div>
      <div class="filters">
        <el-select v-model="uiStore.filterCamp" placeholder="全部营地" clearable style="width: 190px">
          <el-option v-for="c in siteStore.camps" :key="c" :label="c" :value="c" />
        </el-select>
        <el-select
          v-model="uiStore.filterSurface"
          placeholder="全部地表类型"
          clearable
          style="width: 170px"
        >
          <el-option v-for="s in SURFACE_TYPES" :key="s" :label="s" :value="s" />
        </el-select>
        <el-select
          v-model="uiStore.filterAccess"
          placeholder="全部进出方式"
          clearable
          style="width: 170px"
        >
          <el-option v-for="a in ACCESS_MODES" :key="a" :label="a" :value="a" />
        </el-select>
        <el-input
          v-model="uiStore.keyword"
          placeholder="搜索编号 / 名称 / 备注"
          clearable
          style="width: 230px"
        />
        <el-button text @click="uiStore.resetFilters()">清空筛选</el-button>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>名次与得分</h2>
        <span class="weight-note">共 {{ ranked.length }} 行</span>
      </div>

      <el-table
        v-if="ranked.length"
        data-testid="ranking-table"
        :data="ranked"
        :row-class-name="rowClass"
        size="default"
        border
        stripe
      >
        <el-table-column label="名次" width="76" align="center">
          <template #default="{ row }">
            <span class="rank-no" :class="{ 'rank-no--top': row.rank <= 3 }">{{ row.rank }}</span>
          </template>
        </el-table-column>
        <el-table-column label="营位" min-width="210">
          <template #default="{ row }">
            <div class="site-cell">
              <el-link type="primary" underline="never" @click="openDetail(row.site.id)">
                {{ row.site.code }} · {{ row.site.name }}
              </el-link>
              <span class="site-cell__sub">
                {{ row.site.campName }} · 海拔 {{ row.site.elevation }} m · 容 {{ row.site.tentCapacity }} 帐
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="评分方案" width="170">
          <template #default="{ row }">
            <span class="profile-name">{{ row.profile.name }}</span>
            <el-tag v-if="row.stale" type="warning" size="small" class="ml6">已重算</el-tag>
            <div class="cell-sub">
              {{ NORMALIZE_LABELS[row.profile.normalize as 'minmax' | 'threshold'] }} · v{{ row.profile.version }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="地表 / 进出" width="130">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.site.surface }}</el-tag>
            <el-tag size="small" effect="plain" type="info" class="ml6">{{ row.site.access }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="坡度" width="92" align="right">
          <template #default="{ row }">
            {{ row.raw.slope.toFixed(1) }}°
            <div class="cell-sub">归一 {{ normalizedOf(row, 'slope') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="水源距离" width="104" align="right">
          <template #default="{ row }">
            {{ row.raw.waterDistance }} m
            <div class="cell-sub">归一 {{ normalizedOf(row, 'waterDistance') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="信号" width="92" align="right">
          <template #default="{ row }">
            {{ row.raw.signal }} 格
            <div class="cell-sub">归一 {{ normalizedOf(row, 'signal') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="风力" width="88" align="right">
          <template #default="{ row }">
            {{ row.raw.wind }} 级
            <div class="cell-sub">{{ siteStore.latestFactor(row.siteId)?.windDir ?? '—' }}向</div>
          </template>
        </el-table-column>
        <el-table-column label="日照" width="86" align="right">
          <template #default="{ row }">{{ row.raw.sun.toFixed(1) }} h</template>
        </el-table-column>
        <el-table-column label="综合得分" width="104" align="right">
          <template #default="{ row }">
            <strong class="total-score">{{ formatScore(row.total) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="等级" width="210">
          <template #default="{ row }">
            <GradeBadge :grade="row.grade" :score="row.total" :vetoed="row.vetoed" />
          </template>
        </el-table-column>
        <el-table-column label="否决项" min-width="180">
          <template #default="{ row }">
            <template v-if="row.vetoed">
              <el-tag v-for="v in uiStore.vetosOf(row.siteId)" :key="v.id" type="danger" size="small" class="mr6">
                {{ v.type }}
              </el-tag>
            </template>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="132" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openDetail(row.site.id)">详情</el-button>
            <el-button size="small" text @click="router.push('/veto')">登记否决</el-button>
          </template>
        </el-table-column>
      </el-table>

      <EmptyState
        v-else
        title="还没有可评估的营位"
        description="先登记候选营位并录入因子（坡度、水源距离、信号、日照等），名次表会自动按得分排序并给出 A/B/C 等级。"
        action-text="新增营位"
        :hint="`因子维度共 ${FACTOR_META.length} 项，全部可在评分页调整权重`"
        @action="router.push('/sites/new')"
      />
    </section>

    <section v-if="pendingInScope.length" class="panel">
      <div class="panel__head">
        <h2>待选择方案的营位（{{ pendingInScope.length }}）</h2>
        <span class="weight-note">不参与名次与等级；方案停用/移除后不会被悄悄换成别的方案</span>
      </div>
      <el-table :data="pendingInScope" size="small" border>
        <el-table-column label="营位" min-width="220">
          <template #default="{ row }">
            <el-link type="primary" underline="never" @click="openDetail(row.site.id)">
              {{ row.site.code }} · {{ row.site.name }}
            </el-link>
            <div class="cell-sub">{{ row.site.campName }}</div>
          </template>
        </el-table-column>
        <el-table-column label="当前状态" min-width="360">
          <template #default="{ row }">
            <ProfileAssignmentPanel :site="row.site" compact />
          </template>
        </el-table-column>
      </el-table>
    </section>

    <ConflictHistory
      :conflicts="siteConflicts"
      :limit="30"
      @resolve="(c) => openConflict(c.id as number)"
    />

    <ConflictResolveDialog
      v-model="dialogVisible"
      :conflict="activeConflict"
      :profile-name-of="profileNameOf"
      @merge-profile="onMergeProfile"
      @merge-site="onMergeSite"
      @discard="onDiscard"
      @save-as-new="onSaveAsNew"
    />
  </div>
</template>

<style scoped>
.rank-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--gb-surface);
  color: var(--gb-muted);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.rank-no--top {
  background: #e6f4ea;
  color: var(--gb-accent-strong);
}
.site-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.site-cell__sub {
  font-size: 11px;
  color: var(--gb-muted);
}
.cell-sub {
  font-size: 11px;
  color: var(--gb-muted);
}
.total-score {
  font-size: 15px;
  color: var(--gb-accent-strong);
  font-variant-numeric: tabular-nums;
}
.ml6 {
  margin-left: 6px;
}
.mr6 {
  margin-right: 6px;
}
.pending-alert {
  margin-bottom: 14px;
}
.profile-name {
  font-weight: 600;
  font-size: 13px;
}
:deep(.stale-row) {
  background-color: #fdf6ec !important;
}
</style>
