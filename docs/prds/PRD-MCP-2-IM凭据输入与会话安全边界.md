# PRD-MCP-2：IM 凭据输入与会话安全边界

> 状态：实施中
> 创建：2026-10-11
> 关联模块：`backend/agent/im/`、`backend/agent/interactions/`、`backend/agent/tools/mcp.py`、`backend/app/services/interactions.py`、`backend/app/services/mcp_credentials.py`、`backend/app/api/v1/agent.py`、`frontend/src/components/common/gugu-chat/`
> 前置能力：`docs/prds/PRD-MCP-1-MCP工具接入.md` 中的用户级 MCP server、凭据槽位和 secret prompt

## 1. 背景与目标

当前 `manage_mcp_servers` 在新增或更新 MCP server 时可以创建 `secret_fields` 交互。网页聊天有密码表单，IM 则只发网页入口提示。用户希望在 IM 中也能直接提交凭据，同时不把明文写入咕咕自己的聊天历史。

本 PRD 将网页与 IM 视为同一凭据能力的不同输入入口：入口负责交互，服务端统一做归属校验、字段校验和加密保存。IM 平台可能保存或展示用户发送的消息，这是平台侧行为；咕咕不承诺删除或控制平台副本，但必须保证凭据明文不进入咕咕的持久会话数据、模型上下文和日志。

### 1.1 目标

- Owner 可在 IM 一对一会话中选择“输入凭据”或“取消”，随后直接发送凭据值。
- IM 凭据提交被专用路径截获，不作为普通聊天消息处理，不调用 Agent/LLM，不写入咕咕会话历史。
- Web 的密码表单继续可用；用户在 Web 恢复 IM 群会话时也允许从私密 Web 表单提交凭据。
- 网页与 IM 最终调用同一业务消费服务，保证凭据归属、字段校验、加密方式和完成状态一致。
- 群聊中的 IM 消息不得开启或消费直接凭据输入状态。

### 1.2 非目标

- 不控制 IM 平台是否保留聊天消息、通知预览或备份，也不承诺从平台删除消息。
- 不把密钥发送给模型、MCP server 以外的第三方或其他会话参与者。
- 不改变 MCP 工具的授权、调用确认、server CRUD、endpoint 安全校验及凭据主密钥体系。
- 不把群聊中的直接密钥输入作为支持场景；群会话需由用户转到 Web 私密表单或私聊 Bot 完成。

## 2. 用户流程与交互

### 2.1 IM 一对一输入

1. 咕咕创建并持久化一个有时效的凭据交互，提示需要哪些字段，但不包含字段值。
2. IM 显示“输入凭据”和“取消”选项。平台不支持原生按钮时，使用等价文本选项。
3. 用户选择“输入凭据”后，咕咕进入一次性输入状态，并提示当前字段名/标签；用户逐字段发送值。每条输入仅允许匹配当前用户、Bot、私聊会话和该 prompt。
4. 输入状态中用户可发送“取消”终止本次输入；取消命令本身只作为状态转换消费，不传给 Agent。
5. 服务端收到每个字段后立即校验并加密暂存明文；不把明文写入 `ConversationMessage`、prompt 结果、tool result、LoopScope 或应用日志。
6. 所有必填字段收齐后，服务端一次性更新 MCP 凭据槽位、消费 prompt 并恢复原 Run。对话只收到不含值的“凭据已保存”状态。
7. 用户取消、交互超时或校验失败时，清除该 prompt 的密文暂存和输入状态；已有凭据不被部分覆盖。

如果只有一个字段，仍走同一状态机，不另设简化的普通消息通道。

### 2.2 IM 群会话

- 从群消息入口点击“输入凭据”或直接回复凭据时，服务端拒绝启动/消费 IM 凭据输入状态，并提示“群聊不接收凭据，请在网页私密表单中填写或改用 Bot 私聊”。
- 群内普通消息不得被猜测为凭据，也不得进入 secret handler。
- 即使 prompt 所属 `ConversationSession.chat_type == group`，也不能仅凭会话类型拒绝 Web 表单提交。

### 2.3 Web 恢复 IM 群会话

- 用户在已登录的 Web Guguchat 中打开同一条 IM 群会话时，secret prompt 正常显示密码输入表单，并可通过现有认证 API 提交。
- Web 提交依据当前登录用户、prompt 所有权和 MCP server 所有权授权；会话的来源平台或 `chat_type=group` 不构成拒绝理由。
- 密码表单提交不调用普通聊天发送接口，不产生新的群消息，不把明文追加到 Web 对话内容。
- “Web 上提交”与“IM 群内发消息”由请求入口区分，不能只用 prompt 的原始会话类型判断。

