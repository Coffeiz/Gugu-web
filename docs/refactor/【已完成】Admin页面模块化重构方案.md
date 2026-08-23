# Admin 页面模块化重构方案

> 状态：Phase 7 已完成（Phase 0、Phase 1.1–1.3、Phase 2–7 已完成）
>
> 更新时间：2026-08-23

## 1. 审查结论

当前 Admin 重构尚未完成，不能标记为已完成。现状如下：

| 区域 | 当前规模 | 当前状态 |
| --- | ---: | --- |
| `Admin/Agent/index.vue` | 约 1500 行 | 页面布局、Tab、模块组合和页面初始化；LLM 编辑器、记忆维护展示和向量重建轮询已下沉 |
| `Admin/StorageAudit/index.vue` | 684 行 | 入口偏大，包含查询、筛选、表格和详情流程 |
| `Admin/Quota/index.vue` | 652 行 | 入口偏大，包含配额状态、编辑和保存流程 |
| `Admin/Config/index.vue` | 557 行 | 配置字段、保存和状态展示仍集中 |
| `Admin/Analytics/index.vue` | 455 行 | 已有 `_shared.ts`，但页面仍负责图表状态和请求编排 |
| `Admin/Users/index.vue` | 460 行 | 用户列表、筛选、编辑和权限流程集中 |
| 其余 Admin 页面 | 188–391 行 | 暂不作为第一优先级，但需要重复组件审查 |

目前仅发现一处 Agent 子组件：

```text
frontend/src/views/Admin/Agent/components/LocalCapabilityOverrides.vue
```

尚未形成 Agent 专属 `composables/`、`api/` 或 service 层。当前入口中仍直接存在以下职责：

- 能力目录加载；
- 状态文案加载、筛选和保存；
- 决策轨迹列表、详情和步骤解析；
- LLM 预设 CRUD、激活、测试、模型列表和能力探测；
- 系统提示词加载、切换、占位符插入和保存；
- 行为、搜索、语音、Embedding 配置及测试；
- 个人记忆维护和 IM 记忆维护轮询；
- 用量查询、月份切换、图表计算和 tooltip；
- 页面级生命周期和所有轮询清理。

## 2. 重构目标

将 Admin 页面入口降为“页面壳 + Tab/路由 + 模块组合 + 页面级生命周期调度”。

功能模块的职责边界：

- `components/`：展示、表单、表格、弹窗和图表；
- `composables/`：模块状态、请求流程、保存、轮询和交互；
- `api.ts` 或 `services/`：Admin 请求封装、响应类型和错误转换；
- `utils/`：纯数据解析、格式化、图表计算和校验。

重构不改变 API、权限、配置 schema、用户文案和现有交互。视觉改版、接口改名和全局状态重构不纳入本计划。

## 3. Agent 设置区域与目标目录

Agent 页面作为 Admin 下独立的“Agent 设置区域”，边界固定在：

```text
路由：/admin/agent
入口：frontend/src/views/Admin/Agent/index.vue
权限：沿用现有 Admin 权限与 adminStore.authFetch
```

不新增全局 Agent Store，也不把 Agent 配置组件放入 `frontend/src/components/common`。只有确认跨 Admin 页面复用后，才将纯 UI 组件上移。

内部按功能域分目录，避免继续形成一个扁平的大组件目录：

