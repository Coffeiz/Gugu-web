# 前端 JS → TS 迁移指南 + Roadmap

> 适用范围：`frontend/`（Vue 3 + Vite）。后端是 Python/FastAPI，与本文无关。
> 状态：工具链已就绪（2026-06-30），处于**增量迁移**阶段，逻辑层已全部迁完，组件层进行中；**阶段 4「收紧 strict」已起步**（2026-07-11，文件级棘轮，见 §6 阶段 4）。
> 本文档核实更新：2026-07-11

---

## 易读概述

**这篇文档讲的是：前端代码正在从 JavaScript 换成 TypeScript，换到哪一步了、以后新代码怎么写。**

简单说，TypeScript 是给 JavaScript 加了"类型标注"的升级版——写代码时编辑器能提前告诉你"这里传错类型了""这个字段不存在"，减少上线后才发现的低级 bug，重构时也更有信心。咕咕前端从 2026-06-30 开始渐进式地把 `.js` 文件和 Vue 组件迁移到 TS，不是一次性推倒重写，而是"改到哪个文件就顺手把哪个文件转掉"，避免大改动和别人的并发提交打架。

**目前进度（本次核实，2026-07-02）**：
- 所有"逻辑类"代码（api 请求封装、状态管理 store、composable、工具函数、路由、入口文件）**已经 100% 是 TS**，`frontend/src/` 目录下已经找不到一个 `.js` 文件了。
- Vue 组件（`.vue` 文件）还在推进：全项目 67 个 `.vue` 文件里，14 个已经加上 `lang="ts"`（约 21%），其余大部分是还没排上号的中小型组件，加上 5 个"巨型视图"（1000+ 行的大文件）是剩余工作量的大头。
- 类型检查命令 `npm run typecheck` 目前是绿的（没有类型错误），说明这套渐进迁移的门禁是真实生效的，不是摆设。

对不太懂代码的人来说，这件事的意义是：**不会影响你能看到的功能**，纯粹是让代码更不容易出低级错误、后续开发更快更稳。

---

## 专业细节

### 1. 为什么做 / 可行性

把前端从 JS 渐进迁到 TS，拿到类型安全、重构信心、更好的编辑器提示。

可行性高——最硬的活儿已经不存在：

| 指标 | 数据（原文档 06-30） | 数据（本次核实 07-02） | 含义 |
|---|---|---|---|
| `.vue` 文件 | 64 个（30.3k 行） | **67 个（约 31.1k 行）** | 中等规模，期间新增了几个组件 |
| `.js` 文件（`frontend/src` 内） | 34 个 | **0 个** | ✅ 逻辑层已全部转完，见 §6 阶段 2 里程碑 |
| `<script setup lang="ts">` 组件数 | 0 | **14 / 67**（约 21%） | 组件层迁移进行中 |
| Options API | 0 个 | 0 个 | ✅ 无范式重写，迁移≈「加 `lang="ts"` + 标注类型」 |
| `defineProps` | 27 文件全对象式，数组式 0 | 与原文档一致 | ✅ 易加类型 |
| 第三方依赖类型 | 几乎全自带 | 同左，`@types/qrcode` 已装 | ✅ |

**结论：低难度、低风险、可增量、永不阻塞功能。** 主要成本在"建领域类型"+"啃 5 个巨型文件"（见 §6）。

---

### 2. 工具链现状（已搭好）