## 3. 功能与安全需求

### FR-MCP2-001：双选项与取消

凭据 prompt 必须提供“输入凭据”和“取消”。取消为幂等操作，立即关闭 prompt、清除该 prompt 的输入状态与密文暂存，不修改现有 MCP 凭据。过期、重复回调、重复 webhook 事件均不得重复消费或恢复 Run。

### FR-MCP2-002：IM 一对一消息拦截

IM loop 必须在普通消息持久化、被动群消息记录、快捷命令、Agent/LLM、RAG、反思及会话广播之前检查待处理凭据交互。只有明确处于凭据输入状态且身份、Bot、平台和私聊会话完全匹配时才消费消息；否则按既有消息策略处理。

凭据消息不得作为群上下文、成员记忆、长期记忆或普通 ask_user 自定义答案写入任何咕咕历史。拦截成功后只发送不含密钥的状态反馈。

### FR-MCP2-003：字段完整性与原子替换

- 每个 prompt 只接受其声明的字段名；必填字段缺失、超长、格式非法或额外字段均不得完成提交。
- 多字段采用逐字段输入；暂存数据在持久化前必须加密，并绑定 `user_id`、`server_id`、`prompt_id`、平台会话身份和过期时间。
- 全部字段验证完成前不得覆盖已有凭据。完成时在单个业务事务中原子更新最终凭据并消费 prompt；失败或取消时保留旧凭据。
- 密文暂存达到 TTL、prompt 过期、server 被删除或用户归属失效时必须清除；只保存状态和字段进度等非敏感元数据。

### FR-MCP2-004：统一业务消费与加密

Web 与 IM 最终都调用 `mcp_credentials` 的同一业务提交服务：验证 prompt 当前有效、用户拥有 prompt、prompt 绑定的 MCP server 属于该用户、字段集合匹配；使用现有凭据加密机制写入 MCP credential slots。任何入口不得自行实现另一套加密或归属判断。

### FR-MCP2-005：Web 表单与群会话兼容

保留 Web `type=password` 表单。Web API 以登录用户与 prompt/server 所有权为授权依据，不能因原始 IM 会话是群聊而禁用。Web 提交使用独立 secret endpoint，不经普通 `resume-text` 或聊天发送入口。

### FR-MCP2-006：无明文日志及模型路径

凭据明文不得进入：

- `ConversationMessage`、`InteractionPrompt.schema_json.resolved_result`、工具调用/返回历史；
- LLM 请求、RAG、LoopScope、SSE/会话广播、审计日志和应用可见日志；
- 错误消息、重试文本、异常上下文或诊断编号关联数据。

诊断仅可记录 prompt/server 的非秘密 ID、字段数量、阶段、结果码和耗时。不得记录凭据值、消息原文或可逆编码。

### FR-MCP2-007：并发与重放安全

同一 prompt 只允许一个输入状态和一次成功提交。状态转移应通过持久化原子条件或锁实现；重复 webhook 事件、并发字段消息、并行 Web 提交或取消/提交竞争最多产生一次凭据更新。状态不明时 fail-closed，不把消息降级成 Agent 输入。

## 4. 状态模型与数据映射

| 状态/数据 | 来源 | 持久化 | 用途/约束 |
|---|---|---|---|
| `prompt_id` | MCP secret prompt | 已有交互记录 | 唯一定位待完成交互，不单独作为授权凭据 |
| 用户、MCP server、字段定义 | 已有 prompt context 与 server 记录 | 已有数据库 | 服务端重新校验所有权，不信任 IM 消息携带的身份 |
| IM 平台、Bot、私聊 ID、平台用户 ID | 归一化 IM 事件 | 仅保存必要的绑定元数据 | 必须与 prompt 发起身份一致；群事件拒绝 |
| 输入模式/字段进度/过期时间 | 新的 secret input 状态 | 持久化非敏感状态 | 一次性、短时、可取消；不能存明文 |
| 未完成字段值 | IM 单条入站消息 | 仅内存短暂处理后加密暂存 | 明文不得落库、记录日志或经过 Agent；密文暂存有 TTL |
| 完成凭据 | 已校验字段 | 现有 MCP 凭据槽位密文 | 使用既有 envelope 加密机制；整体原子替换 |
| 完成/取消结果 | 交互状态机 | 仅状态与结果码 | 对话只显示“已保存/已取消/已过期”，不包含值 |
| Web 凭据提交 | 登录态 Web 表单 | 现有 secret API + MCP 凭据表 | 允许恢复群会话；以认证用户和资源所有权授权 |