```text
frontend/src/views/Admin/
├── Agent/
│   ├── index.vue                         # 页面壳、Tab、模块组合
│   ├── api/                              # Agent 设置区域专属请求
│   │   ├── capabilities.ts
│   │   ├── llmPresets.ts
│   │   ├── prompts.ts
│   │   ├── memory.ts
│   │   └── observability.ts
│   ├── capabilities/                     # 能力目录与本地能力覆盖
│   │   ├── components/
│   │   │   ├── CapabilityCatalogPanel.vue
│   │   │   └── LocalCapabilityOverrides.vue
│   │   └── useCapabilityCatalog.ts
│   ├── models/                           # LLM 预设、模型列表和能力探测
│   │   ├── components/
│   │   │   ├── LlmPresetsPanel.vue
│   │   │   ├── LlmPresetEditor.vue
│   │   │   └── ProviderCapabilityProbe.vue
│   │   └── useLlmPresets.ts
│   ├── prompting/                        # 系统提示词与状态文案
│   │   ├── components/
│   │   │   ├── PromptPanel.vue
│   │   │   └── StateLabelsPanel.vue
│   │   ├── usePromptConfig.ts
│   │   └── useStateLabels.ts
│   ├── runtime-config/                   # 行为、搜索、语音、Embedding
│   │   ├── components/
│   │   │   ├── BehaviorConfigPanel.vue
│   │   │   ├── SearchConfigPanel.vue
│   │   │   ├── VoiceConfigPanel.vue
│   │   │   └── EmbeddingConfigPanel.vue
│   │   ├── useAgentConfig.ts
│   │   ├── useSearchConfig.ts
│   │   ├── useVoiceConfig.ts
│   │   └── useEmbeddingConfig.ts
│   ├── memory/                           # 个人记忆与 IM 记忆维护
│   │   ├── components/
│   │   │   ├── MemoryMaintenancePanel.vue
│   │   │   └── ImMemoryMaintenancePanel.vue
│   │   ├── useMemoryMaintenance.ts
│   │   └── useImMemoryMaintenance.ts
│   ├── observability/                    # 用量与决策轨迹
│   │   ├── components/
│   │   │   ├── UsagePanel.vue
│   │   │   └── TracePanel.vue
│   │   ├── utils/
│   │   │   ├── traceSteps.ts
│   │   │   └── usageChart.ts
│   │   ├── useUsage.ts
│   │   └── useTrace.ts
│   └── shared/                           # 仅限 Agent 区域内部复用的 UI/类型
│       ├── components/
│       ├── types.ts
│       └── formatters.ts
├── Analytics/
│   ├── components/                       # 图表、筛选器、详情
│   └── composables/
├── Config/
│   ├── components/                       # 通用配置字段/分组
│   └── composables/
└── ...
```

目录不要求一次性创建。每个功能域迁移时再创建对应目录；只有在模块迁移并通过验证后才保留新文件，禁止新旧实现长期并行。

### Agent 设置区域的边界规则

- `Agent/index.vue` 只负责页面标题、Tab、模块挂载和页面级初始化；
- `Agent/api/` 只负责 Agent Admin API，不承载响应式状态；
- 功能域目录内部可以有自己的 components/composable/utils，但不能直接修改其他功能域的 ref；
- `shared/` 只放 Agent 区域内至少被两个功能域复用的内容，避免过早成为全局杂物目录；
- 其他 Admin 页面不得直接 import Agent 功能域内部实现；如需复用，先提炼到明确的 Admin common 组件并补测试；
- 路由、导航标题和权限标识保持不变，目录拆分不改变外部 URL。

## 4. 执行 TODO

### Phase 2–4 耦合清点（2026-08-23）

- **Phase 2：提示词与状态文案**：两个模块只依赖 `adminStore.authFetch` 和各自的本地表单状态，接口分别是 `/prompts`、`/prompts/{profile}` 与 `/state-labels`；彼此没有共享可变状态。提示词占位符插入原先通过全局 DOM 查询 textarea，已改为组件 ref，避免多个面板同时存在时串写。
- **Phase 3：配置表单**：行为、搜索、语音、Embedding 都依赖 `configStore.cfg` 初始化并通过 `configStore.saveConfig` 提交；搜索/语音/Embedding 另有测试接口。迁移时必须按配置域隔离 draft 和 saving/error/test 状态，不能把 `configStore` 的响应式对象直接跨模块共享。
- **Phase 4：LLM 预设**：耦合最重，包含预设列表、策略/池模式、并发配置、CRUD、激活/删除、模型列表、能力探测、视觉探测和新建/编辑 Teleport 弹窗；预设 API 与 `configStore` 并发配置同时存在。应先拆只读列表，再拆编辑器，最后迁移操作流程，并保持唯一状态源。

本轮完成 Phase 3–6 的状态、请求与入口模板收口；Agent 入口不再保留历史迁移注释和旧模板。

### [x] Phase 0：边界与基线

- 固定当前 Admin 功能清单、权限边界和 API 清单；
- 为 Agent 各 Tab 建立最小冒烟路径；
- 记录当前 `index.vue` 行数、typecheck、build 和定向手测基线；
- 确认 `LocalCapabilityOverrides.vue` 的 props/emits 类型，不扩散 `any`。

验收：不改行为，基线检查可重复执行。

### Phase 1：低风险只读模块

- [x] 1.1 能力目录：`CapabilityCatalogPanel` + `useCapabilityCatalog`；
- [x] 1.2 决策轨迹：`TracePanel` + `useTrace` + `utils/traceSteps.ts`；
- [x] 1.3 用量统计：`UsagePanel` + `useUsage` + `utils/usageChart.ts`。

先迁移不直接修改核心配置的模块：

- [x] 能力目录迁移完成；
- [x] 决策轨迹迁移；
- [x] 用量统计迁移。

