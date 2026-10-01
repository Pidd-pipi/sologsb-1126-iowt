# 露营营地选址评估器（gbcampsite）

面向营地规划者与户外领队：把候选营位的地形、补给与隐患折算成综合得分。地图选点登记营位，录入坡度、水源距离、风向、信号等因子，配置权重后实时重排名次并给出 A/B/C 等级。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21826>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21826 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`siteStore` / `profileStore` / `uiStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`），未配置时自动降级为本地 SVG 网格视图 |
| 本地数据 | IndexedDB（Dexie，`gbcampsite-db`，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Campsite 营位 | `frontend/src/types/campsite.ts` | 营位编号、名称、所属营地、经纬度、海拔、坡度、坡向、地表类型、可容帐篷数、平整度评分、进出方式、**指定权重方案（defaultProfileId）+ 指定时方案版本快照（assignedProfileVersion）+ 待选择原因（pendingReason）** |
| FactorAssessment 因子评估 | `frontend/src/types/factor.ts` | 所属营位、水源距离、风向与风力等级、信号强度、日照时长、落石落枝风险、植被遮蔽度、离车距离、离步道距离、评估人、评估日期 |
| ScoreProfile 权重方案 | `frontend/src/types/score.ts` | 方案名、各因子权重（0-100）、归一化方式（极差归一 / 阈值分段）、A/B/C 等级阈值、适用季节、是否启用、**乐观锁版本号 version、停用时间 retiredAt** |
| RiskVeto 风险否决项 | `frontend/src/types/veto.ts` | 营位 id、否决类型（河道内 / 山洪沟 / 孤树下 / 崖底落石区 / 陡坡）、说明、判定人、判定日期 |
| ChangeConflict 并发改动记录 | `frontend/src/types/conflict.ts` | 保存冲突 / 方案停用 / 方案移除 / 方案改动失效重算记录；open 冲突保留 base（共同旧值）、current（对方已保存）、incoming（本地草稿）三份快照与逐字段合并结果 |

### 并发编辑的版本核对（乐观锁）

规划员改权重、领队同时保存营位指定时，双方都不会被后保存静默顶掉：

- **权重方案**内容字段（权重、归一方式、阈值、名称、季节、备注）每保存或合并一次 `version +1`（启用/停用不改版本）。「保存修改到当前方案」带上编辑时的版本，版本对不上即拒绝写入，落一条 **待合并** 冲突并保留双方草稿；`ConflictResolveDialog` 逐字段列出「原值 / 对方已保存 / 我的草稿」，双方都改的字段二选一，只有一方改的自动采用，**合并后才统一写入、启用并对受影响营位重算**。方案已被停用/移除时，草稿可另存为新方案。
- **营位指定**保存时同时核对「营位 updatedAt」与「打开面板时所选方案的版本」，任一变化同样保留双方选择并走合并。
- 多标签页之间通过 `utils/syncBus.ts`（BroadcastChannel + localStorage storage 事件）在写库后互推刷新，保证版本核对基于最新数据。
- **方案停用或移除**：引用它的营位转入「待选择」（停用保留方案 id 与名称、移除保留最后指向并标记 `removed`），**绝不悄悄换回别的方案**，必须在名次表或营位详情显式重新指定；待选择营位不参与名次与等级，地图上显示灰色「待」标记。
- **方案内容改动**：引用营位的名次实时失效重算（按方案分组极差归一），行内带「已重算」标记，并逐营位落 `profile-changed` 记录；重新保存一次指定即确认新版本。
- 名次表底部保留与营位相关的全部记录，营位详情保留该营位的记录（含已处理历史）。

### IndexedDB 版本与升级迁移

库名 `gbcampsite-db`（Dexie），共 5 张表：`sites`、`factors`、`profiles`、`vetos`、`conflicts`。