不得把 IM 平台的聊天历史视为咕咕可控制的数据存储。咕咕承诺范围仅为自身数据库、缓存、日志、模型上下文和内部事件总线。

## 5. 文件变更清单（实施预估）

以下为计划范围，实施前需按现有接口复核；若能复用现有模块，不为满足文件列表而新增重复抽象。

| 文件/目录 | 变更 | 目的 |
|---|---|---|
| `backend/agent/tools/mcp.py` | 修改 | 凭据 prompt 增加输入/取消交互选项，明确只提供字段元数据 |
| `backend/agent/im/loop.py` | 修改 | 在普通消息处理和持久化前接入专用 secret input 消费路径 |
| `backend/agent/im/interaction_text.py` 或 `backend/agent/im/secret_input.py` | 修改/新增 | 绑定 IM 一对一身份、消费一次性字段输入、处理取消/超时/重放 |
| `backend/agent/interactions/qq.py` 及共用 IM interaction renderer | 修改 | 为各 IM 适配器输出一致的“输入凭据/取消”交互与安全降级文案，不回显值 |
| `backend/app/services/interactions.py` | 修改 | 增加 secret prompt 状态转换、取消/过期与一次性消费，不复用普通 `consume_text` 明文结果语义 |
| `backend/app/services/mcp_credentials.py` | 修改 | 暴露 Web/IM 共用提交服务，执行 ownership 校验、字段验证和原子凭据更新 |
| `backend/app/models/` + Alembic migration | 视暂存实现决定 | 若现有交互表无法承载密文暂存与 TTL，新增仅密文的待提交字段/记录；不得存明文 |
| `backend/app/api/v1/agent.py` | 修改 | 保持 Web secret endpoint 使用共用服务；校验登录用户，不根据原始 group session 拒绝 |
| `frontend/src/components/common/gugu-chat/GuguChatInteraction.vue` | 修改 | Web 表单显示输入/取消操作和状态，秘密值成功/失败后清空输入 |
| `frontend/src/components/common/gugu-chat/GuguChat.vue` | 修改 | 通过独立 secret endpoint 提交，不走普通文本恢复；深链应定位 prompt 所在 Web 会话（如本次范围内完成） |
| `backend/tests/agent/im/` | 新增/修改 | IM 私聊输入拦截、群聊拒绝、重复事件、明文不落历史/日志 |
| `backend/tests/agent/mcp/`、`backend/tests/app/services/` | 新增/修改 | 字段暂存加密、原子更新、取消/过期、ownership 与并发竞态 |
| `backend/tests/` API tests | 修改 | Web 恢复群会话允许提交；跨用户/跨 server prompt 拒绝 |
| `frontend/src/components/common/gugu-chat/` component tests | 新增/修改 | Web 密码表单提交、取消、过期及清空值行为 |
| `docs/prds/PRD-MCP-1-MCP工具接入.md` | 修改 | 链接本 PRD，并更新“自助管理 MCP 配置”对 IM/Web secret input 的能力状态 |

### 5.1 数据库影响

- 优先复用现有 `InteractionPrompt` 生命周期和 MCP credential slot，不复制 server 配置，也不改变凭据主密钥格式。
- 如需暂存多字段提交，只能增加密文与 TTL 元数据；不得在 migration、JSON schema 或日志中引入明文字段。
- migration 必须能清除过期/孤立的 staging 数据；降级仅删除新增暂存结构，不影响现有 MCP server 与已保存凭据。
- 若实现评估发现无法以可维护方式建立密文暂存，应将 IM 直输收窄为单字段 prompt；多字段仍走 Web 表单，并在实施前更新本 PRD，不得退化为明文暂存。

### 5.2 Phase 0 现状核对与实施决策（2026-10-12）

代码核对结果：