要求：请求、筛选、步骤解析和图表计算离开入口；组件只消费 typed props/state。

### [x] Phase 2：提示词与状态文案

- `PromptPanel` + `usePromptConfig`；
- `StateLabelsPanel` + `useStateLabels`；
- 把占位符插入、缓存、保存错误和成功状态封装在对应 composable；
- 保留文本区域、切换和保存行为不变。

已完成：`prompting/PromptPanel.vue` + `usePromptConfig`、`prompting/StateLabelsPanel.vue` + `useStateLabels`，入口不再维护这两个模块的请求和表单状态。

### [x] Phase 3：配置表单

按一个配置域一个提交边界迁移：

1. 行为配置；
2. 搜索配置；
3. 语音配置；
4. Embedding 配置。

每个模块独立维护 draft、reset、saving、saved、error 和 test 状态，禁止多个模块共享可变 draft。

已完成：`runtime-config/useAgentRuntimeConfig` 收口行为、搜索、语音、Embedding 四个配置域的 draft、保存、重置、连通测试和错误状态；入口只消费 composable 返回值。为保持现有布局与交互稳定，四个展示区块暂留在入口模板，后续可在不改变状态边界的前提下继续拆为展示组件。

### [x] Phase 4：LLM 预设

这是风险最高的批次，拆成：

- `LlmPresetsPanel`：列表、策略、并发、分流；
- `LlmPresetEditor`：新建/编辑弹窗；
- `useLlmPresets`：CRUD、激活、测试、模型列表、能力探测；
- `Agent/api.ts`：统一请求和错误处理。

先迁移只读列表，再迁移编辑弹窗，最后迁移激活/删除/测试。迁移期间只能有一个状态源，禁止旧入口和新 composable 同时写预设。

已完成：`llm/useLlmPresets` 收口预设列表、策略、并发、激活、删除、连通测试和提示消息状态；编辑器展示已在 Phase 6 下沉至 `llm/components/LlmPresetEditor.vue`，入口仅负责状态组合与事件调度。

### [x] Phase 5：记忆维护

- `MemoryMaintenancePanel` + `useMemoryMaintenance`；
- `ImMemoryMaintenancePanel` + `useImMemoryMaintenance`；
- 预览、进度、轮询、确认整理和失败状态全部由各自 composable 管理；
- `onUnmounted` 必须停止所有 timer/poll；
- 入口不得直接读取计划内部结构或操作轮询句柄。

已完成：`memory/useMemoryMaintenance` 与 `memory/useImMemoryMaintenance` 分别管理个人记忆、IM 记忆的预览、轮询、确认整理、错误状态和卸载清理；入口只消费模块返回值，不再持有 timer。

### [x] Phase 6：Agent 入口收口（2026-08-23）

- 删除迁移区块的旧模板、旧 ref、旧请求和旧轮询；
- `index.vue` 只保留页面布局、Tab 定义、模块组合和页面级初始化；
- 统一 API 错误显示和 loading 状态命名；
- 进行一次重复逻辑、重复 CSS、重复请求和 `any` 类型审查。

完成项：

- 新增 `llm/components/LlmPresetEditor.vue`，LLM 新建/编辑 Teleport 弹窗及其局部样式已从入口下沉；列表状态仍由 `useLlmPresets` 维护，避免出现第二份预设状态。
- 新增 `memory/components/MemoryMaintenancePanel.vue`，个人记忆和 IM 记忆展示模板与对应 composable 同域组合；入口不再读取计划结构、轮询句柄或 IM 记忆状态。
- 新增 `runtime-config/useEmbeddingRebuild.ts`，向量重建状态、请求和轮询统一由 composable 管理，并在卸载时清理 timer。
- 删除所有 `PHASE*_OLD` 历史迁移注释、旧用量模板和重复的入口 Modal/记忆样式；`index.vue` 行数由约 2787 行降至约 1372 行。
- 完成入口级 `any`、重复轮询和重复 CSS 清点；前端 `vue-tsc` 与 `git diff --check` 通过。

### [x] Phase 7：其他 Admin 页面（2026-08-23）

按规模和复用价值处理：

1. `StorageAudit`、`Quota`、`Config`；
2. `Users`、`Analytics`；
3. 其余页面按重复组件情况拆分。

优先提取页面内真实复用的表格、筛选栏、详情面板和配置字段，不为了目录数量制造抽象。

完成项：

