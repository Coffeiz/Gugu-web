# Admin 页面模块化重构方案

## 1. 现状与问题

### 1.1 页面规模

- `Admin/Agent/index.vue` 约 3000 行。
- 同一个文件同时包含模板、状态、请求、轮询、表单、弹窗和图表计算。
- 目前主要功能区块：
  - LLM 预设与模型列表；
  - 系统提示词；
  - 行为、搜索、语音和 Embedding 配置；
  - 个人记忆维护与 IM 记忆维护；
  - 状态文案；
  - 用量统计与决策轨迹。

### 1.2 主要问题

- 页面入口承担过多业务逻辑，修改一个功能容易影响其他区域。
- API 请求、轮询和错误处理散落在页面中。
- 表单状态和保存逻辑重复，难以独立测试。
- 大区块无法复用，后续新增配置会继续扩大入口文件。

其他 Admin 页面目前规模较小；Analytics 已有部分共享代码，暂不作为第一优先级。

## 2. 目标与边界

目标是让页面入口只负责：

- Admin 页面布局；
- Tab 导航；
- 子模块组合；
- 页面级权限和生命周期调度。

具体功能按职责拆分：

- `components/`：区块 UI、表单、弹窗、表格和图表；
- `composables/`：状态、保存、加载、轮询和交互流程；
- `api/` 或 service：Admin API 请求和响应类型；
- `utils/`：纯数据转换、格式化和校验。

不改变现有 API 语义、权限、配置结构和用户操作流程。

## 3. 目标目录

```text
frontend/src/views/Admin/
├── Agent/
│   ├── index.vue                 # 页面壳、Tab、模块组合
│   ├── components/
│   │   ├── LlmPresetsPanel.vue
│   │   ├── PromptPanel.vue
│   │   ├── BehaviorPanel.vue
│   │   ├── VoicePanel.vue
│   │   ├── EmbeddingPanel.vue
│   │   ├── MemoryMaintenancePanel.vue
│   │   ├── ImMemoryPanel.vue
│   │   ├── StateLabelsPanel.vue
│   │   ├── UsagePanel.vue
│   │   └── TracePanel.vue
│   ├── composables/
│   │   ├── useLlmPresets.ts
│   │   ├── usePrompts.ts
│   │   ├── useAgentBehavior.ts
│   │   ├── useVoiceConfig.ts
│   │   ├── useEmbeddingConfig.ts
│   │   ├── useMemoryMaintenance.ts
│   │   ├── useImMemoryMaintenance.ts
│   │   ├── useStateLabels.ts
│   │   ├── useUsage.ts
│   │   └── useTrace.ts
│   └── api.ts                    # Agent Admin 请求封装
├── Analytics/                    # 保持现有共享结构
└── ...
```

如果某个 composable 只被一个组件使用，可以暂时放在该组件旁边；确认复用后再上移到共享目录。

## 4. Agent 拆分映射

### Phase 1：LLM 预设

抽出：

- Provider 和 API 格式选择；
- 预设列表、新建、编辑、删除、激活；
- 模型列表获取和选择；
- 连通测试、多模态探测；
- pool/router 策略和并发配置。

入口只接收模块状态和事件，不再维护预设请求细节。

### Phase 2：提示词与标签

抽出：

- 提示词列表、切换、保存和占位符插入；
- 状态文案加载、筛选、重置和保存。

这两个模块状态独立，优先迁移风险较低。

### Phase 3：行为配置

拆成独立配置面板：

- Agent 行为；
- 搜索；
- 语音识别；
- Embedding。

每个面板自行维护 draft、保存、测试和错误状态，复用已有 Config Store。

### Phase 4：记忆维护

抽出两个独立模块：

- 个人记忆维护：预览、进度、确认整理；
- IM 群组/成员记忆：模型预览、计划状态、确认应用。

轮询必须由对应 composable 管理，并在组件卸载时停止；页面入口不直接操作定时器。

### Phase 5：用量与决策轨迹

抽出：

- 用量查询、月份切换、模型筛选、图表计算和 tooltip；
- 决策轨迹列表、详情、步骤解析和筛选。

图表计算全部移入 composable 或 utils，组件只负责渲染。

### Phase 6：入口收口

- 删除已经迁移的旧模板和函数；
- 删除重复状态和重复 API 请求；
- 将 `index.vue` 收口为 Tab + 模块组合；
- 检查是否存在跨模块直接修改状态的情况。

## 5. API 与状态约定

- API 请求统一放在 `Agent/api.ts` 或按功能拆分的 service 中。
- 组件不直接拼接 `/api/v1/admin/...` URL。
- composable 返回明确的 `loading/error/saving` 状态和操作函数。
- 密钥只保留后端脱敏结果，前端不缓存原始密钥。
- 轮询必须提供 `start/stop`，并在 `onUnmounted` 中清理。
- 模块之间通过 props、emit 或 composable 返回值通信，不直接互相访问内部 ref。

## 6. 执行与验证顺序

每次只迁移一个功能区块：

1. 先复制现有行为到新组件/composable；
2. 让入口改为使用新模块；
3. 删除该区块旧逻辑；
4. 运行前端 typecheck；
5. 在 devserver 手测对应功能；
6. 再进入下一个区块。

验证门禁：

- 每个阶段通过 `npm run typecheck`；
- API、Store 或纯逻辑变化补充 `npm run test:run` 或后端 pytest；
- 涉及轮询、弹窗、模型配置和记忆维护时进行定向手测；
- 最终执行完整 typecheck、build 和 Admin 冒烟测试。

## 7. 迁移原则与回滚

- 不进行一次性大重写，保持每阶段可回退。
- 新组件先保持原有 class、文案和接口行为，避免重构与视觉改版混在一起。
- 一个阶段只保留一套状态源，禁止新旧逻辑同时写同一配置。
- 出现行为差异时，优先回退当前阶段，不回退已验收模块。
- 迁移完成后再处理组件目录命名和跨页面复用，避免过早抽象。

## 8. 完成标准

- `Agent/index.vue` 只保留页面壳、Tab 导航和模块组合；
- 各功能模块的请求、状态和轮询已离开入口文件；
- 入口文件不再直接实现表单保存、模型测试、记忆维护或图表计算；
- Admin 所有现有功能行为不变；
- typecheck、build、自动化测试和定向手测全部通过；
- 其他 Admin 页面完成一次重复组件和重复请求审查。