- `manage_mcp_servers` 已创建带 `secret_fields` 与 `secret_target` 的 `ask_user` prompt；`create_agent_prompt` 将字段定义和 MCP server 目标保存在 `InteractionPrompt.schema_json`，不包含凭据值。prompt 创建时会取消同一 session 里原有的 active prompt。
- Web 已有独立 `POST /agent/interactions/{prompt_id}/secrets`。API 以当前登录用户查询 prompt，`consume_mcp_secret_prompt` 再校验 prompt 状态、字段集合与用户拥有的 MCP server，使用既有 envelope 加密更新 credential slots，并只写入不含值的完成结果。当前没有按群聊类型拒绝 Web 提交的检查。
- IM 交互渲染遇到 `secret_fields` 时只发送网页入口提示；QQ/飞书按钮和 IM 文本选项目前统一走普通 `consume_action` / `consume_text_choice`，会按普通选项语义结束 prompt，不能直接复用为凭据输入状态转换。
- `dispatch_im_message` 在普通持久化、被动群记录、快捷命令和 Agent 执行前消费文本选项，但媒体接入发生得更早。凭据拦截必须在媒体副作用及所有普通消息路径之前完成；附件消息不能作为凭据字段输入。
- `ConversationSession` 已保存 `source`、`bot_id`、`chat_id`、`chat_type`，私聊会保存 `platform_user_id`，群会话则以 `chat_id` 标识且不保存群成员身份。IM 回调可提供平台操作者身份，但现有 QQ/飞书通用动作消费路径没有将平台操作者和会话作用域一并校验到 prompt。
- 现有 prompt 和 action 有有效期及单次 token；没有凭据 staging 模型或过期清理任务。会话删除可通过 prompt 外键级联清理，但 MCP server 目标目前只存在 JSON context 中，不具备数据库级联关系。
- Web 密码表单及 secret endpoint 已独立于普通聊天发送；前端没有消费 `/` 上的 `mcp_credential_prompt` 查询参数的逻辑，因此 IM 链接当前不能保证定位并打开对应 prompt。

实施决策：

1. 增加一张以 `prompt_id` 唯一关联的密文 staging 表，使用现有 envelope 加密完整字段 map；表中只放服务端校验所需的 user/server/session 与 IM 作用域绑定、状态、字段进度和过期时间。正式凭据只在字段齐备后一次写入。staging 对 prompt 和 MCP server 建立级联外键；另提供可重复执行的过期/孤儿清理服务，由现有 Worker 周期任务调用，并在 prompt 取消、替换、server 删除时同事务清除。
2. 由共享 secret 状态服务负责启动、逐字段暂存、取消、过期、最终提交和幂等消费；使用数据库行锁与条件状态更新约束多 Worker/重放竞争。Web 即时提交和 IM 多字段暂存最终调用同一个 MCP 凭据提交函数，并由入口拥有事务提交权，确保凭据更新、prompt 终态和 staging 清理同事务完成。
3. 只允许 prompt 创建时绑定的 owner 私聊启动/消费 IM 输入。绑定使用 prompt 对应 session 的平台、Bot、私聊用户、chat 类型和 session 标识；群聊在创建 IM 输入态之前拒绝。平台 callback 需验证动作操作者与原始私聊作用域，文本降级需在普通选项消费前走同一状态服务。附件/非文本事件不作为字段值。
4. Web 允许直接提交 pending/awaiting 的 secret prompt，不按历史 session 的 `chat_type` 拒绝；Web 取消与 IM 取消复用同一取消状态转换。IM 群消息只提供安全的 Web/私聊说明，不创建可消费的 IM staging。
5. 恢复原 Run 时只回填固定的成功/取消/失败结果，不包含字段值；凭据值不得出现在 prompt schema、普通消息、Web genstream/SSE 或可见/诊断日志。错误只返回固定结果码/文案。
6. 深链只携带非授权的 prompt ID；前端需在登录并载入会话交互后定位所属 Web/IM session 并打开相应会话，真实授权仍由登录态及 prompt/server ownership 校验完成。

### 5.3 Phase 1 实施记录（2026-10-12）

- 新增 `mcp_secret_inputs`：prompt 唯一关联，绑定 owner、私聊平台/Bot/会话身份及用户级 MCP server；用户、会话、prompt、server 删除时由外键级联清理。
- 仅身份信息完整的 IM 私聊创建 staging；Web/群聊不创建可消费状态。逐字段输入使用既有 envelope 加密，完成前不写正式凭据；所有字段齐备后与 prompt 终态、staging 清密文共用同一事务提交点，Web 整表提交复用该提交点。
- 输入、取消按 DB 行锁和持久化事件 ID 去重；取消/新 prompt 替换立即清空密文。Worker 每分钟清理过期 staging，并把关联活动 prompt 置为 expired。
- `MCP2-012` 延后到 Phase 2：callback/text fallback 必须与 IM 专用消息拦截同时上线，避免按钮先被现有通用消费器解析。
- 定向验证：`tests/agent/mcp/test_mcp_settings_api.py` 与 `tests/agent/test_interaction_protocol.py` 共 57 项通过；迁移链 head 为 `20261012000004`。未运行线上 IM 手动验证，该项归入 Phase 3 验收。