| 文件 | 作用 |
|---|---|
| `frontend/tsconfig.json` | `allowJs:true` + `checkJs:false` + `strict:false` 起步 —— **JS/TS 共存，存量 `.js` 不检查，只查新写的 `.ts` / `lang="ts"`**；配了 `@/*` 别名、`vite/client` 类型 |
| `frontend/tsconfig.strict.json` | **阶段 4 严格化棘轮**（2026-07-11）：`extends` 主档、`strict/noImplicitAny` 全开，只作用于 `include` 白名单。主档保持渐进（不阻塞 `build`/`typecheck`），清干净一个文件就加进白名单、`typecheck:strict` 常绿当门禁。详见 §6 阶段 4 |
| `frontend/src/vite-env.d.ts` | `vite/client` 引用 + `__APP_VERSION__` 声明 |
| `frontend/vite.config.js` | AutoImport / Components 的 `dts` 已开 → 自动生成 `auto-imports.d.ts`（`ref`/`computed`/`watch`…）、`components.d.ts`（Arco 组件），**否则 vue-tsc 不认识这些自动导入的全局名** |
| `frontend/.gitignore` | 忽略两个生成的 dts + `*.tsbuildinfo`（每次 vite 运行自动重建，不入库） |
| `package.json` | `"typecheck": "vue-tsc --noEmit"`；devDeps：`typescript@~5.6` + `vue-tsc@~2.1` |

**类型检查命令**：

```bash
cd frontend
npm run typecheck          # vue-tsc --noEmit（全仓渐进档），绿 = 0 错
npm run typecheck:strict   # vue-tsc -p tsconfig.strict.json（严格档白名单），绿 = 白名单文件全 strict-clean
```

**核实**：本次核实实测跑过一次 `npm run typecheck`，**绿（exit 0）**，门禁确实生效。已用「故意写错的 .ts」验证门禁确实会抓错（`TS2322`），不是摆设。

---

### 3. 日常约定（强制）

> 长期偏好：**新代码一律 TS，不再新建 `.js`；改到的 JS 顺带转 TS。**

- **新文件**：
  - 组件 → `<script setup lang="ts">`
  - 逻辑/composable/store/util → `.ts`
- **顺带迁移**：因修 bug / 加功能动到某文件时：
  - `.vue` → 把 `<script setup>` 改成 `<script setup lang="ts">`（**不改文件名，最安全**），补类型
  - `.js` → rename 成 `.ts`，补类型（不求完美、能过 `typecheck` 即可）
- **不主动批量转换**存量——只转触碰到的，避免不相关的大 diff（项目有并发提交，**大爆炸重写会撞车**）。
- 写完跑一次 `npm run typecheck` 确认没把门禁带红。

---

### 4. 转换操作细则 / 注意事项

#### 4.1 `.vue` 转 lang=ts
最省事：只改 `<script setup>` → `<script setup lang="ts">`。然后 vue-tsc 会**连模板一起**类型检查，按提示补：
- `defineProps` → 用泛型式：`defineProps<{ id: number; title?: string }>()`（替代运行时对象式）
- `defineEmits` → `defineEmits<{ (e: 'save', id: number): void }>()`
- 模板 ref → `const el = ref<HTMLElement | null>(null)`；组件 ref → `ref<InstanceType<typeof Foo> | null>(null)`

#### 4.2 `.js` rename `.ts` 的坑
- Vite 无后缀 import 两者都解析，**但别处用显式 `.js` 后缀** import 该文件会断。转前先 grep：
  ```bash
  grep -rn "from '.*<文件名>\.js'" frontend/src
  ```
- `services/api.ts`（原 `api.js`，已完成迁移）是**类型咽喉**：请求/响应泛型化后，类型顺着 api → store → 组件全链路自动流。

#### 4.3 自动导入
项目用 `unplugin-auto-import`，`ref`/`computed`/`watch`/`defineProps` 等**全局可用、可不显式 import**。`dts` 已开，vue-tsc 认得。但**新代码建议显式 import**（TS 下更清晰、利于 tree-shaking 判断）。

#### 4.4 SMB / devserver 注意
- 在 SMB 盘开发：git 必设 `core.fileMode false`（已设），否则满屏 filemode 假改动。
- `npm install` 必须在 **devserver（Linux）** 跑，别在 Mac 上对 SMB 装 —— esbuild 等有平台二进制，会错乱。
- 改 `tsconfig` / `vite.config` 后 vite 会自动重启；`auto-imports.d.ts` / `components.d.ts` 随之重建。
- **核实补充**：工作流已从"SMB 编辑"改为**本地编辑 + Mutagen 双向同步**（本地用编辑器改、git 本地跑、typecheck/重启走 SSH），`._*` AppleDouble 坑随之消失，详见记忆 `gugu-mutagen-sync`。