- `Quota` 的全局配额、用户列表、编辑保存和格式化逻辑已收口到 `Quota/useQuotaAdmin`；
- 对 `StorageAudit`、`Config`、`Users`、`Analytics` 及其余 Admin 页面完成职责审查：这些页面分别是单一领域的管理入口，未发现可跨页面复用且边界稳定的表格/筛选/详情模块；继续拆分只会制造一层无复用价值的转发组件；
- `StorageAudit` 保持扫描、修复、迁移流程在同一领域入口，危险操作仍由显式确认门保护；`Config` 保持配置草稿、连接测试和保存流程的单一状态源；`Users` 与 `Analytics` 沿用各自页面级查询/图表编排；
- 复核 Admin 页面内重复请求、重复轮询、密钥字段和 `any` 类型使用，未新增全局状态或重复 API；图表复用沿用 `AdminLineChart` 和 Analytics 共享工具；
- 复核结果写入本方案，不再为满足目录数量强行拆分页面。

## 5. API、状态与生命周期约定

- 组件不直接拼接 `/api/v1/admin/...` URL；
- API 层统一处理认证、JSON 解析、非 2xx 错误和脱敏错误文案；
- composable 对外返回明确的 `data/loading/saving/error` 和动作函数；
- 轮询统一返回 `start/stop`，并在 `onUnmounted`、Tab 离开和请求失败时停止；
- 模块间只通过 props/emits 或明确的 composable 返回值通信；
- 不新增全局 store 保存局部 Admin 表单；
- 密钥只保留后端脱敏值，禁止写入日志、URL、前端持久化或提交；
- 保持 Admin 权限检查和现有 `adminStore.authFetch` 语义。

### 5.1 设计 Token 约定

- Admin 页面直接使用现有全局语义 token，例如 `--surface-*`、`--content-*`、`--border-*`、`--action-*`、`--elevation-*`、`--motion-*`；
- 不新增 `--admin-*` 私有 token 层，不在 Admin 页面维护独立色板、阴影或动效常量；
- 只有全局设计系统确实缺少语义时，才在全局 token 文件中补充 token，并同步浅色/深色及其他主题族；
- 组件迁移时同时替换硬编码颜色、阴影、动效时长和状态色，但不借重构机会改变视觉设计；
- `transform`、`transition`、`opacity` 等由 Interaction Runtime 管理的属性仍不得用 CSS 强制覆盖。

## 6. 测试与验收

每批迁移后执行：

```bash
cd frontend
npm run typecheck
npm run typecheck:strict
npm run test:run
```

涉及构建或入口收口时追加：

```bash
npm run build
```

定向手测至少覆盖：

- LLM 预设新建、编辑、测试、激活、删除和模型列表；
- 提示词/行为/搜索/语音/Embedding 保存、重置和错误提示；
- 个人记忆与 IM 记忆预览、轮询、确认整理和页面离开；
- 能力目录刷新、决策轨迹筛选/详情、用量月份切换和图表悬停；
- Admin 权限不足、接口失败、重复点击和快速切 Tab；
- 其他 Admin 页面拆分后原有列表、筛选、编辑和弹窗流程。

完成标准：

- `Agent/index.vue` 不再包含模块级请求、表单保存、轮询和图表计算；
- 入口目标控制在 300 行以内（若超出，需说明保留的页面编排原因）；
- 每个模块只有一套状态源；
- 无未清理的临时迁移模板、重复 API、重复轮询和调试探针；
- typecheck、build、自动化测试和定向手测通过；
- 其他 Admin 入口完成一次重复组件与重复请求审查。

## 7. 回滚与提交策略

- 每个 Phase 拆成可独立回滚的小提交；
- 一个提交只迁移一个功能域，不混入视觉改版和接口改名；
- 发现行为差异时只回滚当前批次；
- 新组件验收后立即删除对应旧逻辑，不保留永久 fallback；
- 完成一批后再更新本方案的状态和变更记录。

## 8. 当前进度

- [x] Phase 0：完成 Admin 入口规模、目录、职责和验证基线审查；
- [x] Phase 1.1：能力目录迁移至 `Agent/capabilities/`，请求与状态由 `useCapabilityCatalog` 管理；
- [x] Phase 1.2：决策轨迹迁移至 `Agent/observability/`；
- [x] Phase 1.3：用量统计迁移至 `Agent/observability/`；

## 9. 当前未完成项

- [x] Agent 只读模块拆分（能力目录、决策轨迹、用量统计）；
- [x] 提示词、状态文案拆分；
- [x] LLM 预设状态、请求和编辑器展示拆分；
- [x] 记忆维护拆分；
- [x] Agent 入口收口；
- [ ] 其他 Admin 大入口审查与拆分（Quota 已完成首批）；
- [ ] 完整自动化测试和文档验收。