## 6. 完整实施 TODO

### Phase 0：现状与边界核对

- [x] `MCP2-000` 追踪当前 `secret_fields` prompt 从工具创建、IM 输出、Web 渲染、消费、Runner 恢复到会话落库的完整链路。
- [x] `MCP2-001` 核对各 IM adapter 的一对一/群聊标识和消息回调能力，定义共用的归一化字段；确认群事件在任何 secret state 写入前被拒绝。
- [x] `MCP2-002` 选择密文 staging 的最小实现和 TTL 清理方式；评估多 Worker、Redis/DB 可用性、事务边界和并发锁，不引入进程本地单例作为唯一状态。
- [x] `MCP2-003` 确认“取消”回调和 Web 群会话 secret submit 的授权条件，不改变现有 MCP server 归属边界。

### Phase 1：共享 secret 状态机

- [x] `MCP2-010` 定义状态转换：`pending_choice → awaiting_secret → completed | cancelled | expired | failed`，所有转换幂等并有 TTL。
- [x] `MCP2-011` 实现输入状态绑定：用户、平台、Bot、私聊 ID、平台用户 ID、session、prompt、MCP server；状态不匹配时不消费为密钥。
- [x] `MCP2-013` 实现逐字段校验和加密 staging；不接受未知字段，不在持久层、日志或错误中保留明文。
- [x] `MCP2-014` 实现全部字段齐备后的原子更新、prompt 一次消费、密文暂存清除及 Run 恢复；失败时保留旧凭据。
- [x] `MCP2-015` 实现过期、取消、server 删除、用户解绑和孤儿 prompt 的密文暂存清理。

> Phase 1 不发布 IM 选项入口。`MCP2-012` 的按钮 callback 与文本降级必须和 Phase 2 的专用消息拦截一并接入；若先启用选项，旧通用交互消费器会错误地把它当普通选择消费。

### Phase 2：IM 与 Web 接入

- [x] `MCP2-012` 接入输入/取消选择及 callback/text fallback；普通 ask_user 仍走原有通用交互消费路径。
- [x] `MCP2-020` 在 IM 入口尽早拦截：QQ/飞书/微信在媒体下载和普通消息处理前，Telegram 及统一 worker dispatch 在历史写入、快捷命令、Agent/LLM、RAG 和群被动记录前。
- [x] `MCP2-021` IM 私聊支持“输入凭据/取消”；消息原文只进入专用校验与加密暂存，不走普通聊天，也不回显或广播。
- [x] `MCP2-022` 群聊不创建 IM staging，凭据 prompt 的群消息 fail-closed，并提示转 Web 私密表单或 Bot 私聊。
- [x] `MCP2-023` Web secret form/cancel 走 owner-scoped secret endpoint；按登录用户和 prompt/server 所有权授权，不因原始 session 为群聊而拒绝。
- [x] `MCP2-024` IM 提示链接只携带非授权 prompt ID；登录后按 owner-scoped API 查找所属会话并定位交互，不把 secret 或授权 token 放入 URL。

### 5.4 Phase 2 实施记录（2026-10-12）

- QQ、飞书原生 action callback 使用专用凭据消费器并校验 owner、Bot、平台操作者和私聊范围；重复 callback 作为重复事件处理。其他 IM 使用文本选项，普通 ask_user 仍由通用交互服务消费。
- 凭据消息预检位于 IM 普通消息流程之前。QQ/飞书/微信先于媒体接入；Telegram 及统一 worker dispatch 先于历史和 Agent 路径。群 prompt 的群内消息被安全拦截并提示 Web/私聊入口，不创建群凭据 staging。
- Web 凭据输入与取消使用登录态独立 API；取消支持群来源历史 session。prompt 深链只含 prompt ID，前端通过 owner-scoped session API 定位会话；prompt ID 本身不构成授权。
- 定向验证：`tests/agent/mcp/test_mcp_settings_api.py` 与 `tests/agent/test_interaction_protocol.py` 共 59 项通过；`frontend/tests/chat/GuguChatInteraction.test.ts` 共 4 项通过；前端 typecheck 与 `compileall -q app agent` 通过；`git diff --check` 通过。全量测试及真实 IM 平台手动验收留在 Phase 3。