---

### 5. 类型怎么建（按收益排序）

1. **领域实体类型（最高收益）**：后端是 Pydantic，**用 OpenAPI 一键生成**，顺带前后端对齐：
   ```bash
   cd frontend
   npx openapi-typescript http://127.0.0.1:8000/openapi.json -o src/types/api.ts
   ```
   拿到 Project / Event / File / Stage / Todo / Message 等类型，替代手搓对象（`normalizeEvent` 之类）。**已完成**，见 §6 阶段 1。
2. **api 层**：`services/api.ts`，请求/响应套上 §1 生成的类型。**已完成**。
3. **stores（12 个）**：Pinia 原生 TS，setup store 类型很顺。**已完成**。
4. **composables（11 个）**：通常干净好类型；`usePhysicsDrag` 这种重逻辑较费劲。**已完成**。
5. **utils（5 个）**：纯函数，最易转，可当练手。**已完成**。

---

### 6. Roadmap（分阶段）

> 原则：每阶段结束 `npm run typecheck` 必须绿；增量推进，不阻塞功能开发。

#### ✅ 阶段 0 · 工具链（已完成，2026-06-30）
- [x] `tsconfig.json`（allowJs / checkJs:false / strict:false）
- [x] `vue-tsc` + `typecheck` 脚本，基线绿 + 门禁验证
- [x] AutoImport/Components dts、`vite-env.d.ts`、`.gitignore`

#### ✅ 阶段 1 · 类型地基（已完成，2026-06-30）
- [x] OpenAPI 生成 `src/types/api.ts`（7468 行；`npm run gen:types` 一键重生，需后端 dev 在 :8000）
- [x] `services/api.js` → `api.ts`：`request`/`get`/`post`… 泛型化（默认 `any` 不阻塞存量）；projects/events/files/folders/clients/preferences 用 OpenAPI 类型标注返回值，其余留 `any` 待增量升级
- [x] ~~补 `window.*` 自定义全局的 `global.d.ts`~~ —— **实测不需要**：109 处 `window.*` 全是标准属性读取，无自定义全局赋值
- [x] `@types/qrcode` 已装（qrcode 用在 GuguChat/ProfileModal，转 ts 时会用到）

> 备注：`src/types/api.ts` 是生成物但**入库**（这样 CI/`typecheck` 不依赖后端在跑）；改了后端模型后跑 `npm run gen:types` 重生并提交。

#### ✅ 阶段 2 · 低风险层（完成，2026-06-30）
- [x] `utils/`（5）→ ts —— 纯 rename（commit `54ec693`）
- [x] `stores/`（12）→ ts —— rename + 修真实类型错（admin 的 RequestInit、config 的 Record、projects 的 Date.getTime()、preferences 的 calendarDoneMode 暂 as any）（`98e0559`）
- [x] `composables/`（11，含 `usePhysicsDrag`）→ ts —— 前 10 个纯 rename（`21c44fa`）；`usePhysicsDrag`（632 行）修 opts 接口 + DOM 泛型/cast（`6bef46c`）
- [x] 零散入口/路由/service（main/admin/router/cache）→ ts —— 入口 HTML `<script src>` 同步改 + routes 标 `RouteRecordRaw[]`（`e42fa74`）
- [x] 小型 `components/` → lang=ts —— 已转 8 个最简单叶子件（ContextMenu/NavItem/PdfViewer/BaseModal/MarkdownView/AdminSelect/SegBar/FileInfoPopup，`702a138`）
- [x] **（本次核实更新）中型组件持续推进**：核实时点（2026-07-02）实际已 `lang="ts"` 的组件共 **14 个**，除阶段 2 提交的 8 个叶子件外，另有 `GlassBg.vue`（新组件，玻璃背景，直接以 TS 落地）、`views/Calendar/index.vue`（阶段 3 提前完成，见下）、`views/Admin/Agent/index.vue`、`views/Admin/Ops/index.vue`、`views/Admin/Analytics/index.vue`、`views/Admin/Analytics/Usage.vue`（均为新增/大改页面顺手转 TS）