- **v1**：建立 `sites`（营位）与 `factors`（因子评估）两张表。
- **v2**：新增 `profiles`（权重方案）表，并为 `factors` 补 `siteId` 索引，让「按营位取因子」走索引；同时为存量因子补齐 `shade`、`distanceToCar`、`distanceToTrail` 缺省值。
- **v3**：新增 `vetos`（风险否决）表，并为存量营位回填 `defaultProfileId`（取当前启用方案的 id）与新增字段缺省值。
- **v4**：新增 `conflicts`（并发改动/失效重算记录）表；为 `profiles` 补乐观锁 `version` 与停用时间 `retiredAt`，为 `sites` 补 `assignedProfileVersion`（对齐所指方案版本）与 `pendingReason`，存量数据默认版本 1、无待选择原因。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 营位名次表（按综合得分降序，展示坡度、水源距离、信号与等级，可按营地/地表/进出方式筛选，命中否决项整行标红） | Campsite、FactorAssessment、RiskVeto |
| `/sites/new` | 新增营位（地图点选或手填经纬度，录入海拔、坡度、坡向与容量，支持草稿保存） | Campsite、FactorAssessment |
| `/sites/:id` | 营位详情（上部地图定位与基本信息，中部因子打分表，下部否决记录与多轮复核） | 四个模型 |
| `/scoring` | 权重与评分（拖动各因子权重条，名次实时刷新；「保存修改到当前方案」走版本核对，冲突时三方合并后启用重算；可另存季节方案、停用/移除方案） | ScoreProfile、Campsite、ChangeConflict |
| `/map` | 营位地图（高德 JS API 标记按等级着色，未配置 `VITE_AMAP_KEY` 时退化为本地 SVG 网格视图） | Campsite、RiskVeto |
| `/veto` | 风险否决登记（选营位与否决类型、填说明，提交后名次表与地图同步更新） | RiskVeto、Campsite |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `MapPanel.vue`（高德 + SVG 网格双模式，待选择营位灰色「待」标记）、`FactorScoreBar.vue`（原始值 / 归一化得分 / 权重占比）、`GradeBadge.vue`（A/B/C 等级与得分气泡）、`EmptyState.vue`（空态与新建入口）、`WeightEditor.vue`（权重条编辑器）、`ProfileAssignmentPanel.vue`（营位指定方案 + 版本核对保存）、`ConflictResolveDialog.vue`（三方变化对比与逐字段合并）、`ConflictHistory.vue`（并发改动与重算记录）
- hooks：`frontend/src/hooks/useAmapLoader.ts`（按需注入高德 JS API，key 缺省或加载失败返回降级标记）、`useRanking.ts`（按营位各自指定方案分组归一化得分与名次，输出待选择营位）、`useLocalDraft.ts`（表单草稿）
- utils：`frontend/src/utils/score.ts`（极差归一、阈值分段、加权求和、等级阈值、否决短路）、`geo.ts`（经纬度距离与网格坐标换算）、`format.ts`（数值与日期格式化、流水编号）、`db.ts`（Dexie 封装、v1-v4 迁移与样例数据）、`draft.ts`（localStorage 草稿）、`conflict.ts`（方案快照摊平、逐字段 diff、合并补丁还原）、`syncBus.ts`（多标签页写库通知）

## 六、地图降级说明

`VITE_AMAP_KEY` 为空时，`useAmapLoader()` **不会**请求 `webapi.amap.com`，而是立即返回降级标记；
`MapPanel` 随即渲染本地 SVG 网格视图（可点选、可查看详情），因此**构建与运行都不依赖该 key**。
若配置了 key，则注入脚本时带 `onerror` 与 8 秒超时双兜底，失败同样降级，不会产生 console error。

## 七、目录结构

```
sologsb-1126/
├── docker-compose.yml
├── .env / .env.example
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{campsite,factor,score,veto,conflict}.ts
        ├── stores/{siteStore,profileStore,uiStore,conflictStore}.ts
        ├── components/common/{MapPanel,FactorScoreBar,GradeBadge,EmptyState,WeightEditor,ProfileAssignmentPanel,ConflictResolveDialog,ConflictHistory}.vue
        ├── hooks/{useAmapLoader,useRanking,useLocalDraft}.ts
        ├── pages/{Ranking,SiteNew,SiteDetail,Scoring,MapView,Veto}.vue
        ├── router/index.ts
        ├── utils/{score,geo,format,db,draft,conflict,syncBus}.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- 全部数据只存在浏览器本地：营位、因子评估、权重方案、否决记录、**并发改动/重算记录**存 **IndexedDB**（Dexie，库名 `gbcampsite-db`）。
- 表单草稿（新增营位、否决登记）存 **localStorage**，键前缀 `gbcampsite:draft:`，刷新或误关页面后可恢复。
- 容器完全无状态：不使用数据库服务、不挂载命名卷，清除浏览器站点数据即回到首次运行的样例营地。