### Phase 3：安全与回归验证

- [ ] `MCP2-030` 行为测试：已有成功、取消、过期、错误/超长字段、多字段、重复 callback/webhook 覆盖；仍需 PostgreSQL 下的真实并发提交竞态验证（当前测试库为 SQLite，`FOR UPDATE` 不提供等价验证）。
- [x] `MCP2-031` 安全测试：覆盖群内无成员 ID 拒绝、跨用户、跨平台/Bot/操作者、群/私聊范围、跨 server staging 绑定及跨 prompt token。
- [x] `MCP2-032` 持久化断言：验证明文不进入 ConversationMessage、prompt 结果、交互历史或 IM 回复；密文暂存加密、完成后清除、过期后回收，并验证已消费 webhook 不回流普通聊天。
- [x] `MCP2-033` Web 群恢复测试：群来源 prompt 的 owner 可通过独立 Web secret endpoint 提交；其他用户无法解析或提交。
- [x] `MCP2-034` 回归 ask_user：保留并运行现有开放式回答、选择项自定义回复及 IM 交互协议测试，普通交互仍由原通用路径消费。
- [x] `MCP2-035` 运行定向 IM/MCP/交互测试和相关前端验证；失败按根因修复。
- [ ] `MCP2-036` 手动验证至少一个支持按钮的 IM 私聊、一个文本降级 IM 私聊、一个 IM 群拒绝和一个 Web 恢复群会话。

### 5.5 Phase 3 自动化复查记录（2026-10-12）

- 修复完成态 webhook 重放可能落回普通聊天的问题：短时保留的 staging 事件 ID 在新 prompt 生效期间仍优先去重，重复消息静默吞掉，不回复、不进入 Agent，也不会被下一条凭据交互误消费。
- 补充行为与安全测试：消息 dispatch 早期截断、微信媒体下载前截断、私聊/群聊路径、跨平台/Bot/操作者/会话/prompt 作用域、Web 群 session owner 提交、越权拒绝、错误及超长字段、旧凭据不被覆盖、重复 callback/webhook。
- 定向验证：后端相关测试 197 项通过；前端交互测试 5 项通过；前端 typecheck、`compileall -q app agent` 与 `git diff --check` 通过。`ripwire doc-drift` 对本 PRD 检查 26 个锚点，0 个漂移。
- 尚未完成的外部验收：当前 SQLite 测试不验证 PostgreSQL 行锁下的真实并发竞争；未连接真实 IM Bot，因此 MCP2-030 的并发子项与 MCP2-036 仍待执行。代码实现和自动化回归已完成，但在上述验收完成前不将 PRD 状态改为“完成”。

## 7. 验收标准

- IM 私聊能通过“输入凭据/取消”完成流程；密钥从接入到加密保存均不进入咕咕聊天历史、模型上下文和可见日志。
- 群聊入口不能开启或消费 IM secret state；用户在群消息中发送的普通内容不会被误认为安全提交。
- 同一群 session 在登录 Web 中恢复后，网页密码表单仍可正常提交；不会发群消息，其他账号不能提交。
- 对同一 MCP server，Web 与 IM 最终写入相同的 owner-scoped credential slots，既有凭据在取消、过期、错误字段或中途失败时不被部分覆盖。
- 并发/重复事件最多完成一次；错误响应不包含密钥、密文或原始消息。
- 测试明确区分“咕咕不持久化明文”与“IM 平台可能保存消息”；产品文案不承诺平台侧无痕。

## 8. 风险与已定决策

- **平台侧保留**：是所选 IM 入口的平台行为，不作为咕咕拒绝 direct input 的理由；咕咕仍只承诺控制自身系统的数据路径。
- **群聊禁止 direct input**：由于群成员可见是当前会话参与范围，咕咕不应将群内密钥输入当作受保护通道。
- **Web 恢复群会话允许**：授权以 Web 登录态与 prompt/server 所有权为准；入口是 Web 私密表单，不能因历史会话来源是群聊而拒绝。
- **普通 ask_user 不复用**：当前文本回答会写入 `InteractionPrompt.schema_json.resolved_result` 并回填运行记录，不能承载密钥。
- **先加密后替换**：多字段不能明文暂存，也不能逐字段提前覆盖正式凭据；需保证全量提交原子生效。