> **里程碑（2026-06-30）：`frontend/src/` 已无 `.js` 文件**——所有逻辑/store/composable/util/入口/路由全是 `.ts`。剩余非-TS 是「未加 `lang="ts"` 的 `.vue`」（中型组件 + 阶段 3 巨型视图）。**本次核实（2026-07-02）复查仍成立**：`frontend/src` 下 grep 不到任何 `.js` 文件。

> 工作流变更：已从「SMB 编辑」改为**本地编辑 + Mutagen 双向同步**（见 [[gugu-mutagen-sync]]）——本地用编辑器改、git 本地跑、typecheck/重启走 SSH。`._*` AppleDouble 坑随之消失。

#### 阶段 3 · 巨型视图（主要工作量，~3–5 天）
> 这 5 个文件 ≈ 37% 代码、≈80% 的痛，**配合功能迭代逐个转**、别集中硬啃：
- [ ] `views/Projects/components/ProjectModal.vue`（3017 行）
- [ ] `views/Files/index.vue`（2760）
- [x] `views/Calendar/index.vue`（2313，含拖拽/网格）—— 已迁移（2026-06-30，commit `8ad54ce`），typecheck 绿
- [ ] `views/Admin/Agent/index.vue`（2294）—— **核实：该文件已加 `lang="ts"`**，与本条待办状态不符，见下方说明
- [ ] `components/common/GuguChat.vue`（2143，聊天流）

> **核实发现**：`views/Admin/Agent/index.vue` 实测已是 `<script setup lang="ts">`，但 Roadmap 复选框仍显示未完成——原因是该文件规模已随功能迭代超出原「阶段 3」清单统计时的 2294 行基准，且转换是跟着功能改动顺手做的、未回填 Roadmap 勾选。这里保留待办原状供参考，但请注意**该项目实际已完成 TS 化**，剩余巨型视图待转的是 `ProjectModal.vue`、`Files/index.vue`、`GuguChat.vue` 三个。

#### 🔧 阶段 4 · 收紧 + 守门（**已起步，2026-07-11**）

**关键教训——不能全仓一刀切开 `strict`**：实测把整个 Projects 模块入严格档，一次牵出 **838 个存量错、涉 30 文件**（半个 app）。因为 `strict` 跨整个 program 报错，而 Vue 组件的 import 闭包会扇出到共享基建（stores / composables / common 组件）。所以收紧的粒度必须是**文件**，不是「模块」。

**落地机制——文件级棘轮**（见 `tsconfig.strict.json`）：
- 主 `tsconfig.json` 保持 `strict:false` 全仓渐进，`build`/`typecheck` 常绿不受影响；
- `tsconfig.strict.json` 在其上 `strict/noImplicitAny` 全开，**只作用于 `include` 白名单**；
- 清干净一个文件（其 import 闭包也全 strict-clean）→ 加进白名单 → `npm run typecheck:strict` 必须常绿（提交前门禁）。
- 从**叶子**（util/type，闭包小自洽）起步，逐层把 store/composable 补齐后再向组件扩张。

