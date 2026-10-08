# PRD-LLM-33：决策模型最终筛选与能力预注入

> 状态：方案待确认，尚未实施
> 创建：2026-10-08
> 最近更新：2026-10-08
> 关联模块：`backend/agent/rag/`、`backend/agent/capabilities/`、`backend/agent/run/preparation.py`、`backend/agent/providers/`、`backend/app/byok/`、`backend/app/api/v1/`、`frontend/src/components/common/profile/ProfileByokPane.vue`、Admin Agent 配置页
> 背景参考：`docs/prds/【已完成】PRD-RAG-1-统一知识召回与索引.md`、`docs/prds/【已完成】PRD-RAG-4-召回评分过滤与质量控制.md`、`docs/prds/【已完成】PRD-LLM-9-工具与Skill注册制及按需注入.md`、`docs/prds/PRD-LLM-30-Provider思考深度与API格式能力配置.md`；TypeSafe 官方 [API](https://api.typesafe.ai/redoc)、[RAG passage 分类示例](https://docs.typesafe.ai/cookbooks/classifying_rag_passages)、[Skill suggestion 示例](https://docs.typesafe.ai/cookbooks/skill_suggestion)

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| RAG 召回与注入 | BM25 / hybrid 召回后由 TS worker 融合、排序、过滤和预算裁剪；Python 执行最终 owner/scope 复核与上下文组装 | ✅ 已完成 | 当前没有生产决策模型最终筛选；worker 的最终限制可能使上游无法取得更大的候选池。 |
| 工具能力选择 | Registry/授权快照与能力目录推荐已存在；推荐只重排，不裁掉授权工具 | 🟡 部分完成 | 全量 Schema 与简介/固定 Adapter 两种注入模式已存在；当前没有按本轮语义预先选择并直接注入具体 Schema 的决策策略。 |
| Skill 注入 | Run 准备阶段提供 Skill metadata；Skill 正文通过 `use_skill` 按需加载 | 🟡 部分完成 | 当前没有基于决策模型的本轮 Skill 正文预注入。 |
| 决策模型配置与协议 | 主 LLM、Embedding 与 Provider 配置已有独立路径 | 🔲 待实施 | 尚无独立 `decision` 模型角色、决策协议适配器或 Admin/用户决策模型设置。 |

## 1. 背景与目标

### 1.1 背景

咕咕已有确定性 RAG 评分和能力目录推荐，但语义相关性判断仍由固定规则或主 LLM 在后续推理中完成。拟增加一个独立的决策模型角色，在有界候选集上输出结构化评分或选择，分别用于：

1. **RAG 最终筛选**：BM25 / hybrid 负责高召回候选；决策模型在召回候选中评分/选择；系统按决策结果和注入预算提供最终证据上下文。
2. **工具与 Skill 预选择**：每个用户 Run 准备阶段根据本轮输入、必要对话上下文和授权能力快照，选择要直接提供给主 LLM 的工具 Schema、Skill 正文，或不预注入；主 LLM 仍负责规划、生成工具参数、执行工具并处理结果。

决策模型是受约束的语义判断组件，不是第二个 Agent、Planner 或执行器。两种场景共享决策模型角色、凭据解析、Provider 协议适配和观测基础，但各自拥有独立的候选构造、策略、阈值和验收指标。

### 1.2 目标

1. 在 Admin Agent 配置和用户模型设置中提供与主 LLM、Embedding 分离的 `decision` 模型角色；首个正式适配器支持 TypeSafe System One API / Jev，模型能力由后端声明，不把决策 API 当作聊天补全接口。
2. 让 RAG 决策模型真正看到 BM25 / hybrid 排序后的、有权限且尚未被最终 Top-K 截断的候选池，再产出最终评分/选择；保留现有确定性评分作为基线与故障回退。
3. 在工具简介/固定 Adapter 模式中提前选择能力，并在主 LLM 首轮注入本轮选中的完整 Schema 与 Skill 正文，减少按需发现往返；全量 Schema 模式可选择只做软排序/观察，避免误称已经节省 Schema 获取调用。
4. 权限、工具注册、执行器、确认门、RAG owner/scope 校验和内容预算仍由现有代码决定，决策输出永远不能扩权或直接触发副作用。
5. 提供按场景独立的继承、关闭、Shadow 与 Active 策略；只有在离线评测和受控启用结果满足验收门槛后，才允许 Active。
6. 最小化发给外部决策服务的用户数据；未经明确配置/启用，不发送私有查询、RAG 正文、对话历史、工具描述或 Skill 内容。

### 1.3 非目标

- 不让 Jev 生成自由文本、最终回答、工具参数或可执行代码；不以 Jev 替代主 LLM。
- 不让决策模型修改工具注册表、用户授权、群/项目 ACL、危险操作确认门或执行结果。
- 不替换 BM25、Embedding、RRF、索引、来源 Adapter 或现有 TS RAG worker；不对全量知识库逐条询问决策模型。
- 不让工具选择模型读取完整工具 Schema 或 Skill 正文；候选判断只使用经授权的短描述和必要上下文。
- 不要求所有用户配置 Jev，也不因开启一个场景自动开启另一场景。
- 首版不建立通用自动 Planner、不对内部每个工具 Round 重复运行预选择、不做模型自我训练。
- 不把 TypeSafe 官方示例中的效果数字、延迟或概率阈值作为咕咕的质量承诺或生产默认值。

## 2. 功能需求

### FR-LLM33-01：独立决策模型角色与场景策略

决策模型作为独立能力角色 `decision`，与 `llm`、`embedding`、`speech_to_text` 等现有模型用途隔离。Admin 可配置平台决策模型默认值、允许的 Provider、可用模型与全局策略上限；用户可选择继承平台设置、关闭，或配置自己的决策模型凭据与模型。用户侧设置按用途分别控制：

- `rag_final_selection`：RAG Top-K 候选最终评分/选择；
- `tool_schema_selection`：本轮工具 Schema 预选择；
- `skill_preload`：本轮 Skill 正文预选择。

每个用途分别支持 `inherit`、`disabled`、`shadow`、`active`。用户不得绕过 Admin 的 Provider 白名单、隐私策略、请求预算和最大候选数量。默认不对全体用户启用外部决策请求；首次启用外部服务前，界面需说明会发送的输入类别和服务方。

### FR-LLM33-02：决策 Provider 协议与结构化结果

决策 Provider 通过独立协议适配层接入，不复用聊天 Provider 的 `complete()`、原生函数调用或 JSON 文本解析作为默认契约。首版 TypeSafe 适配器使用 System One 请求/响应：输入为结构化 `state` 与命名 `questions`，输出为按 question key 对应的 Noul / Score / Choice 结果和用量信息。

内部统一结果至少包含：决策用途、模型与协议版本、候选稳定 ID、候选分数/选择值、置信信息、请求用量、耗时和错误分类。Provider 能力元数据声明支持的题型、请求约束及限制。Choice 只用于单项有限选择；多个 RAG 文档或多个工具/Skill 的多选策略必须使用逐候选分数/二元判断或 Provider 明确支持的多选契约，不能把单选误当多选。

适配层返回的候选 ID 必须在本次输入候选集合内；未知、重复、缺失或类型不符的结果按无效决策处理，并触发场景回退。不能把 TypeSafe 的类型约束解释为语义结果不会出错。

### FR-LLM33-03：RAG 候选最终评分/选择

当 `rag_final_selection` 为 Shadow 或 Active 且决策模型有效时，RAG 按以下顺序处理：

1. 先按现有来源、scope、owner 和查询约束执行 BM25 / hybrid 候选召回与融合；候选来源与既有确定性分数保留。
2. 在将正文发送给外部决策 Provider 前，由可信 Python 层完成 owner/scope 复核；越权候选不得进入决策请求。
3. 将有界候选池交给决策模型评分或选择。候选包含稳定 ID、必要来源元数据与裁剪后的正文片段；不发送无关用户字段或完整历史。
4. 代码验证结果后，根据场景化的、可版本化的阈值/策略、来源限制、去重、多样性及字符/token 预算确定注入内容。决策分数不是权限分数、事实可信度或 citation。
5. 注入前再次执行 Python owner/scope 和来源 ID 复核；保留来源引用映射，确保回答引用仍指向正确的原始对象。

必须区分 `candidate_pool_limit` 和 `injection_limit`。RAG worker 不得先按最终注入数截断，再把剩余少数候选送给决策模型。worker 应提供稳定、受权限约束的过取结果或等价的两阶段契约；过取池仍受硬上限保护。显式搜索、精确对象读取和非自动 RAG 路径不受本功能改写。

评分/Noul 模式可选择多条证据；Choice 仅用于确实只应选一个候选的有限选择场景。Active 策略必须允许“无合格候选”，同时通过最低/最高注入数与确定性回退策略避免模型偶发误判造成空上下文或超预算。

### FR-LLM33-04：每个用户 Run 的工具 Schema 预选择

在每个新的用户 Run 准备阶段，系统根据本轮用户输入、为解析指代所必需的有限历史摘要/待确认状态，以及当前授权能力快照进行一次预选择。选择出的工具必须来自当前授权 Registry / MCP 快照；决策输入仅含候选稳定 ID、短描述、类别和最小必要关系信息，不含完整输入 Schema、密钥或工具返回内容。

在简介/固定 Adapter 模式下，Active 结果将选择的具体工具完整规范 Schema 加入本轮 Provider 可见工具集合，并将其映射到现有工具名和 Dispatch；保留固定发现 Adapter 作为低置信、漏选或任务变化时的补取恢复通道。全量 Schema 模式不得因 Shadow 结果删去任何现有 Schema；后续只有明确启用 Active 策略后才可基于任务选择裁剪 Provider Schema，并必须满足漏选与恢复测试。

选择结果只对当前 Run 有效，不跨 Run 复用授权结论。每个用户 Run 只执行一次预选择；仅当授权快照变化、选中能力不可用、主 LLM 明确缺少能力，或用户任务发生实质变化时，才允许按受限策略重新选择。工具执行仍通过现有 Registry/Dispatch、Schema 输入验证、危险操作确认门与权限校验。

### FR-LLM33-05：每个用户 Run 的 Skill 预选择与正文注入

Skill 候选先由已授权、已固定的 Skill metadata 快照限定。决策模型只读取 Skill 名称、短描述、相关工具摘要和本轮最小必要上下文，不读 Skill 正文。Active 选中的 Skill 正文由现有受信加载路径读取，在大小预算内注入本轮主 LLM 上下文，并标记为本轮已加载，避免主模型重复调用 `use_skill` 获取同一正文。

支持 `none`，且允许多个 Skill 的策略必须使用多候选相关性结果。未选中的 Skill 仍可通过现有 `use_skill` 恢复路径按需加载；选中 Skill 的关联工具仍须通过授权快照和工具选择/当前模式提供，Skill 不能自行赋予工具权限。

Skill 正文只在 Run 内使用，不写入长期 session snapshot、日志或决策缓存；若内容在准备期间发生变化，必须使用本轮所读取版本并绑定 digest，避免诊断与实际注入不一致。

### FR-LLM33-06：Shadow、Active、失败回退与可恢复性

- `disabled`：不请求决策 Provider，完全保持当前行为。
- `shadow`：实际调用决策 Provider 并记录脱敏决策元数据，但不改变 RAG 注入结果、Provider 工具 Schema 或 Skill 正文注入；Shadow 必须由平台/用户显式启用，计入时延和费用预算。
- `active`：只有该用途单独启用且配置有效时，决策结果才影响注入；关闭或无有效配置时使用当前确定性实现。
- 超时、Provider 错误、无效输出、低置信度、超过候选/输入/费用上限时，必须执行对应场景原行为回退，不让用户 Run 失败，不静默注入空 RAG 或禁止全部工具/Skill。
- Tool / Skill Active 仍保留按需发现恢复口；RAG Active 保留现有确定性排序与过滤回退。回退原因进入脱敏诊断，不存原始异常响应正文。

### FR-LLM33-07：隐私、凭据与数据最小化

Admin 设置的系统 Provider 凭据只存于现有安全配置/密钥管理边界；用户决策模型凭据使用加密凭据存储，新增 `decision` capability 时沿用现有 BYOK 的密钥生命周期和访问控制。凭据不得进入 URL、日志、决策 state、前端明文回显或 Provider 错误文案。

所有发往决策 Provider 的请求必须经过用户配置、Admin 策略和场景开关的共同判定。请求仅携带该次判断必需内容：RAG 场景发送候选片段；工具/Skill 场景发送候选短描述与必要的指代上下文。不得发送整段会话、未选中 Skill 正文、完整工具 Schema、附件原文或其他候选用户数据，除非具体场景在用户启用页明确披露并经评审批准。

日志与 LoopScope 只记录场景、Provider/model 版本、候选数量、稳定 ID 的不可逆 fingerprint、各候选得分/选择、有效性、延迟、用量、回退原因和策略版本；不记录用户输入、RAG 正文、Skill 正文、工具参数、凭据或原始 Provider body。错误经过统一脱敏；必要原始诊断遵循现有受限诊断通道。

### FR-LLM33-08：观测与效果评估

RAG 与工具/Skill 使用独立评估集、Shadow 对比和 Active 指标，不得用其中一项的成功替另一项放行。观测至少覆盖：

- RAG：Precision@K / Recall@K 或证据覆盖率、误注入率、漏掉必要证据率、空上下文率、回答质量/引用有效率、注入 token、P50/P95 额外延迟、请求数与费用。
- Tool / Skill：能力 Top-K 命中率、漏选率、错误/不必要注入率、工具 Schema / Skill 重复获取次数、Provider 往返数、参数验证失败率、工具执行成功率、任务完成率、输入 token、P50/P95 额外延迟与费用。
- Provider 决策：无效输出率、超时/限流率、回退率、版本与策略分布；不以平均分数或供应商自报指标替代业务结果。

Active 的启用门槛必须由咕咕基线评测冻结：相较当前实现不得突破预先批准的任务质量非劣界限，并需证明调用/Token/延迟/费用目标至少一项有实际改善且其他预算无不可接受回归。具体数值以唯一实施 TODO 中的离线评测产物记录；未建立基线时不得全局 Active。

## 3. 技术方案

### 3.1 职责边界

```text
Admin / 用户决策模型设置
          ↓ 按场景解析有效配置与凭据
Decision Provider Adapter（独立于聊天 Provider）
          ├─ RAG：授权 Top-K → 最终评分/选择 → 确定性预算与过滤 → Python 最终复核 → 注入
          └─ 能力：授权 Snapshot → 工具/Skill 候选选择 → Schema/正文注入 → Agent Loop
                                                                    ↓
                                               Registry / Dispatch / 确认门 / 执行器
```

RAG 与能力选择可复用 Decision Provider 请求适配、凭据解析、超时/预算守卫和标准观测对象；不要把两个场景揉成单个“总控决策”或共享一个无法区分语义的阈值策略。Provider 输出只产生本次候选选择，不改变安全事实源。

### 3.2 配置解析与生效优先级

每种场景单独解析：用户显式关闭 > 用户配置并启用的 BYOK > 用户继承时 Admin 显式默认；其余情况关闭决策调用并回到当前流程。Admin 可限制 Provider/模型和最大资源预算，但不得以 UI-only 方式信任客户端传来的 `active`、任意 Provider URL 或未授权模型名。

决策 Provider 有独立接口/能力声明，包括协议版本、题型、最大候选/问题数、最大 state 长度、请求超时和允许的模型。不能只凭 `provider=openai-compatible` 推断它支持 System One，也不能使用主 LLM API 的连接测试代替决策端点测试。首版适配 TypeSafe 官方 System One API；其他决策服务只有在声明并通过契约测试后接入。

### 3.3 RAG 候选池与最终注入

在 `UnifiedQueryRetriever` / TS worker 边界区分检索过取和最终注入参数。候选池须保持稳定 ID、source/scope、原始与融合排序信息；Python 在外发前对候选做权限复核。决策模型只在候选池上做语义判断，不负责检索或授权。Active 决策结果与现有确定性 score、过滤原因、内容预算共同生成最终选择；策略和版本可被复现，阈值通过离线集校准而非硬编码供应商概率。

若当前 worker 无法提供可供 Python 决策的扩展候选，增加受限 `candidate_limit` 或两阶段候选接口；不得通过简单增加最终 `limit` 破坏最大正文预算、来源多样性、父文档约束或 IPC 负载。Python 最终 owner/scope 复核仍保留在决策之后。

### 3.4 工具 / Skill 选择与注入

在 `prepare_agent_run` 的 Run 准备边界构造一次能力候选决策。输入的候选只来自当前 `CapabilitySnapshot` 授权结果；输出需映射回既有稳定工具名/Skill slug。全量 Schema 模式和简介/固定 Adapter 模式分别适配，不重建注册系统。

Active 下，简介模式把选中工具的 canonical `input_schema` 暴露给 Provider，并保持工具事件、Provider tool name 与 Registry Dispatch 一致；Skill 正文经 `load_skill` 受信路径读取后只加入当前 Run。发现入口继续可用，低置信或漏选时由现有 Agent Loop 按需补取。禁止决策模块直接调用 handler、MCP server 或危险操作。

### 3.5 Shadow 与会话缓存

Shadow 不能复用或持久化含原始用户内容的结果缓存。若缓存去重是实现必需项，只能用用户隔离的 query/candidate fingerprint、model version、policy version 和授权快照 revision 作为键，并设置短 TTL；候选正文或输出的多租户混用不可接受。

动态注入优先保持系统提示词和静态 Registry 前缀稳定；本轮决策结果与动态正文放置在稳定前缀之后。不能声称 Prompt Cache 一定命中，需在实际 Provider 请求中测量缓存读取率与 token 成本。

### 3.6 文件范围

```text
backend/
├── agent/
│   ├── decision/                         【新增】通用决策请求/结果、策略与 Provider 适配边界
│   ├── rag/service.py                    【修改】输出有界过取候选并串联最终决策与回退
│   ├── rag/batch_retriever.py             【条件】若 worker 参数需从 Python 扩展则修改
│   ├── capabilities/selector.py           【修改】添加模型决策策略；保留 Registry/RAG 现有策略
│   ├── capabilities/injector.py           【修改】将决策选择映射到现有 Schema/Skill 注入方式
│   └── run/preparation.py                 【修改】按用户 Run 解析配置并执行一次场景选择
├── ts/workers/rag/src/                    【条件】仅在当前 worker 不能暴露独立候选池时修改
├── app/
│   ├── byok/                              【修改】增加独立 decision capability 的校验、解析和密钥隔离
│   ├── api/v1/                            【修改】Admin/用户模型设置与决策连接测试 API
│   ├── core/config.py                     【修改】平台默认值、Provider 白名单与资源预算
│   └── models/ + alembic/versions/        【条件】仅当现有凭据 capability/schema 不能存储 decision 时调整
└── tests/                                 【新增/修改】协议、策略、权限、回退和端到端行为测试

frontend/src/
├── components/common/profile/ProfileByokPane.vue  【修改】用户决策模型配置和逐场景开关
├── views/Admin/Agent/                              【修改】平台默认模型与策略控制
└── i18n/                                           【修改】中文、英文、日文文案
```

关键边界：Admin 页面遵循 Admin 前端拆分约定，新增配置优先进入独立组件/composable/service；不把外部决策请求放进通用聊天 Provider 的 `complete()`；不修改业务 Registry/执行器以接受模型输出的任意能力名；不增加原始内容观测表或日志。TS worker 仅在需要提供过取候选接口时纳入本 PRD，索引 schema 和索引写入流程不变。

## 4. 验证与上线

- **协议契约**：Mock/契约测试覆盖 Noul、Score、Choice 映射、候选 ID 校验、超时、限流、无效结果、脱敏错误、费用/输入上限；验证聊天 Provider API 与决策协议不会混用。
- **RAG 行为**：在权限隔离的固定评测集上，对比当前确定性注入与候选决策注入；覆盖 BM25-only、hybrid、有冲突证据、低分候选、无候选、重复父文档、越权候选被拒绝、决策失败回退和预算截断。验证候选池在进入决策前未被最终 Top-K 提前截断。
- **工具 / Skill 行为**：覆盖无需能力、单工具、多工具组合、多个 Skill、用户确认“继续/照做”等指代上下文、错误建议、无候选、授权变化、MCP 动态 Schema、全量模式与简介模式；验证用户可通过原有发现入口恢复未注入能力，确认门和 Dispatch 结果不变。
- **隐私与权限**：断言未授权候选不会离开本机；日志/LoopScope/错误响应不包含用户消息、候选正文、Skill 正文、Schema 参数值、凭据或原始上游响应；并发用户凭据互不串用。
- **性能和成本**：离线评测与显式启用的 Shadow 分别统计端到端 P50/P95、Provider 往返、输入 token、请求数和费用。Shadow 不得用于声称线上变快。
- **回归命令**：后端相关 Agent/RAG/Provider/BYOK 测试、前端 `npm run typecheck:strict`、i18n 扫描及相关组件测试；worker 有改动时同时运行 worker 单测和构建。
- **上线方式**：按 Admin 全局允许 → 单一内部用户/测试用户 → 小流量 opt-in → 按用途逐步 Active；RAG 与 Capability 独立开关。未通过用途对应质量门槛时只保留 disabled/shadow，不影响常规聊天。
- **回滚**：任一用途设置为 disabled 后立即停止该场景决策请求并回到当前确定性 RAG 或当前工具/Skill 注入方式；保留配置和诊断用于分析，不要求回滚数据库数据。涉及新增凭据字段的迁移保持向后兼容。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 决策模型语义误判或漏选 | RAG 证据遗漏；主模型缺少必要工具/Skill | 使用离线基线和 Shadow；低置信回退；保留工具/Skill 按需发现；RAG 有确定性回退及最低证据策略。 |
| worker 已按最终 Top-K 截断候选 | 决策模型无法发现已被提前丢弃的好候选 | 明确拆分过取 `candidate_pool_limit` 与最终 `injection_limit`，端到端测试证明候选池可达。 |
| 决策请求增加端到端延迟、成本 | 简单聊天可能变慢，Shadow 也实际消耗资源 | 每用途独立启用、限制输入与请求预算；离线先测；只在评测证明净收益后 Active。 |
| 私有查询、RAG 正文外发 | 隐私和数据合规风险 | 明确 opt-in、最小化 state、Admin Provider 白名单、凭据隔离、内容不落日志；可关闭并立即回退。 |
| 动态 Schema / Skill 注入不匹配授权快照 | 未授权暴露或执行工具与模型可见 Schema 不一致 | 先授权后选择；稳定 ID 与快照 revision 校验；Dispatch 最终复核；选择失效时拒绝直注并走安全回退。 |
| 决策概率跨版本/问题不可直接比较 | 阈值沿用后筛选质量漂移 | 策略与模型版本化；阈值按具体任务评估；模型升级后 Shadow 复测。 |
| 外部决策结果被日志或缓存保留 | 用户内容泄漏、用户间串数据 | 只存不可逆 fingerprint 和脱敏统计；缓存默认关闭，若启用则按用户/版本/授权快照隔离并设 TTL。 |

待确认问题：无阻塞性产品问题。首版仅将 TypeSafe System One 作为首个协议适配器；全局 Active、概率阈值与过取大小必须由唯一实施 TODO 的基线评测产物决定，不在本 PRD 预设供应商示例数值。

## 6. 唯一实施 TODO

### Phase 0：基线与决策契约

- [ ] `LLM33-001` 建立 RAG 与工具/Skill 两套离线评测集、标签规范和当前实现基线；验收：报告分别给出质量、漏选/误选、token、往返次数、P50/P95、请求量/成本指标，样本不包含可识别用户的真实私有内容。
- [ ] `LLM33-002` 定义 Decision Provider 接口、类型化结果、错误/回退契约和 Provider 能力描述；验收：Noul/Score/Choice 有契约测试，候选身份只能来自输入集合，聊天 Provider 适配器不受影响。

### Phase 1：配置、凭据与 Provider 适配

- [ ] `LLM33-003` 增加 Admin 平台默认值、Provider 白名单、模型/请求预算与独立用途开关；验收：服务端强制配置限制，关闭时不产生外部请求。
- [ ] `LLM33-004` 增加用户 `decision` 凭据/模型配置及 `inherit / disabled / shadow / active` 每用途策略；验收：完整/缺省/无效凭据解析、用户隔离、加密存储与并发凭据隔离测试通过。
- [ ] `LLM33-005` 实现 TypeSafe System One 适配和连接测试；验收：请求 schema、响应类型、question limits、provider timeout、限流和脱敏错误均由契约测试覆盖，不经聊天补全端点发送。
- [ ] `LLM33-006` 接入用户设置与 Admin Agent UI；验收：用户清楚看到外发数据类别与用途独立开关，三语言文案齐全，设置保存/读取/测试通过，Admin 页面不形成新增大入口堆叠。

### Phase 2：RAG 最终筛选

- [ ] `LLM33-007` 拆分 RAG 候选过取与最终注入限制，贯通授权候选到 Python 决策点；验收：worker 端到端返回多于最终注入量的有界候选池，scope/owner 过滤、候选稳定 ID、去重和预算不变量测试通过。
- [ ] `LLM33-008` 实现 RAG 决策 Shadow/Active、场景策略和确定性回退；验收：Shadow 不改变当前注入，Active 输出通过二次 owner/scope 复核；无效、超时、无候选和低置信场景均可回退，离线结果达到预先冻结的质量非劣门槛后才允许测试用户 Active。

### Phase 3：工具 / Skill 预注入与逐场景放量

- [ ] `LLM33-009` 实现 Run 级授权工具候选预选择及简介模式 Schema 预注入；验收：每个用户 Run 默认只判定一次；多工具任务、`none`、误选、授权变化、Provider Schema 映射、确认门、Dispatch 和按需发现恢复测试通过。
- [ ] `LLM33-010` 实现 Run 级 Skill 预选择与正文注入；验收：正文仅从受信 loader 读取并限制大小；只在当前 Run 注入且绑定 digest；未选 Skill 可按需加载；没有工具权限扩张或正文持久化。
- [ ] `LLM33-011` 完成端到端 Shadow/Active 评估、隐私与性能复核及上线回滚验证；验收：两种用途分别达到批准的非劣/收益门槛，日志与追踪通过敏感信息扫描，Admin/用户可独立关闭并即时回到既有实现；回填本文 §0 实际状态与本项结果。