- [x] 建棘轮：`tsconfig.strict.json` + `typecheck:strict` 脚本（2026-07-11）
- [x] 首批入档：`src/utils/**` + `src/types/**` strict-clean；新建 `src/types/project.ts` 领域模型（绑定 OpenAPI `ProjectResponse`）；Projects 组件 `PropType<any[]>` → `Project[]`
- [x] stores 底座入档（2026-07-11）：`projects.ts`（105→0，`ref<Project[]>` 消 ~80）+ `ui.ts` + `live.ts` + `services/**` + `composables/useOnboarding.ts`。确立「api 边界一次性收紧 wire→紧类型」模式
- [x] 轻量 store/composable 尾批（2026-07-11）：admin/clipboard/audio/config/preferences + useSorting/useLiveRefresh/useHolidays/useStageTemplates/useThumbCache（10 文件、51 错）
- [x] 文件簇 ③-a（2026-07-11）：filesCache/preview/useUploadQueue/useBoxSelection。定义 `FileMeta`（=OpenAPI `FileResponse` + 客户端增补字段交集）、`FolderMeta`（=`FolderResponse`）领域类型；preview 承载聊天附件故用 `Partial<FileMeta>`
- [x] 文件簇 ③-b（2026-07-11）：usePhysicsDrag（959 行/67 错→0，拖拽引擎）+ useFileDragDrop。加 `Box`/`ActiveDrag` 类型、DOM 参数标注、`event: PointerEvent\|DragEvent` 联合就地 cast、`pointerId!`/`_active!` 断言——纯类型标注零逻辑改动。**棘轮累计 30 源文件；stores/composables/services/utils/types 底座已全 strict-clean**
- [x] 底座补齐 + 组件层 ⑤（2026-07-11）：补 auth/useLazyThumb 两个漏网基座；入档 **13 个 common 组件**（NavItem/PdfViewer/FeedbackModal/FileInfoPopup/DatePicker/DateSpanPicker/ImageViewer/VideoViewer/AppSidebar/GlobalSearch/GlassBg/UploadConflictDialog/AvatarCropper/SegBar/NotificationBubble/TextViewer/FilePreviewModal/FloatPreviewWindow）。**棘轮累计 72 源文件**：底座 + 20 common 组件 + AdminLayout/AdminSelect/AdminDatePicker + 全部 Admin 页（除 Agent）+ Schedules + 4 auth 页 + ContextMenu
- [x] Mind 面板入档（2026-07-11）：`stores/mind.ts`、`useMindEditor.ts` 与 8 个视图/组件 strict-clean；递归日期坐标函数补 `number` 返回类型，`typecheck:strict` / `typecheck` / 169 个前端测试全绿
- [ ] 接力：剩 4 个巨型视图（Calendar / Files / GuguChat / ProjectModal）——**它们同时是 P2-a「拆大模块」的目标，归 P2-a 拆分时一起类型化**，不单独纯堆类型逐个入档；Calendar `CalendarEvent` 与 Mind 以外页面的 TipTap 边界按功能稳定度继续增量入档
- [ ] CI / 部署流程加 `npm run typecheck` + `typecheck:strict` 门禁（红则挡）
- [ ] 存量 `.js` 清零后，`tsconfig` 关 `allowJs`（**核实：`.js` 已清零，此项条件已满足，可评估执行**）

**工时估**（单人，增量）：全量 strict 约 **1.5–2.5 周**；棘轮已就位，后续是「填白名单」的增量活，随功能推进即可。

---

### 7. 常见报错速查

| 报错 | 原因 / 处理 |
|---|---|
| `Cannot find name 'ref'`（lang=ts 文件） | auto-import dts 没生成 → 重启 vite，或新代码直接显式 `import { ref } from 'vue'` |
| `Cannot find module '@/...'` | tsconfig `paths` 已配 `@/*`；确认文件真实存在、后缀正确 |
| 模板里组件标红（Arco `<a-xxx>`） | `components.d.ts` 没生成 → 重启 vite 让 unplugin 重建 |
| rename `.js`→`.ts` 后某处 import 断 | 有显式 `.js` 后缀 import，改掉后缀（见 §4.2） |
| `npm install` 后 vite 起不来 | 是否在 Mac 上对 SMB 装的？去 devserver（Linux）重装（见 §4.4） |

---

*维护：随阶段推进勾选 Roadmap；约定见记忆 `gugu-ts-migration`、`gugu-smb-sync`、`gugu-mutagen-sync`。*
