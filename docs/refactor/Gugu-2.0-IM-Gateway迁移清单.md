# Gugu 2.0 IM Gateway 迁移清单

> 当前数据库初始化统一使用 [Database 包的编号迁移](../../packages/database/README.md)。下文中的分模块命令、手工 SQL 和升级步骤为改造期间的历史记录。

更新：2026-11-19。基线：远端 `Ningxue/n2-node-webui` 的 `f5a6b91d`；迁移分支：`Ningxue/n2-im-gateway`。Python `backend/agent/gateway/`、`backend/agent/im/` 及 pytest 原样保留。

## 状态口径

`apps/web-host/src/main.ts` 已调用 `gateway/bootstrap.ts:createNodeImHostRuntime`，装配四平台连接、IM Worker、真实生产 `resources()`、IM-only 调度、交互/延迟唤醒、出站恢复扫描和反思消费者。默认归属仍为 Python，Node 不构造这些依赖或启动消费者；本次没有执行部署切换。配置/扫码/绑定码 API 继续复用，不计作消息运行时验收。

以下分别记录“组件实现”“生产入口”“Python 行为回归”“真实平台验收”。代码接通和隔离替身回归不代表真实平台及生产部署已验收，切换仍须独立完成交接条件。

## 生产资源与入口增量

- `production-resources.ts` 从真实配置锁/PG 模型绑定组合来源、偏好与本地记忆、知识库/词法 RAG、授权 Skill、文件工具、现有 Core 工具注册器、原平台 sender、交互激活和同一 ProviderRuntime 的压缩/反思 finalizer。复用持久 Harness，不创建新 Agent 循环。Shell/MCP 等未装配工具不向模型注册，执行后端存在不等于该工具已开放。
- `production-bindings-store.ts` 加密冻结真实用量元数据，控制收尾在原事务的同一 client 读取，避免持会话行锁时重新选模而等待自己。canonical 成功历史事务登记反思 Job，反思使用独立模型生命周期，持久租约/journal/CAS 保护重试、文件写入、游标与 RAG；清空 owner 记忆须经同一围栏。
- 正式来源生成的 `providerSystemPrompt` 随 checkpoint 冻结；Provider 请求和反思恢复均采用同一 system 与权限匹配的固定快照。四协议回归验证前缀只进入请求一次，动态尾部不进入反思，恢复重建不发模型请求。
- `bootstrap.ts` 使用独立投递连接池；Node Host 用 PG 进程互斥锁、明确的 Python 停机断言和仅 IM 的调度候选保护归属。`main.ts` 提供 `/health/im` 并在退出时停止消费者、扫描和连接后释放池；数据库结构未显式迁移时启动拒绝，入口不自动 DDL。
- `host-scans.ts` 先按会话选择最早候选，再有界轮转扫描；单一会话长队列或持续 unknown 的第一页不阻塞后续会话。内存扫描水位只控制候选公平性，不推进各 Run 持久投递 cursor 或清理 unknown 收据；空页回卷后重新检查旧候选。
- `voice-config.ts` 从实际活动 voice preset 与当前 owner 的 `speech_to_text` BYOK 选择独立 ASR，不借聊天模型凭据；HTTP/重试/转码前后重验配置和权限。`voice-runtime.ts` 复用 Core OpenAI-compatible、DashScope、MiniMax 协议；主模型原生音频按真实协议能力准入，不依赖独立 ASR。未配置 ASR 为正式 `voice_unsupported` early exit，零 Provider 请求；实际空识别保留 Python 提示，大小/时长、取消、撤权及清理失败不降为空识别。
- `audio.ts` 使用有界 ffprobe 与固定解码器/协议白名单的 ffmpeg，真实生成 16k 单声道 WAV，临时文件只来自已授权字节并精确清理。`voice-transcripts.ts` 借同一 PG client 和完整密封批次 proof，只更新首个非引用 voice 卡片的消息级字幕状态；原生音频 checkpoint 仅保存稳定引用，恢复重新授权。共享 current-turn reader 已支持末条锚点一致的 `currentUsers`，语音/文字合批不再因单条契约校验失败。
- 群注意力非 autonomous 模式在评分前调用独立 ASR，增强只在内存投影中使用，原始密封消息不变。`voice-attention-source.ts` 复核完整 started 批次或 completed/passive 原段及实际平台媒体来源；被动历史只允许读取已有收据。`voice-cache.ts` 将请求前状态独立提交，结果加密绑定消息/附件、原始字节与冻结语音版本；派发事务完成原消息证明后绑定 Run，实际 Run 才能复用。unknown、版本变化、错误绑定和撤权不会再次请求 ASR。`voice-cache-schema.sql` 的两张表须显式应用，启动只检查，不自动迁移。
- 同 scope 引用语音已进入注意力预转写及 Run/历史恢复双证明，字幕只进入引用上下文。视频已接真实探测及当前协议规则；原生音频附加字幕与 sessions 卡片更新已通过隔离生产链路；HEIC 与旧默认 Python 一样明确拒绝，未把仅声明的依赖当作已存在的解码能力；真实平台仍须单独验收。
- 新增隔离 PG/Redis/Linux FS 回归只替换平台网络和 Provider HTTP；具体四平台完整入口结果在本清单验收表记录。真实平台账号、生产配置、付费 Provider、部署切换均未使用。
- `owner-session.ts` 提供 owner 私聊专属 `bind_web_session`：当前执行租约、完整密封消息与本人 Web 会话共同授权，同事务绑定及工具收据保证旧调用重放不覆盖后来绑定，写后撤权回滚。Node 独立 HMAC 路由有效期十二小时，成功历史事务仅续期同一目标，不读写 Python 路由键；群/成员/Web 入口不注册该 Schema。后续 IM 消息实际复用本人 Web 历史，恢复历史与本轮消息共用可信时区格式化端口。
- `im-dispatch-order.ts` 在生产 IM 的 `beforeClaim` 复核密封 scope，并用短事务串行同 Bot/peer 或群的跨 session 领取；绑定到 Web 目标后也不能越过旧 Run。业务顺序不按早落库序号重排；Web 默认消费者不注入该门，其他 Bot/群/peer 不受阻塞。
- `compact-postgres.ts` / `production-compaction.ts` 将 `/compact` 接到当前模型及真实静态来源，未曾运行 IM 的旧 Web 历史也可整理。网络期间不持事务，摘要、覆盖水位、快照、真实用量和 RAG 失效同事务 CAS；同事件更换准入时间仍只执行一次，unknown 不盲重发。运行信号、失租及撤权可取消；`/stop` 不把独立整理命令伪装成 Agent Run，保持 Python 命令内等待语义。`owner-session-schema.sql`、`compact-schema.sql` 须显式迁移，运行时仅检查。
- SILK 使用锁定的 `@zpowertech/audio-player@0.1.1` 纯 Rust WASM 解码器：TS 先验证标准/腾讯头及全部帧长度，独立 Node 子进程限制 WASM 128 MiB、V8 堆 64 MiB、时限和二进制输出，固定二十四 kHz PCM 后经真实 ffmpeg 转十六 kHz WAV。生产不依赖 Python、网络或 WebAudio；构建后的 JS worker 已独立运行验证，许可声明见 Host `THIRD_PARTY_NOTICES.md`。

## 2026-11-18 共享链路增量

- `gateway/access-postgres.ts` 实际查询当前 Bot、账户与工具/记忆权限；工具派发和出站重新读取，Bot/群停用、解绑、权限缩水不能沿用旧快照。飞书群的 nullable 开关保留 Python `is not False` 默认；QQ/Telegram 群必须显式启用，微信旧版未开放群。群只读开关只在需 at 模式生效，不能把旧配置组合错误地当成永久不回复。
- `gateway/conversation-postgres.ts` 与 `ingress.ts` 将既有会话/消息、密封入站收据、附件 claim、启动登记及加密 IM v3 派发接入正式事务。多消息按平台时间排序、mention 独立切段，每条保留锚点，每段共享唯一 Run；先提交 started，再逐段完成派发/completed。重领部分成员仍恢复原段，较晚批次不能越过较早 started 段。被动消息落库并 claim 附件，不创建 Run；群 attention 已进入生产 bootstrap 的 Ingress 资源装配。
- Core 上下文组装替换全部当前批次锚点，避免 early 历史与当前输入重复；RAG 截止点取历史中最早当前锚点，业务顺序不按数据库 ID 重排。IM v3 批次证明与密封路由的标识、数量和消息顺序必须一致；权限从逐条发言事实重新解析，不能信任汇总角色或只按末条 owner 绑定。
- `platform-connections.ts` 已将实际连接、解析、控制预检、媒体和密封入队组合；协议组件回归使用明确的网络/控制事务/存储替身，正式 bootstrap 另用真实 PG/Redis/FS。`attachment-ingress.ts` 复用真实本地上传及 PG draft/claim，`message-materializer.ts` 将已 claim 的有权锚点恢复为正式文本/图片/音频/视频与稳定媒体引用；音频已接独立 ASR/原生音频与稳定引用；未配置时正式 early exit，真实空识别与故障分离。
- `agent-run-dispatch-postgres.ts` 与 `agent-dispatch-worker.ts` 显式支持严格 IM v3 契约，默认仍只处理 Web v2。已知其他来源不领取、不清理；IM 启用必须配置来源及独立重建器。`gateway/agent-reconstructor.ts` 复用既有 `createPersistentAgentRuntime`、Provider、工具注册器与确认机制，核对加密路由、锚点、当前权限、模型及访问范围；投递锁暂不可用保留排队，不误标启动失败。
- 持久 Run 与投递锁必须使用访问同一数据库的独立连接池。投递连接在整个发送期间持有 advisory lock，不能把 Runner checkpoint 所需的全部池连接占满；重建器拒绝直接复用同一池对象。
- `gateway/provider-binding.ts` 使用正式文件配置锁、PG 凭据快照与可恢复模型绑定，群/私聊和参与者权限进入范围版本；Web/IM 只共用稳定配置解析。`gateway/memory-source.ts` 从授权本地文件实际读取精确 IM scope，复核当前开关/墓碑/权限，不以空 IM 记忆代替生产源。
- Core `inbound-preflight.ts` 在普通历史之前分流秘密输入、绑定、文本选项及取消。`binding-consume.ts` 实现原子绑定和持久一次性收据；正式 Prompt 激活已接 `agent-im-secret-input-postgres.ts` 私聊 stage，逐字段加密，最终复用既有凭据写入/恢复事务。`interaction-lookup.ts` 通过 Node Run、入站收据与消息锚点验证完整 scope；只有已匹配文本才轮换所选动作 token。普通交互重放读取由 lookup 和秘密 inspect/apply 共同复用，旧选择不会落入新秘密字段。秘密原生按钮和实际快捷路由的生产接线见下项与入口增量。
- `admission-postgres.ts` 与 `admission-schema.sql` 保存永久的 HMAC 控制准入事实，先固定首次接收的 PG 微秒时刻，再执行控制分流；重投复用 admitted/consumed，不因短期 Redis seen 过期重新作用于新交互。控制副作用与收据结果之间异常退出会保留 pending/unknown，健康查询可观察，禁止自动重试未知副作用或把秘密转入普通 Agent；这部分需要显式恢复流程，不能宣称自动无损恢复。普通 prompt 和自定义输入阶段均受首次准入时刻约束；自定义阶段实际消费时间使用同一 PG 时钟，避免 Node 时钟偏差。秘密 inspect→apply 另用密封目标/字段阶段引用和锁后 CAS，覆盖 prompt 替换、字段推进及微秒版本变化，不把旧值重定向到新 stage。控制事件 ID 另用 HMAC，原生微信 context token 不进入明文控制收据。
- `redis-stream-commands.ts` 提供真实受限 RESP Streams 客户端；`gateway/worker.ts` 复用实际 StreamQueue/消息租约/WorkerConsumer，解封一次后即时预检，普通消息按完整会话防抖一秒并交给持久批次 Ingress，提交后逐条 ACK。控制不等待模型运行；失租/失败不 ACK。停止强制结束防抖、排空在途事务，未 ACK 的成功提交由持久收据幂等恢复。归属未显式切换时拒绝启动；生产 bootstrap 已组合此 Worker。
- 已把现有 Bot 新增、更新、删除、解绑和连接 API 的提交后事件接到统一 Gateway PG 通知及 Web 资源通知；Gateway 订阅还会低频权威对账，丢通知不要求管理员重启。账户停用/挂起的 Bot 不进入配置快照。该通知接线不代表 Gateway 运行进程已经启动。
- Core `shortcut.ts` 与 Host `shortcut-controls.ts`、`shortcut-postgres.ts` 已实现真实状态/取消：首次准入时刻冻结原 Run、完整批次发起者与 opaque reference；执行时锁会话并复验当前权限，不取消后来启动的 Run。等待确认的 IM Run 只重排自身，走既有持久 Harness 的取消恢复；Web v2 不受影响。通知失败不撤销已提交取消，保留通知待处理状态。`/compact` 已接同一 ProviderRuntime 的独立短命摘要分支，持久命令收据、精确 session 租约及基线 CAS 保证未知不重发；忙或等待交互时明确拒绝，不夺普通 Run 租约。帮助只展示实际已装配命令。
- `controls-postgres.ts:createPostgresImControls` 已组合实际 PG access、Redis/PG 绑定消费、秘密输入、文本选项、冻结取消和 Core 预检。消费事务再次核对完整 v3/原消息收据、首次准入时间、待确认 interaction/tool ID/name/kind 及当前 actor 工具权限。BYOK、MCP 失效、业务确认、history/readRoute、平台 reply 与提交后唤醒均为必填真实 Host 依赖，没有空默认；测试仅在 Provider/平台回复/业务确认边界使用受控替身。相关 7 文件 61 项通过，实际 PG/Redis/RunStore/Harness/加密写入已验证。当前 lookup 内嵌授权事务要求池至少可借两连接，不能用单连接池部署此组合。原生回调组件与生产装配位置见下一项。
- `native-interactions-postgres.ts` 已将三平台真实 interaction sender、原生消息 HMAC 证明、callback 和上述控制消费接成一个组件；choice、confirmation 及私聊 owner 的 credential start/cancel 均通过实际 PG/Redis/Harness。秘密按钮只由可信 IM 专用投影在真实 waiting credential/MCP stage 下颁发，通用 Web 默认仍不发秘密 token；token 与阶段在同一事务内消费，解密等待期间解绑也回滚。无可信消息 ID 不建立证明；平台接受但索引提交失败为 unknown，pending/unknown 不盲重发，明确拒绝仅 CAS 生成新 attempt。TG 成功 ACK 后清键盘失败只固定诊断，不回滚消费；飞书返回 toast 与移除按钮的原卡。`native-interaction-schema.sql` 仅供显式迁移审查；生产 bootstrap 已将 `native.callback` 接连接 services、`native.interaction` 经 resources 接共享投递 sender。默认 Python 归属下不启动这些消费者；组件覆盖不代表尚未注册的 MCP、Shell 或破坏性工具已具备生产调用入口。
- `reaction-postgres.ts` 已实现飞书 react 的原 Run/消息锚点、当前配置/actor/租约复核与独立工具收据；请求最终进入实际 Feishu sender/client，Token 刷新后业务 HTTP 前再次复验授权。收据不借用包围 Runner 的投递锁，避免工具与自身争锁；same call 并发或未知/提交中断不能重发。正式 ToolRegistry 仅在可信飞书能力注入时注册 Schema，其余三平台不注册。真实 PG 9 项与既有注册器 25 项通过；平台 HTTP、配置选择为替身。`reaction-schema.sql` 未自动迁移用户库。会话 Bot 字段按真实 `varchar(128)` 验证，不能用整数 fixture 掩盖生产 SQL 类型错误。
- `run-artifact-sender.ts` 已接实际本地文件与四平台上传/发送：原 Run 全量锚点、当前会话/Bot/群、消息水位和 attached/scope/owner 共同限定附件；legacy `file_id` 仅走既有 owned 文件读服务、版本/软删除及 owner 当前工具权限，不创建对象 ID 或同步。队列等待、分片、CDN 重试及上传后发送逐次授权；失踪文件/跨 scope/后来附件不能请求平台。Host 尚无 `rootId` 授权根解析服务，这类 FS 制品明确拒绝，不能把根标识当宿主路径。真实 PG/FS 与四平台真实协议组件 6 项通过，平台网络为替身。
- `context-services.ts` 提供真实业务概览、偏好/时区、知识库与本地记忆来源、IM 群 persona 和上下文 builder；受限成员无法读取 owner 业务来源，读取前后均复验授权。静态群 system 与 Python `run/preparation.py` 一样独立读取明确的群人格/回复风格投影，不混入私人人格；私聊成员不加载 owner 人格。授权 Skill 目录与 `loadImMemory` 必须由真实服务注入。production-resources.ts 已将其与真实反思 Job、同一 Provider 的压缩分支及资源生命周期组合。
- `context-reference-codec.ts` 验证当前 Run 入站收据、会话归属和附件的 owner/session/平台/`im_ingress_scope`/attached 状态及拥有者文件 key；每次读取前后复核权限。与真实 materializer 组合后，本地 PNG 进入当前 Canonical，checkpoint 只保存稳定引用，恢复重新读取文件，丢失或越权不能回落空值。inline 媒体、临时 URL 与私有推理不进入 checkpoint。实际临时 PG 与本地文件回归 6 项通过。
- `memory-search.ts` 复用正式 Core 文件索引/排名与 ToolRegistry，严格绑定 IM v3、当前 dispatch token/fence/租约、快照和 Bot 权限。群 owner 默认只读当前群，显式跨群受游标和策略约束，群请求不读取私人 owner 记忆。成员和混合批次仍受现有工具白名单约束，不暴露 `search_memory`。缓存命中也复验租约、配置、授权和墓碑。实际 PG 与隔离 SQLite/文件回归已运行；配置选择仍用明确替身。
- `group-context.ts` 与 Core `tools/group-context.ts` 已提供当前 QQ/飞书/Telegram 群 `group_context_search`，并接正式注册器可选端口。Host 以当前 Run 的真实 user 锚点 `conversation_seq` 限定水位；群/平台/Bot/owner 固定，读前后复验授权。实时曾用名与本群 `members.json` 的 aliases/nicknames 合并精确匹配后才模糊搜索，不按“唯一模糊名”提前选错人。只查数据库实际留存消息，不额外截断 2000 条；Python 无摘要时可能仍保留更早消息。索引解析只查询身份/名字/时间聚合，不把全部历史正文读入内存。实际 PG/临时成员文件与正式注册器共 30 项通过，Python 身份/成员/群工具参考 76 项通过；生产资源仍须注入当前权限和租约授权。
- `rag-context.ts:createPostgresImRagContextBuilder` 已提供真实 IM 自动 RAG，可接 `resources.ragContext`：严格 v3/selected 租约、逐 scope 的当前权限/记忆开关/墓碑/游标 revision 与真实最早批次锚点；不伪装 Web v2。当前群、本人 member 及显式允许的 verified owner 分支采用共享排名，群关闭时不借 member scope 隐含读群；Telegram 群也不回落 owner（修正 Python 平台列表遗漏的安全差异）。Memory 实际读取 FS/正式 loader，conversation 由批量 PG 查询重建事实，微秒时间、消息/摘要/可变标题水位不信任索引 metadata。无真实邻文 ID 的邻文裁掉，不能证明摘要/标题时不注入或固定标题；当前只提供词法召回，不宣称 embedding/vector 已接。实际 assembler 多 currentUsers（ID 不同于 seq，业务顺序也不相同）与 Canonical prepare 已验证，不重复召回。
- Core `memory-scope-state.ts` 改为 SQL 文本读取时间，保留 PG 微秒 revision，避免同一 scope_version 的 `.000100 → .000900` 更新被 JS Date 截成同版本。真实 PG 下同实例文件缓存更新、IM/Web RAG 与 SQLite 原行为均已验证；未更改公开 API。
- 飞书 `run-events.ts`、`presentation.ts` 已将真实 RunEvent 投影为工具摘要、分轮文本及顶层 Mermaid/TeX 图片；群摘要折叠且默认不含工具结果，私聊详情需显式可信策略与脱敏。真实图表 worker 的 Windows MathJax 模块加载已修复。`persistent.ts` 现在通过共享 `run-delivery.stream` 独占正文，将卡片 ID、sequence、缓冲文本、图表/摘要与事件阶段加密保存；平台操作 accepted 与状态 CAS 原子提交。半事件 inflight、HTTP 未知及 HTTP 成功后提交中断均禁止重放；等待后的真实 coordinator 顺序、凭据值裁剪及每次 HTTP 前撤权复核已有实际 PG/Harness 回归。重建器通过同一收据的 `streamFactory` 接入，不能在 `observeRun` 旁路发送。生产资源绑定当前平台 client，bootstrap 的独立扫描复用同一投递收据。

新增的 `conversation-schema.sql`、`binding-consume-schema.sql`、`admission-schema.sql`、`shortcut-schema.sql` 和原 `delivery-schema.sql` 都是显式审查材料，没有自动应用到任何用户数据库。已有单消息收据结构升级使用 `conversation-batch-schema.sql`，新库使用完整 `conversation-schema.sql`，二者不能重复执行。查询替身不证明真实 SQL 锁、并发、回滚或部署已验收。

飞书投影新库使用当前完整 `delivery-schema.sql`；已有旧 delivery 两表的库只执行增量 `delivery-projection-schema.sql`，不得重跑完整 DDL。投影状态 AES-GCM 的 AAD 绑定 owner/session/run/version，明文至多一 MiB；真实 PG 测试已覆盖旧两表增量升级、CAS、错密钥/作用域/版本、篡改和超限。未对用户库执行迁移。

| 平台 | 已实现组件 | 尚未闭合的业务链 | 生产入口 | Python 行为回归 | 真实平台 |
| --- | --- | --- | --- | --- | --- |
| 飞书 | 固定官方 HTTPS 客户端、租户 Token 单飞缓存；实际 SDK 1.76.0 WS 生命周期、安全 discovery 与 DNS 固定 Agent；消息/卡片/reaction 注册、跨 app 错投拒绝；文本、媒体、CardKit 持久流及统一 sequence；真实 RunEvent 工具摘要/图表；共享流式收据、加密状态和安全恢复；实际连接组合、准入和媒体暂存组件 | 已接控制/卡片/react、实际 Run 资源、配置/出站策略与恢复扫描；真实 SDK/平台故障验收仍待完成 | 已接，默认停用 | 完整 IM 基线已运行；SDK/消息/卡片/媒体对应映射见测试目录 | 未验收；合成 dispatcher 卡片 EVENT 不代表真实 WS 回调已验收 |
| QQ | 实际 HTTP Token/消息/stream API；WS identify、READY/RESUME、ACK 超时及退避；文本规则、共享 Redis reply seq、私聊 stream、群 mention、交互/附件 sender、COS 分块上传；加密引用索引、本人表情 FIFO、QFace 准备和真实媒体组合 | 已接绑定/控制/Keyboard、可信私聊流式开关、逐帧授权/恢复、真实图表上传与实际Run；全媒体格式和真实平台另验 | 已接，默认停用 | 完整 IM 基线及新增 QQ/QFace 41 项已运行；纯文本差分另列 | 未验收 |
| 微信 iLink | 固定官方客户端、轮询、完整响应后推进内存游标、启停通知；消息/context token；CDN 媒体收发、AES-128-ECB 及旧 padding 兼容、文本/附件 sender；ticket 缓存/退避、授权 ON/保活/OFF 及实际 RunEvent 观察组件 | 已接实际 Run、原 context token、typing 与控制；跨 token 原生事件身份仍待平台核验；旧版未开放群聊 | 已接，默认停用 | 完整 IM 基线及新增微信/引用 23 项已运行；加解密另列 | 未验收 |
| Telegram | 官方 API、解析、轮询、Redis 原子 update 去重/游标密封入队；MarkdownV2、限流、文本分段/draft/附件 sender、真实媒体组合；已有合成真实 Runner 集成 | 已接callback/绑定/控制、真实PG/FS上下文、私聊持久draft/保活/图文、Run/回复与恢复扫描；真实平台另验 | 已接，默认停用 | 完整 IM 基线已运行；解析/格式差分另列 | 未验收 |

## 共享链路及安全边界

- **注意力与回复选择**：`attention-runtime.ts` 读取真实 Bot/账户/群会话版本，组合共享注意力算法、PG 密封历史和 Node Redis 覆盖窗口。`ingress.ts` 以实际消息段锚点在事务外评估、事务内复核配置/权限，密封首次决策和必须评估标记；静默/等待完成为 passive，重投不重新评分或升级，失败后也不能省略门再派发。Host 覆盖并密封原始 Stream ID，平台载荷同名字段没有授权效力。IM v3 的 `attention` 与密封路由逐项一致，subject 必须唯一匹配原始事件；混批仍按全体参与者最低权限，成功送达事实的被回复成员来自实际 subject。
- **排队后策略撤销**：`attention-policy-postgres.ts` 在真实 owner/账户/Bot/精确群会话下复核冻结模式/版本及自动回复开关。启动前变化以当前 dispatch token/fence 写取消标记，由同一 Harness 结束；准备、工具分类/执行、来源读取和投递继续复核。数据库查询故障抛固定脱敏错误并保留重试，不能冒充策略撤销而永久取消合法消息。生产 `resources(lease,binding,actor,route,authorizeCurrent)` 必须将第 5 参数传进 sender/registry 等每次实际 HTTP 或业务提交前的最终授权，不能只在装配瞬间检查，亦不能在资源构造时阻断已登记取消的 Run 写入实际 Harness 终态。当前生产工厂已将该复核接入真实 Provider HTTP、工具与 sender；旧四参数兼容仅保留组件调用。
- **成功送达事实**：`run-sender.ts`、`run-artifact-sender.ts` 和原生交互使用真实平台回执、逻辑可见正文/内容 hash 与原消息来源；微信不把 context token 当原生消息 ID。`delivery-store.ts` 在 accepted 同一 SQL 原子写入 `attention-ledger-schema.sql` 定义的加密事实，PG 时间为准；证据落库失败则 accepted 一并回滚、保留 pending，不能再发 HTTP。相同正文的 round→FINAL 只提升最终确认事实，不重复发送。旧来源/无原生 ID/无证据分别标记不完整覆盖；当前群存在外层 pending/unknown 意图时也不能声称完整负证据，明确 rejected 不构成成功或未知发送。不能由 assistant 历史伪造成功送达。
- **延迟 ASK**：`pending-ask.ts` 使用 Node 专属加密 Redis 状态及 Lua 的当前、取消、安静窗口和稳定 resume 身份。`pending-ask-dispatch.ts` 必须证明 PG 原段已 completed/passive 且密封决策为该 ASK 的 pending、原始事件/成员/原生消息/HMAC/当前配置和权限一致，再复用原锚点与正式 startup/v3 enqueue；独立持久 resume 收据阻止提交后重试新造 Run。`ingress.ts` 内部泵/派发入口不能由普通平台布尔标记调用，亦不重跑秘密输入预检。负水位和每个 resume 的 HMAC issued 证明保留七天，匹配调度 TTL，complete 不删 issued；Redis 丢状态时启动复核返回取消，不能误认为“没有人取消”。这比 Python 十分钟负水位更保守；正 pending 的十分钟 TTL 和 60/30/180 秒等待保持。原配置版本变化后旧 ASK 不按新策略升级。重建器需绑定 `ingress.verifyPendingAskRun`，取消通过当前租约持久标记交给原 Harness 提交终态。`pending-ask-schema.sql` 和成功送达事实迁移均需显式应用，未自动修改用户库；生产 Host 已装配定时唤醒及真实平台资源，仍须真实平台验收。预评分语音 ASR 后续已由本清单生产资源增量中的真实工厂和持久收据接通；下文组件快照不单独代表生产验收。
- **群静默**：共享 `createChooseNoReplyTool` 为零参数 meta Schema，实际静默由既有 Harness reply gate 提交。重建器只对受信任自动群 Run 注入；明确 @、只读配置、私聊和微信不启用该门。派发 Worker 的首次 start 传 `replyChoice=pending`，resume 保留 checkpoint 状态；当前权限与本轮实际准备能力参与分类，普通工具执行不能自行模拟静默。与 Python `should_enable_group_reply_gate` 一致，`group_read_enabled=true` 时禁用此门，即使群只读存储规则只在 requires-at 模式生效。

- **配置监督**：`apps/web-host/src/modules/im/gateway/{supervisor,bot-config}.ts` 已接可信启用 Bot 查询/解密、HMAC 配置版本、PG LISTEN 先于快照、断线补读、查询失败保留、配置替换排空、秒崩退避。首次握手或运行中的清理未知均冻结该 Bot 归属，不启动替代消费者；Host 停止也不能释放仍有效的唯一消费锁。`health()` 提供固定配置/通知状态及配置、连接、重试、清理未知计数，不公开 Bot ID 或版本，清理未知不计为健康运行连接。生产装配与 `/health/im` 已由 main/bootstrap 接通，默认 Python 归属不启动 Node 消费者；真实部署仍未验收。
- **身份/上下文/工具**：`packages/core/src/im/{access,inbound-batch,memory-context,reaction-tool}.ts` 已有 Bot/owner/platform 对照、混合批次最低权限、完整会话 key、排序/mention 切段、群公开记忆及受限成员上下文投影。`react` 仅飞书注册。Host 的 `context-builder.ts` 复用实际上下文格式化链；这些规则不能替代当前 Bot 启用状态、owner 绑定、权限撤销和消息作用域的权威读取。
- **入站**：Host `inbox.ts` 使用独立 `im:node:inbound`、短期去重及群 attention 索引；Lua 写前检查类型/顺序。`inbound-envelope.ts` 加密正文、附件材料和回复凭证，AAD/HMAC 绑定 Bot、owner、群/私聊和发言人。Telegram 原子游标入队同样密封载荷。started/completed 段收据及部分重领恢复已由 bootstrap 的真实 Worker 消费。
- **Run 出站**：Core `run-delivery.ts` 消费真实 Runner 已提交事件；Host `delivery-store.ts` 用专用 PG 连接/advisory lock、attempt CAS、指纹收据和游标串行化投递。意图登记后再复核授权；pending/unknown 不自动重发，恢复不重跑 Provider/工具。`delivery-schema.sql` 已在隔离 PG 实际应用验证，用户/生产库仍须显式审查迁移，本次未修改。
- **协议可靠性**：QQ 可处理事件在入队回调成功后才提交 RESUME 水位，比 Python“读到即推进”收紧，避免入队失败后丢事件。飞书普通消息保持串行，卡片控制回调独立执行；停止时分别排空两类任务。未知媒体/发送结果不能当成功或盲重建。
- **平台剩余行为**：飞书持久卡片状态、策略/配置和恢复扫描已在生产工厂装配，真实平台恢复仍待验收。平台 PUT 结果未知时停止追加图片/文字，避免 Python 旧回退可能重复发送的路径；图片上传失败保留图表源码。QQ 媒体物化、引用索引及表情 FIFO 已在生产服务工厂组合。微信 typing 已有缓存、退避和 ON/OFF 保活，`agent-reconstructor.ts` 已提供实际 Run 消费时的 `observeRun(events,authorize)` 接线位，生产资源已绑定真实 sender 的观察器；不能在普通发消息时假称 Agent 已开始。各平台全媒体格式和 ASR 仍须按上述边界逐项验收。
- **网络/日志**：平台协议由 Host 承担，复用安全 ProviderTransport 的公网 DNS 固定、重定向拒绝和取消边界。Telegram Token 路径及 COS 预签名 URL 仅在必要的内存请求构造中出现，不进日志/错误；不恢复应用 OSS/S3 存储。若 COS 返回 URL 与公共 query 安全规则冲突，拒绝并记录缺口，不改写 URL 或放宽全局策略。QQ 前缀 MD5 保持 Python 的精确 `10_002_432` 字节，附件上限 30 MiB。
- **微信事件身份边界**：当前 iLink 实现与 Python 一样，没有独立消息 ID，使用 context token 作为消息去重身份；它只保留在加密材料或进入 HMAC，不能写进控制事件的明文收据。若平台重投时改变 token 又不给稳定原生 ID，不能可靠区别“旧消息换 token”和“同文新消息”；本轮不以正文哈希合并来掩盖此协议缺口，真实平台仍须核验。

## 真实调用链与替身范围

以下为早期Telegram组件集成的边界快照；当前四平台生产入口已接main/bootstrap，真实PG/Redis与生产resources的验收另列于后文。`apps/web-host/tests/im/gateway/telegram-agent.integration.test.ts` 的组件链为：

```text
实际 Telegram 消息解析
→ Core 可信身份/角色及访问范围
→ 实际 CanonicalSourceLoader + Host IM context-builder
→ 实际 Provider 绑定/协议适配 + createAgentRuntime/Harness
→ checkpoint/outbox 提交
→ Core Run 投递器
→ 实际 Telegram sender + 官方 API 请求编码
```

此集成覆盖两个群和 owner 私聊的历史/记忆隔离、成员不读取 owner 资料、恢复不重跑 Provider/重复回复、伪造 owner 拒绝。**替身**包括平台 HTTP、模型 HTTP、业务资料、内存历史/checkpoint/outbox/收据、租约及授权状态；并未启动生产轮询、Redis 消费者或真实 PG。它证明组件可调用实际 Node Agent，不证明生产端到端完成。该早期用例不覆盖其他平台；当前四平台正式bootstrap均已有独立隔离生产链回归。

生产接线现在由 `main.ts → gateway/bootstrap.ts → production-resources.ts → agent-reconstructor.ts` 完成。Web v2 的来源校验和空 IM 记忆特例保持只用于 Web；IM 使用正式 v3、真实来源、独立投递池和原平台资源。

当前未验收边界：Python并行写入口须部署单写者；依赖上游真实MXC/MCP或授权根解析的能力、真实平台与部署切换另验。Node Web创建锁、四协议活动私有恢复和Anthropic跨Run续接已完成，见各增量记录。未装配能力明确拒绝，不使用宽松授权或空上下文代替。

上游 Run 资源接线（不由测试替身填充）：

| 契约/调用方 | 当前实际实现 | 后续最小任务 |
| --- | --- | --- |
| `production-resources.ts` | 实际组合 context-services、稳定引用、memory/search/群工具、来源与正式 Core 工具注册器 | 扩展工具时逐项提供真实能力；不扩大为 Web Agent 架构重写 |
| Core 异步工厂与 `ProviderRuntime` | 同实例压缩、finalizer、来源 system/固定前缀及反思 projection；四协议同事务活动私有checkpoint、精确ref恢复及Responses/Anthropic成功跨Run发布；失败释放资源后拒绝创建Harness | 真实平台/Provider及部署另验；不可将成功桥/清内存等同全行为完成 |
| `reflection-postgres.ts` 与 canonical writer | 成功历史事务登记幂等 Job，独立消费者重试/dead/defer、文件 journal/CAS、游标/索引提交与 owner 清除围栏 | 公开group无原快照仍defer；platform-user成员已接真实checkpoint重建，按原身份/当前scope复核，不借owner权限 |
| `feishu/persistent.ts`、Core `im/run-delivery.ts` | 生产工厂绑定同一当前 Bot/client、策略与授权；独立恢复入口仅读正式 outbox，不要求假 Runner | 真实平台半事件恢复与断网验收仍待执行 |
| Core 文件工具与 `file-tools.ts` | owner 私聊真实 `read_file` 文本切片；`send_file` 使用有权 file_id 或同 scope attach_id、独立持久发送收据 | 不宣称已支持 URL/任意物理路径/Office 解码或视频；群/成员不暴露 owner file_id Schema |

Core 继续承担 `createReflectionFinalizer`、`ReflectionSnapshots`、`prepareReflectionSnapshot`、`runContextBranch` 与 owner profile/pattern 增删、confidence、perception→stance、lens hint 等合并规则；Host 承担 Job、受权来源、存储及有界消费。公开group原快照失效时defer；owner/platform-user成员仅在已验证idle、无pending和当前范围后从正式checkpoint按各自权限重建，不发模型请求或虚构 assistant。成功 Run Job、被动群消息计数和 idle 窗口分别持久化，不能互相替代。

被动群反思已接 `conversation-postgres.ts → reflection-triggers.ts → reflection-postgres.ts → reflection-tail.ts → Core reflection branch → reflection-files.ts`。每50条可信被动消息登记独立窗口；只有真实成功 Run 才能设置180秒 idle 起点，被动消息不延长该时间。纯被动群先保留窗口，待真实 Run 提供合格前缀；重启后公开群没有原快照仍暂缓，成员按上段的当前授权与 checkpoint 规则恢复，不以空上下文继续。尾部按 Session 序号、原始收据和密封来源追加一次；沿 Python 现有尾部行为不额外读取 ASR 字幕，追加后清除旧快照用量，交由实际 Provider 重新计量。

群 daily 自动沉淀已接成功反思之后的持久任务：`reflection-postgres.ts → reflection-daily.ts → Core runContextBranch(compaction) → reflection-files.ts`。复用已有 Core 群日记解析、100条触发、最旧100条分批、日期保留和事件规范化。使用正式 `im/group_compress.md`，输入仅为本群 memory/daily，与 Python 独立分支一致，不加载或伪造主请求快照、工具或聊天历史。触发时的全部记录冻结为数量和摘要；各批文件计划加密持久化，提交后登记下一批，余数不足100条也处理完。并发新增头部保留，旧尾部或 memory 变化时拒绝覆盖。维护不推进消息反思游标，单独记 `compaction` 用量；重启补写既有计划不重发 Provider 或重复记账。失败保留原批和未处理记录，不让已完成反思重跑。

owner daily 生产链已接 `reflection-owner-daily.ts`，使用独立的 Core `owner-daily-compaction.ts` 规则：50条触发、最旧100条逐批处理、保留批次任一可靠日期；新章节只追加既有 memory。生产绑定复用真实 owner-only BM25 与本地记忆存储，查询限2000码点，参考最多10条／6000码点，只供去重核对；不查询群或其他owner，不发送整份旧主档或主请求快照。可选参考失败可继续，当前授权失败必须拒绝。正式 `memory_compress.md` 与现有 ProviderRuntime 独立短调用保持默认输出预算；Provider错误、空对象或无效JSON最多两次，非空但缺有效entries不重试。逐响应保存真实用量，解析失败不丢数值；失败响应的已知成本与任务重试状态同事务提交。未报告的用量保留unknown，不以零值或估算代替。普通owner反思read/plan仍维持原六字段，不额外加载memory。

文件读取与计划沿用Host单文件2MiB边界，超限拒绝并保留旧文件和daily，不通过裁掉旧条目适配限制。批次数量不另设任意总条数截断；每批仍最多100条。超限历史文件的更大规模支持不由当前隔离样例证明。

`group_owner_memory_enabled` 只控制群内私人记忆召回，并不禁止 owner 反思写入；按 Python `run/finalization.py`、`reflection.schedule()` 和被动入站实际分支校正。成员/混合前缀没有 owner 资格时保留等待窗口，不能因该召回开关关闭而吞掉 owner 待学原话。

窗口冻结 owner revision 和各 scope epoch，Node 游标逐版本证明仅允许连续的 Node 自身推进，不能跨越管理员清除或外部写入。混合 owner/member Run 仍采用成员有效权限，owner 不作为成员记忆目标，私有 owner 窗口等后续真实 owner 前缀恢复。窗口完成只表示任务登记完成，文件写入需单独看 Job 完成及 journal/CAS。待处理窗口保护历史保留和 Session 淘汰；显式删除同事务取消窗口。长期记忆维护已复用同一持久队列，具体周期门限和恢复边界见下节。

新部署显式应用 `reflection-schema.sql` 和 `reflection-trigger-schema.sql`。已有早期 Node 反思表使用人工执行的 `reflection-trigger-upgrade.sql`；生产启动只检查契约，不自动 DDL。旧 Run 缺失原始 scope 冻结时保持未知，不以当前 epoch 回填；旧待处理窗口缺冻结时取消归档，不恢复学习。默认 Python 模式不要求这些 Node 表，也不构造 Node 消费者。

## 回归与未验收项

本轮最近汇总：

生产资源增量验收独立于下方历史组件计数（有重叠，不相加）：

| 范围 | 最新证据 | 替身与未验收 |
| --- | --- | --- |
| 被动群、idle 与可信尾部 | Linux 6文件38/38，零失败/跳过；Python阈值/群策略/原快照复用/记忆scope原样72/72；生产及7个定向测试严格类型检查通过 | 真实PG/Redis/FS/Harness，平台与Provider网络替身。含多次50条、纯被动重启等待、180秒idle不延长、异常收据补扫、禁用群不阻塞、密封尾部篡改拒绝、Admin版本断层、已准备文件计划优先恢复和旧schema幂等升级；包含显式删除5项回归。长期维护未迁移，真实平台/部署未验 |
| 窗口恢复与跨Session围栏增量 | 最终反思PG组件13/13、混合身份正式bootstrap1/1，无失败/跳过；四平台正式bootstrap4/4及运行归属10/10通过 | 组件计数与上行重叠，不相加。真实PG门控Run释放，忙窗口仅CAS延期扫描元数据、不再等同一Session行锁，解锁后自动完成；混批保留最低member权限，solo owner真实前缀恢复owner窗口。队列scope版本只推进本Session，其他Session无连续证明时取消且零Provider；群私人记忆召回开关不禁止owner学习，缺合格owner前缀仍保留窗口（按Python实际语义纠正）。最终生产类型检查及124个新增测试元数据通过 |
| 群daily自动沉淀 | Core纯规则8/8；正式bootstrap与既有反思组件组合14/14；Python原样daily/IM scope 41/41，均无失败/跳过 | PG/Redis/FS/生产Run/Harness/Provider协议真实，仅平台和Provider网络替身。250条按100/100/50全量处理，文件已写后事务失败不重发模型/重复记账，空输出保留批次，跨进程接管不依赖主快照；维护不推进消息反思水位。包含私人召回开关与owner学习不同义的修正回归 |
| 群daily最终整合复验 | 冻结代码后Linux四文件8/8，无失败/跳过；生产及3个定向测试严格类型检查通过，126个新增测试元数据通过 | 另含真实ProviderRuntime/临时FS的撤权、日期、空输出、旧尾部/长期记忆编辑、CAS及并发新增头部拒绝/保留；混合身份Session释放门控、两轮被动50条、纯被动重启和idle全部保持通过。此记录与上行计数重叠，不相加 |
| owner daily与群维护统一复验 | Linux五文件24/24，Core owner＋群规则16/16，Python daily/历史参考/IM scope原样47/47，均无失败/跳过；生产及5个定向测试严格类型检查、普通Core增量构建通过，129个新增测试元数据通过 | 真实PG/Redis/FS/Node Run/Harness/词法检索；仅平台/Provider网络为替身。owner 249条加真实新记录分100/100/50，旧memory仅追加，跨owner/群哨兵不入模型；一次空JSON后成功、无效entries失败均保留并原子记录实际响应成本；文件已写事务失败、两次重启不重发/重复记账。另含坏JSON带usage重试、缺报unknown、明确零报告和部分报告、RAG暂时失败、权限撤销、CAS及旧尾部编辑。与历史记录计数有重叠，不相加 |
| Node IM 保留链统一复验 | Linux Host 8 文件 48/48，零失败/跳过；生产与7个目标测试类型检查通过 | 含四平台正式入口、50会话替换→真实Run→2000条裁剪→Redis丢失重放、永久消费墓碑、GC真实失败重试、13项历史保留、7项会话限额、附件复制和生命周期。PG/Redis/FS/Harness真实，入口仅平台/Provider网络替身，组件pendingASK为明确端口替身；117个新增测试文件元数据校验通过 |
| Core 同事务删除与 Python 保留基线 | Core PG 1/1、单测3/3；Python保留8/8、11项未选中，另淘汰附件/终端2/2，均零失败/跳过 | Core验证借用client不改变事务边界、回滚、只关闭agent终端、附件/session原子删除；Python两组原样执行独立临时配置和存储，命令见下方。不据此宣称所有删除入口已接Node永久标记 |
| Responses 三轮正式入口 | 1/1，通过且无跳过 | 真实 TG 入站/准入/Redis/PG/生产 resources/Harness，首 Run 成功密文 v1 → 第二 Run 实际 Responses 请求携带原私有 reasoning 与旧 assistant → 成功密文 v2 → 第三 Run 上游协议拒绝、成功状态失效 v3；失败 checkpoint 正常提交，活动行终态清零，正式 codec 解密 checkpoint/outbox 均无私有正文。仅平台/Provider 网络为替身。首次捕获并修复 `configDigest` 误用含 Run/nonce 的 `modelIdentity`，现绑定可信配置/凭据/权限版本的稳定 scope；不降低断言 |
| 图片/视频与四平台正式入口增量 | 四平台 4/4、视频 3/3、修正实际 `image` 能力配置后的图片 3/3；均无失败/跳过 | 实际 PG/Redis/FS、平台解析/下载、完整图片解码、ffprobe/ffmpeg、生产 resources/Harness/回复；仅平台与 Provider HTTP/WS 为替身。图片覆盖 BMP/TIFF 转 JPEG、PNG 原样发送及原件/ref 不变；视频覆盖 OpenAI、MiniMax multipart/加密缓存及未支持分支。分次运行，不合并声称同一批通过 |
| 媒体与私有状态组件 | Linux audio/image/video 26/26；Windows video-runtime 5/5；Linux 私有状态/bridge/RunStore/writer 24/24；均无失败/跳过 | 媒体用实际解码/进程，视频运行时网络/探测端口为替身；私有状态用真实 PG、Responses 协议事件与网络替身，验证原 ref/round/area 恢复、跨 owner 密文错置、过期/篡改/撤权拒绝、成功事务回滚、off/实际工具 Schema 变化失效 |
| 本轮 Core 与 Python 媒体基线 | Core runtime 68/68、视频规则 6/6；Python 视频 72/72，图片 4 通过/12 未选中；均无失败/跳过 | Core 媒体端口/HTTP 为替身；Python 原样测试在临时配置执行。Node 额外安全边界：坏图片即使原样模式也须完整解码，普通 JPEG 质量阶梯仍超八 MiB 则拒绝；HEIC 明确未支持，不以这些通过代验收 |
| 本轮统一增量验收 | Linux Host 12 文件 89/89，无失败、跳过；Core 3 文件 16/16 | 含四平台入口、七种语音入口、绑定→Web续接→整理完整路径、跨session顺序门、完整旧Run引用双证及SILK；PG/Redis/FS/真实Harness/Provider协议/受限WASM均实际运行，平台和Provider网络为替身。Host生产/新增测试类型检查、105项新增测试元数据均通过；与下方历史快照重叠不相加 |
| 本轮 Python 行为基线 | 原样 pytest 13 通过、57 未选中，零失败/跳过 | `test_im_owner_session.py` 5 项及 `test_commands.py -k compact` 8 项；临时配置/测试存储，不运行Python生产消费者。引用附件规则另有原函数AST差分1项，不计pytest |
| SILK 专项与部署产物 | Linux audio 10/10，32组实际pilk逐字节差分；构建后JS worker独立运行通过 | Python仅在测试生成参考，不在生产解码路径。Windows本轮音频8通过、2个参考生成测试因未配置pilk解释器跳过；macOS未验收。包完整性、固定版本和第三方声明已核对，不作法律结论 |
| 四平台完整生产 bootstrap | Linux 4/4 通过，失败/跳过均 0 | 真实 ORM/迁移、PG、Redis、配置锁、FS 来源、Worker、Harness、outbox 和平台 sender；仅平台 HTTP/WS 及 Provider HTTP 为替身。重启原事件不重复 Run/回复，PG 通知停用后连接停止；Telegram 明确拒绝后终态恢复补投不重 Provider |
| 入口/归属/设置/扫描/交互最终组合 | 5 文件 19/19，通过且无跳过；含上一行 4 平台，不相加 | 真 PG 互斥、默认 Python 零构造、启动/停止/清理失败、IM-only waiting 取消与实际持久 Harness resume；扫描定向 SQL 边界另有测试替身，不冒充真实 PG E2E |
| 公平扫描最后增量 | host-scans 4/4、Telegram bootstrap 修复后复验 1/1，通过且无跳过 | 真实 PG 验证同 chat 129 项后其他 session 不饥饿、33 unknown 后第 34 项正常恢复、空页回卷；坏项持久 cursor/unknown 收据不变。与上行旧扫描 3 项重叠，相关唯一用例共 20，不声称同一批次运行 20 项 |
| Core IM/运行/Provider 定向 26 文件 | 前轮统一 433 通过；本轮 ASR/Provider policies 133 通过，失败/跳过均 0；有重叠不相加 | 内存持久端口与 Provider HTTP 为合成边界；四协议正式前缀、反思脱媒体与三种 ASR Python 空白规则保持 |
| 语音生产完整链路及物化来源 | Linux 3 文件 15/15，通过且无跳过；含完整语音 bootstrap 4 项 | 实际 Telegram 媒体下载协议、PG/Redis/FS、OGG→WAV 真转码、独立 ASR→主模型、原生音频、未配置零 Provider、混合消息批次及字幕落库；仅平台/Provider 网络为替身 |
| 四平台及语音生产入口最新统一复验 | Linux 2 文件 10/10，无失败、跳过 | 四平台正式 bootstrap 4 项及语音 bootstrap 6 项；群 natural 单语音/混合批次通过预转写触发真实 Run、只 ASR 一次、密文缓存同事务绑定、原始 seal 不变，新实例重连重投无重复 Run/回复；网络为替身，PG/Redis/FS/Harness 真实 |
| 独立语音配置/字幕持久化/运行/音频进程 | 配置 5（含真实 PG/信封）、字幕 7；Host runtime 最新 20 + 真实音频处理 7，均通过且无跳过 | 默认/轮换/撤权/BYOK 信封、显式 local 预设不靠 URL 猜权限、三种协议与媒体准入、生命周期/取消/清理、Unicode 字幕；固定选择校验 owner、缓存命中零 HTTP、unknown 不降为空识别；音频进程用真实 Windows/Linux ffmpeg，运行协议测试明确替换 HTTP/部分媒体端口 |
| 群语音来源与持久收据 | 真实 PG 来源 1、缓存 12，全通过且无跳过 | 来源从实际 Telegram producer/协议网络替身开始验证复合来源键、完整批次、64 MiB 总读取边界与 passive cache-only；缓存含并发唯一请求、未知状态、Buffer 输入复制、锚点/缓存锁序、版本与字节冻结、撤权、同事务绑定回滚和密文隔离；缓存单测 ASR 回调为替身 |
| 群语音共享链路最新统一复验 | Linux 6 文件 71/71，无失败、跳过 | cache/source/runtime/attention/conversation/pending-ask-dispatch 串行使用真实隔离 PG/Redis；覆盖新生产事务钩子和旧延迟 ASK。与上述组件项重叠，不相加；生产 TypeScript、diff 检查及相对基线的新增测试元数据 100 项均通过 |
| Python 语音配置/协议基线 | 本轮原样 pytest 14/14，通过且无跳过 | `test_minimax_voice_audio.py` 与 `test_admin_voice_presets.py`；临时配置/存储、测试库及 HTTP 替身，未触真实配置或付费 Provider |
| 反思实际持久链 | Linux PG/Redis/本地 FS 8 通过；旧 writer/usage/reasoning 11 通过 | Provider HTTP 与测试业务来源为替身；验证成功事务登记、回滚、关闭后独立分支、journal 重启、撤权、清除、defer、真实用量一次提交 |
| 生产 Skill 资源 | 真实 ORM 结构 PG 1 通过 | 验证跨 owner/会话隔离、member 拒绝 owner 技能、目录无正文及停用撤权；不计完整 Gateway E2E |
| 共享 Web/IM 上下文 builder 与来源 | 14 通过 | 偏好文件实际读写临时目录，数据库查询为替身，验证原有格式与隐私边界 |
| 文件工具与执行端口 | Core 53 通过；Linux Host 文件/执行专项通过 | 实际 PG/本地文件、平台协议 sender；平台 HTTP/原生进程为受控替身。真实 MXC SDK 不支持，不能计沙箱隔离通过 |
| 既有共享链 16 文件复验 | 首次 Linux 143 通过、2 失败、0 跳过；补齐固定版本 Canvas 后持久 Runtime 用例通过 | 两项首次失败为缺 Linux Canvas 原生包、真实图表 worker；后者补齐 Resvg 后仍在跨盘 Linux 环境触发 30 秒超时。相同真实 Mermaid/LaTeX→PNG→飞书上传断言在 Windows 1/1 通过；Linux 图表时限仍未验收，未放宽断言/超时 |

可重复的新增命令（使用临时目录，Linux Node 与已锁定目标架构原生依赖；连接值只用本次独占测试环境）：

```bash
# 从仓库根目录进入Host；Python仅离线编译ORM/Alembic与生成合成SILK参考（需已有pilk），不启动应用或参与生产解码。
cd apps/web-host
export GUGU_IM_FIXTURE_PYTHON='<隔离venv>/bin/python'
export GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>'
export GUGU_WEBUI_TEST_DATABASE_URL="$GUGU_IM_GATEWAY_TEST_DATABASE_URL"
export GUGU_WEBUI_TEST_REDIS_URL='<独占隔离Redis库连接>'
node --import tsx --test --test-concurrency=1 tests/im/gateway/production-resources.test.ts tests/im/gateway/production-bindings-store.test.ts tests/im/gateway/reflection-postgres.test.ts
# 完整入口另用专属Redis库，不能与同命名空间消费者并跑；网络替身仍经过真实平台解析与sender。
export GUGU_IM_BOOTSTRAP_TEST_REDIS_URL='<另一独占隔离Redis库连接>'
node --import tsx --test --test-concurrency=1 tests/im/gateway/bootstrap.test.ts
# 图片/视频需要本地Canvas原生包及ffmpeg/ffprobe；同库串行，Provider与平台仅替换网络。
node --import tsx --test --test-concurrency=1 tests/im/gateway/image-bootstrap.test.ts tests/im/gateway/video-bootstrap.test.ts tests/im/gateway/reasoning-bootstrap.test.ts
node --import tsx --test --test-concurrency=1 tests/im/gateway/bootstrap.test.ts tests/im/gateway/retention-bootstrap.test.ts tests/im/gateway/retired-inbound.test.ts tests/im/gateway/history-retention.test.ts tests/im/gateway/session-retention.test.ts tests/im/gateway/pending-ask.test.ts tests/im/gateway/host-runtime.test.ts tests/im/gateway/attachment-ingress.test.ts
node --import tsx --test --test-concurrency=1 tests/im/gateway/audio.test.ts tests/im/gateway/image.test.ts tests/im/gateway/video.test.ts tests/im/gateway/video-runtime.test.ts
node --import tsx --test --test-concurrency=1 tests/agent/agent-reasoning-persistence.test.ts tests/agent/agent-reasoning-bridge.test.ts tests/agent/agent-run-store-postgres.test.ts tests/agent/agent-canonical-write-postgres.test.ts
# 同一独占Redis库中串行运行语音生产验收；需要本地ffmpeg/ffprobe及OGG编码器。
node --import tsx --test --test-concurrency=1 tests/im/gateway/voice-bootstrap.test.ts tests/im/gateway/message-materializer.test.ts tests/agent/agent-context-source-postgres.test.ts
node --import tsx --test --test-concurrency=1 tests/im/gateway/voice-config.test.ts tests/im/gateway/voice-transcripts.test.ts tests/im/gateway/voice-runtime.test.ts tests/im/gateway/audio.test.ts
node --import tsx --test --test-concurrency=1 tests/im/gateway/voice-cache.test.ts tests/im/gateway/voice-attention-source.test.ts tests/im/gateway/voice-runtime.test.ts tests/im/gateway/attention-runtime.test.ts tests/im/gateway/conversation-postgres.test.ts tests/im/gateway/pending-ask-dispatch.test.ts
node --import tsx --test --test-concurrency=1 tests/im/gateway/bootstrap.test.ts tests/im/gateway/voice-bootstrap.test.ts tests/im/gateway/owner-session-bootstrap.test.ts tests/im/gateway/im-dispatch-order.test.ts tests/im/gateway/compact-postgres.test.ts tests/im/gateway/production-compaction.test.ts tests/im/gateway/shortcut-controls.test.ts tests/im/gateway/voice-attention-source.test.ts tests/im/gateway/voice-cache.test.ts tests/im/gateway/message-materializer.test.ts tests/im/gateway/audio.test.ts tests/im/gateway/voice-runtime.test.ts
# Core前轮433项统一范围；本轮新增绑定/权限/快捷回归另列，不调用平台或付费Provider。
cd ../../packages/core
node node_modules/vitest/vitest.mjs run tests/im tests/agent/tools/group-context.test.ts tests/agent/tools/send-file.test.ts tests/agent/owner-reflection.test.ts tests/agent/providers/runtime.test.ts tests/agent/run/engine.test.ts tests/agent/context/history-preparation.test.ts tests/agent/providers/openai-responses.test.ts
node node_modules/vitest/vitest.mjs run tests/agent/tools/owner-session.test.ts tests/agent/tools/permissions.test.ts tests/im/shortcut.test.ts
node node_modules/vitest/vitest.mjs run tests/agent/providers/video.test.ts tests/agent/providers/runtime.test.ts
GUGU_CORE_TEST_POSTGRES_URL="$GUGU_IM_GATEWAY_TEST_DATABASE_URL" node --import tsx --test tests/agent/sessions/delete.postgres.test.ts
node node_modules/vitest/vitest.mjs run tests/agent/sessions/delete.test.ts
```

本轮语音 Python 基线从仓库根目录进入 `backend` 执行。先将 `GUGU_ENV_FILE`、`GUGU_CONFIG_OVERRIDE_FILE`、`STORAGE__LOCAL_PATH` 指向本次临时目录，并设置 `GUGU_TEST_REAL_REDIS=0`，不复用运行配置：

```bash
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/agent/providers/test_minimax_voice_audio.py tests/agent/providers/test_admin_voice_presets.py
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/im/test_im_owner_session.py tests/agent/test_commands.py -k 'owner_session or compact'
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/agent/chat/test_chat_attach_video.py tests/agent/providers/test_minimax_video_duration_gate.py
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/agent/chat/test_chat_attach_units.py -k 'fit_image or minimax_image'
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/agent/test_reasoning_state.py -k responses_incompatible_invalidates_persisted_state
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/im/test_im_session_reuse.py tests/agent/test_interaction_retention.py -k 'trim_session_messages or trim_keeps_pending or trim_finished_interactions or trim_respects_created or trim_scoped'
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/im/test_im_session_reuse.py::test_session_eviction_cleans_attachment_storage tests/terminal/test_terminal_retention.py::test_remove_session_closes_agent_terminal_but_keeps_user_terminal
```

| 范围 | 通过 | 失败 | 跳过/未运行 | 解释 |
| --- | ---: | ---: | ---: | --- |
| Core IM，12 个文件 | 136 | 0 | 0 | 最新定向结果，含批次聚合、逐条身份及秘密阶段引用，不是整个 Core 套件总数 |
| Host Gateway 组件及集成（前轮快照） | 264 | 0 | 0 | 旧汇总；当前新增用例计入下行，不沿用为新组件验收 |
| 扩大 Host 相关回归 | 362 | 0 | 0 | 本轮 Linux Node 26，所有显式 PG/Redis/POSIX 实际运行；含持久批次、媒体物化、QQ引用、可信密封及既有调度 |
| 最后受影响 Host 范围 | 153 | 0 | 0 | 覆盖随后新增准入、秘密 CAS、微信 typing、Worker 和媒体接线；与 362 项重叠，不相加 |
| 交互数据库时钟及既有确认门 | 25 | 0 | 0 | 最后增量；真实 PG 下以过旧 Node 时钟验证自定义阶段边界，含原确认/危险动作回归 |
| 群停用实时授权及 Ingress/重建 | 34 | 0 | 0 | 最后增量；新临时 PG 下验证群开关撤销阻止旧 Run 工具和投递，私聊独立；含真实批次并发 |
| 快捷控制/状态、上下文来源、平台组合 | 32 | 0 | 0 | 新增范围；取消使用真实 PG 与持久 Harness，Provider/工具及平台网络为替身；等待确认后取消不再次调用模型或执行工具 |
| Core IM 与群检索规则，20 个文件 | 177 | 0 | 0 | 最新 Core 范围，替代旧 12 文件快照；包含快捷、memory scope、群 speaker 解析与工具契约 |
| 上下文来源及引用 codec | 7、6 | 0 | 0 | 最新来源 7 项；codec 6 项含真实 PG 和真实 materializer/PNG 文件恢复；SQL/其他业务替身范围见用例 |
| 群检索与正式 ToolRegistry | 30 | 0 | 0 | 群工具 5 项加既有注册器 25 项；真实 PG 和本地成员文件，未连接平台或 Provider；Python 相关参考另有 76 项通过 |
| 检索/来源/引用/群工具/监督器及原 Web RAG 合集 | 38 | 0 | 0 | 最新父会话统一复核，6 个文件，显式启用临时 PG；与上列增量重叠，不相加 |
| 引用 codec 与媒体物化，Linux | 14 | 0 | 0 | 最新实际 PG、正式 stage/claim 与本地 FS；逐项变更群会话 source/Bot/chat_type 拒绝，合法私聊 Web 绑定保留 |
| Provider runtime 与 Responses 既有回归 | 114 | 0 | 0 | 最新异步上下文组装入口共用同一 ProviderRuntime；实际主 Run、压缩分支/summary projection，网络为替身；缺失/替换服务或工厂失败先关闭资源 |
| 持久 Runtime 与 IM 重建器 | 8 | 0 | 0 | 异步工厂实际 PG/Redis Run、checkpoint/outbox/租约/历史事务与同 Provider 压缩分支；模型 HTTP 与业务上下文/反思 capture 为替身 |
| 控制组合与受影响持久交互/取消/重建 | 61 | 0 | 0 | 7 个文件，controls 新增 9 项，实际 PG、Redis、BYOK 与持久 Harness；Provider、平台 reply、业务确认边界为替身 |
| 飞书持久流/投递存储/client/streaming | 37 | 0 | 0 | 4 文件，真实 PG、Harness、最终实际 renderer；平台 HTTP 为替身，交互含真实 coordinator 8 组合与凭据哨兵保护 |
| Core IM/群工具与 Provider runtime 合集 | 240 | 0 | 0 | 最新父会话 21 文件统一回归；Responses 55 项另按上列记录，范围不相加 |
| 原生交互及受影响控制/平台回归 | 104 | 0 | 0 | 9 个文件；实际 PG、Redis、BYOK、Harness、三平台 sender/client；平台网络/Provider/reply 及原单元测试边界为替身 |
| 附件发送与受影响平台媒体/连接 | 6、37 | 0 | 0 | 新切片 6 项含真实 PG/FS，关联旧平台组件 37 项；平台 HTTP 为替身，QQ 实际 COS query 安全限制未放宽 |
| 飞书 react 与正式工具注册器 | 9、25 | 0 | 0 | 新切片 9 项实际 PG、密封路由/dispatch codec、sender/client 与正式注册器；既有工具注册器 25 项通过，范围不与上列相加 |
| 自动 IM RAG、IM memory 与原 Web RAG | 19 | 0 | 0 | 新 RAG 7 + memory 6 + Web 6，实际 PG/FS/SQLite；10 秒预算、取消排空、真实 assembler 与微秒 revision 更新均覆盖，未使用 embedding |
| 共享 RAG 并集/过滤与 scope 状态 | 8、6 | 0 | 0 | scoped-search 8、memory loader 6，旧单 scope 与 SQLite 行为保留；Python injection 13 项通过 |
| IM memory 与既有 Web RAG | 12 | 0 | 0 | 最新两个文件合计；IM 6 项含实际 PG lease/fence/游标/Bot/账户/快照检查，实际 SQLite 索引、墓碑与本地文件排名；配置选择为替身 |
| 飞书流/发送/API 与真实图表 | 31、13 | 0 | 0 | 分别为飞书 31 项、charts render/worker 13 项；PNG 实际生成、平台 HTTP 为替身，不能相加为真实平台验收 |
| 公共 Provider Transport | 41 | 0 | 0 | 包含真实临时回环 HTTP 收到完整 POST 后断连，buffer/stream 两种正文均不得标记尚未发送 |
| 成功送达 ledger、native 与实际静默 Run | 33 | 0 | 0 | 最新真实临时 PG/Redis；成功回执与证据原子提交、FINAL 提升、失败回滚、真实 Harness 选择静默后零 HTTP/零最终成功事实，平台/模型 HTTP 为替身 |
| Core Run 投递 | 20 | 0 | 0 | 最新包含 structured accepted evidence、同 key 最终确认，以及空正文静默终态不能制造最终送达事实 |
| Core IM、Provider runtime、实际 Runner 回复门 | 306 | 0 | 0 | 最新父会话统一 22 文件回归；与早前 Core 快照重叠，不相加 |
| 真实 sender、附件与控制 | 37 | 0 | 0 | 最新实际 PG/FS/协议组件；每个原始锚点证明、跨 scope、native/source coverage 与无真实 ID 的微信语义；平台 HTTP 为替身 |
| 注意力、延迟 ASK 与飞书持久流 | 15 | 0 | 0 | 最新实际 PG/Redis，含正式 startup/v3 enqueue/幂等 resume、issued 丢失取消、微秒送达水位和持久 FINAL；与上列重叠 |
| 最后统一 Host 验收，16 文件 | 144 | 0 | 0 | 父会话实际临时 PG/Redis 顺序运行，含入站、注意力、延迟恢复、策略复核及查询故障保留、真实持久 Harness、未知账本覆盖、四平台 sender/附件与飞书流；网络/业务替身范围不变 |
| 原有 Web 上下文 builder/assembly | 5 | 0 | 0 | 公共 formatter 提取后保持 Web 行为；IM 集成改用正式 formatter |
| Python `tests/im/` | 890 | 0 | 0 | 最新已原样重跑完整目录；临时配置/SQLite/假Redis与fixture存储，无真实平台/付费Provider；Python参考代码未修改 |

362 项是本轮完整 Linux 联调快照；随后增量及最后 144 项统一范围均真实启用各自临时 PG/Redis 参数。以上范围存在重叠，不能相加。旧单消息 schema 升级 SQL 也已在临时随机 schema 执行，保留原收据行，验证新增多锚点共 Run 和唯一约束。此前 Core 统一快照为 22 文件 306 项；当前 26 文件结果见生产资源增量表。完整 Core 构建和 Web Host 生产 TypeScript 检查通过；此前 80 个新增测试文件的元数据相对任务基线 `f5a6b91d` 检查通过，未触发远端 CI。Transport 回环服务使用临时随机端口与合成正文，不连接真实平台。Windows 前轮扩大检查曾为 309 通过、4 失败、24 跳过：其中 3 项缺 POSIX 配置锁，1 项被临时密钥目录规范化安全规则拒绝；未放宽断言或安全规则，同一代码随后在临时 Linux 环境全部通过。最后统一验证仍不声称 POSIX Provider 绑定或所有媒体组件可在 Windows 生产运行。

随后新增 Core 快捷规则、IM memory scope 与预检引用契约定向 29 项通过。快捷规则与 Python 纯模块差分 6912 组合：5856 一致，1056 为明确记录的发起者权限收紧或帮助菜单差异，无未分类差异；命令解析及文本分类全部一致。`/stop` 不再绕开发起者检查，也不在缺少发起者证据时允许取消。Python 飞书工具摘要回归额外 17 项通过。上述计数属于此前组件/行为验证；本轮生产入口验收另列，不将两者混为同一结果。

纯模块差分：Telegram 解析 203 组合的原有公共字段、格式化 68 组合、QQ 文本及逐字符前缀 471 组合一致。Node Telegram 后续新增 `platform_message_id` 原生别名以支持严格持久锚点，该新增字段不在旧 Python payload 中，不能称完整 payload 逐字段相等。差分验证规则，不验证平台网络。Python 原生 Windows 收集曾因 `fcntl` 不可用失败；890 项结果来自本地 Linux 隔离环境，未伪造 POSIX 模块。

QQ 引用/表情新增对照回归：`tests/im/qq/test_qq_raw_ws.py`、`tests/agent/providers/test_qface.py` 共 41 项通过，零跳过，使用隔离配置和受控网络。引用索引改为 Node 专属加密 Redis，保留七天/五万项边界；同群可引用其他成员，收藏表情 FIFO 增加本人隔离与容量边界，避免 Python 原群级 FIFO 跨成员配错图。QFace 保留选择优先级、六小时缓存与失败一分钟退避，实际补图失败保留原占位，不伪造图片。

当前物化媒体边界须单独验收：`image.ts` 对 PNG/JPEG/GIF/WebP/BMP 完整解码，TIFF 经私有固定文件与受限 ffmpeg 转 PNG 后实际解码；普通副本沿用 3840 长边、5 MiB 原样阈值和 JPEG 质量阶梯，输出仍超过八 MiB 时明确拒绝；原样模式按实际 Provider 限制校验并完整解码，原件/引用元数据不改。HEIC 明确拒绝；旧Python虽声明pillow-heif依赖，但生产路径未注册opener，真实合成HEIC经正式fit_image同样返回None，不能将其误记为已验证的旧能力丢失。原生音频上限三十六 MiB，独立 ASR 按真实 profile 准入（通用三十六 MiB，MiniMax 五十 MiB/500 秒，平台传输上限仍独立适用）。SILK 由受限 Node/WASM 进程解码。视频见下方独立规则。注意力阶段原发/引用语音预转写及历史引用恢复已接线；原生音频附加字幕已接独立 ASR，保留原音频供主模型处理且不把字幕重复写入正文；completed/empty/failed 卡片经合法 sessions 更新事件发布，仅投影公开字段。隔离生产回归11/11、voice runtime/真实PG字幕33/33已通过，平台与Provider网络为替身。这不等同 Python 全媒体格式覆盖。

### 视频与私有推理的生产接线

Responses 协议不兼容已增加 Core 明确失效通知，生产资源调用 Host `invalidateReasoningState()`，使用本次加载时冻结的成功版本 CAS；旧 Run 不能读取新版本后清除其他 Run 的成功状态。回调失败只返回固定不可重试错误，活动行保留至失败 checkpoint 同事务清理，避免提前清行导致 Run 无法终结。对应真实 PG 服务 9/9、Core runtime 68/68 和 Python 原样协议拒绝用例 1/1 已通过；Anthropic 跨 Run、四协议活动恢复及长期维护的后续隔离证据见各自增量验收，真实 Provider 与进程故障仍另验；被动群/idle 触发见上方独立实现与回归记录。

- Core `providers/video.ts` 负责实际模型/协议能力、时长/尺寸、转码与上传选择；Host `video.ts` 负责有界 ffprobe/ffmpeg，不能信任平台 duration。普通视频 120 秒边界与 M3 允许正好 1800 秒、严格超出才拒绝沿用 Python，OpenAI 不擅自转码；不支持的协议只生成明确未发送提示。`video-runtime.ts` 复用真实 MiniMax multipart 协议，六小时上传引用缓存以 owner/scope/冻结模型配置/实际文件摘要隔离，缓存键用 HMAC，值加密；缓存损坏不得当作已上传。每次读取、转码、缓存命中和 HTTP 前后都复核当前权限及文件来源。checkpoint 保存原附件稳定引用，恢复重新授权，不保存视频 base64、临时 URL 或远端文件 ID。
- `agent-reasoning-persistence.ts` 分开保存成功跨 Run 状态与当前 Run 活动状态。生产 `resources()` 已接 Context 初始化、Provider 恢复、RunStore 同事务私有 checkpoint 和成功历史发布；真实协议由 `adapterFor().protocol()` 判断。活动表 `gugu_agent_active_reasoning` 持有加密原引用、原 round/area、当前 checkpoint 版本和上下文指纹；不以旧成功状态冒充当前丢失引用。关闭持久化及实际工具 Schema 变化会失效旧成功状态。失败/中断/静默结束不发布成功状态，终态只清理当前 Run 活动行。启动前须显式应用 `agent-reasoning-active-schema.sql`，main 不自动 DDL；默认 Python 归属不构造这些服务。后续已补Anthropic跨Run和四协议活动私有恢复，具体载荷边界与最新回归见私有推理增量验收。

### Node IM 会话与已覆盖历史保留

- `bootstrap.ts` 已把 `session-retention.ts` 接到真实 `conversation.beforeCreate`，共用 Core `deleteAgentSessionLocked` 的同客户端事务删除。owner 行使用 `NO KEY UPDATE NOWAIT` 串行 Node 创建，候选按更新时间/ID稳定排序并 `SKIP LOCKED`；正常不超过50，每次只替换一个安全旧会话，不批量抹掉既有超限存量。运行、排队、交互、未完成投递/工具与反思任务均保护；Redis pending ASK 未清或未知时推迟。`agent_run_startups` 的 pending 是登记标记，只有没有对应 checkpoint 才阻止清理，不能把真实成功 Run 永久误判成未启动。
- `history-retention.ts` 由成功历史事务 `touchLocked` 及已提交入站 `schedule` 登记 Node 专用目标。独立 `maintenance` 循环每个目标每批最多500条，按最新 summary 覆盖水位和 `coalesce(history_anchor_seq,conversation_seq)` 保留最近2000条；不删 summary、未覆盖及 `im-pending:`。按最早剩余普通消息时间同步裁已完结交互，active 保留。只扫描自己登记的目标，不全库扫 Python 会话。Node 投递按 receipt 或持久 `gugu_im_run_delivery` 识别并检查 cursor；Web/legacy 按 ack，原 receipt 被裁剪不能使 Node 历史永远延期。
- 已保留 quoted voice/audio 依赖原 sourceRun 整批证明；同 owner/platform/ingress scope/storage key 的跨会话引用及24小时有效 draft 也保护来源。附件 `reuse` 持原附件 SHARE，清理在稳定顺序取得附件 UPDATE 后重查，不能沿用等待前的删除判断。引用可能使物理消息多于2000，这是保留恢复证明的安全差异；不放宽语音双证。
- `retired-inbound.ts` 在删除消息/会话的同事务复制无父消息/会话外键的永久消费标记，只存 HMAC 身份/指纹。入站在当前授权后及取得 session 锁后复核；已退休事件不因编辑正文、附件重建或 Redis 状态丢失而重新建立锚点。保留入口统一先 session 后 receipt/segment，避免级联清理与重投互锁。该链路不改 Python 准入、队列、Redis 键或运行状态。
- 同事务把 owned storage key 登记进持久回收队列，提交后复用真实附件引用计数/本地安全删除；会话删除不级联清掉该队列，失败保留重试，代际 CAS 防止吞掉新任务。Node 使用 `strictCleanup` 感知实际 FS 错误，不能让旧 best-effort 吞错后误清队列。新库须显式应用 `retired-inbound-schema.sql` 与 `history-retention-schema.sql`，入口仅检查。
- 当前50限额覆盖采用相同 owner 锁的 Node IM 与 Node Web 创建者并发；未参与此协议的 Python 创建者仍是部署边界，不能声称全写域已协调。

### 显式删除与原生音频字幕补充验收

- `main.ts` 的认证会话删除已注入 `bootstrap.removeSession()`。默认 Python 归属完全调用既有删除用例，不读取 Node 表或清理 Node 状态；Node 归属启动失败/停止时固定503，不能降级绕过 Node 墓碑。`session-delete.ts` 在 Session 锁内识别 receipt/segment/delivery/reflection 或加密 v3 IM dispatch；未知密文拒绝，不当作 legacy。无 Node 事实的会话同事务复用原 Core 删除，再执行原 best-effort 清理。
- Node 会话通过同事务 Core 删除、永久消费墓碑和持久文件回收队列完成删除，不调用 Python Redis 反思清理。有证明的活跃 Run 先请求真实取消、唤醒调度/恢复并最多等待3秒；等待态重新派发恢复取消。未决投递/工具、外部引用、未知身份、准备中的反思文件计划均409；只取消目标会话反思任务，不扩大到 owner 其他会话。
- Web owner取消已与IM出站授权分开：同事务锁定owned Session、SHARE NOWAIT锁复核真实active账户，复用完整v3密文/批次/HMAC来源证明。Bot停用、群停用或平台解绑不阻止owner取消自己的Run；出站仍强制actor及证明前后当前权限检查。未决/未知投递继续409，不能以owner删除恢复出站或伪造已送达。Python原删除不等待活跃Run，此处为避免丢失Node持久任务保留安全差异。
- `voice-runtime.transcribeNative()` 使用独立 ASR 配置，区分 completed/empty/failed；未配置不生成假字幕，缓存未知不重发。MiMo Chat 原生 mp3/wav/flac/m4a/ogg 保留原字节交给真实 Core 协议；不向不支持的 MiniMax/Anthropic 路径声明音频能力。`message-materializer.ts` 把字幕写到首个原发 voice 卡片，引用只进入引用上下文；原生音频正文不重复字幕，恢复 hydrate 不再次 ASR。`production-resources.ts` 经 `sessions` 的 `message_update` 仅发布公开附件字段。
- 隔离真实 PG/Redis/FS、认证 HTTP、真实 Canonical Harness 与取消通知的删除整链路2/2通过：已完成和活跃 Provider 两种路径、跨 owner 404、Node 零 Python 清理、Redis丢失重放零新会话/Run/回复。删除组件真实 PG/FS 7/7，Core 原清理3/3，原认证路由1/1；Python 原样删除/反思/私有状态 pytest 7 passed、63 deselected、0 failed、0 skipped（内存SQLite/假Redis）。网络仅平台/Provider 为替身；组件取消终态推进为明确替身，真实 Provider abort 由整链路覆盖。
- 语音生产整链路11/11、voice runtime/真实PG字幕33/33通过，覆盖原生字幕、空识别、失败及混合批次。真实平台账号和部署均未验收，不把隔离网络替身记为真实平台通过。
- 最终组合复跑：`bootstrap.test.ts`、`host-runtime.test.ts`、`session-delete.test.ts`、`session-delete-bootstrap.test.ts`、`voice-runtime.test.ts`、`voice-transcripts.test.ts`、`voice-bootstrap.test.ts`、`message-materializer.test.ts` 共79/79，通过且无失败/取消/跳过。包含四平台实际适配器至正式 Agent Run 和出站的4项恢复回归；隔离 PG/Redis/FS 与实际 Provider 协议驱动保持真实，只有网络为替身。Core build、Host 生产类型检查、7个相关测试 strict 类型检查和119个新增测试元数据检查通过。
- 后续相同字节媒体修复：指纹只作内容匹配，各附件仍保留独立ID；同消息碰撞按真实消息附件顺序匹配，跨消息按 `_history_id` 筛选，缺锚或歧义拒绝。每次固化仍检查当前授权和持久附件，缺失原附件不能使用相同字节副本恢复。物化14/14（含真实PG两附件）、语音生产11/11、图片生产4/4均通过，无跳过。图片生产新增两消息同字节单Run，在首轮Provider请求前验证真实加密checkpoint逐锚保存各ID；成功消费后的图片按Core原契约折叠为文本，不以终态正文冒充恢复前媒体引用。保留原解码、原件及无原始载荷断言。

后续 owner 取消与反思时间验收：`session-delete-bootstrap` 5/5覆盖已完成、运行中、Bot停用、owner平台解绑和群停用；后三者实际Provider取消、撤权期间零文本/typing请求、恢复合成Bot后旧事件仍不复活。删除组件9/9，既有文本/附件/reaction回归24/24，反思实际PG/Redis/FS回归8/8；6文件组合46/46，无失败或跳过。Python原样反思阈值/群策略/快照复用33/33通过，生产及3个定向测试类型检查通过。成功Run闲置触发统一180秒，未到期不调用Provider；缺可信快照的暂缓重试仍240秒。该记录只覆盖此前成功 Run Job；被动群50条生产入口、可信尾部追加和独立 idle 窗口已另行接通，见上方增量记录。

HEIC基线核对：仓库Python实现没有 `pillow_heif` 导入或 `register_heif_opener` 调用。隔离环境用真实codec内存生成16×12合成HEIC并成功直接解码，正式 `agent.media.images.fit_image(raw,'heic')` 注册前返回None；仅在短命测试进程显式注册后才成功转JPEG。未修改Python源码或全局运行环境。现有pytest没有实际HEIC成功fixture，M3的不支持格式拒绝不能当作通用HEIC成功解码验收。Node保持明确拒绝，后续如新增HEIC须显式接入实际decoder、完整解码与授权回归。

可复跑命令（仓库根；`<Node26>`、`<隔离PG>`、`<专用Redis>`、`<离线ORM Python>` 由临时环境注入，不使用用户运行配置）：

```sh
GUGU_IM_GATEWAY_TEST_DATABASE_URL=<隔离PG> GUGU_IM_BOOTSTRAP_TEST_REDIS_URL=<专用Redis> GUGU_IM_FIXTURE_PYTHON=<离线ORM Python> <Node26> --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/session-delete.test.ts apps/web-host/tests/im/gateway/session-delete-bootstrap.test.ts apps/web-host/tests/im/gateway/voice-bootstrap.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL=<隔离PG> GUGU_IM_BOOTSTRAP_TEST_REDIS_URL=<专用Redis> GUGU_IM_FIXTURE_PYTHON=<离线ORM Python> <Node26> --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/message-materializer.test.ts apps/web-host/tests/im/gateway/image-bootstrap.test.ts apps/web-host/tests/im/gateway/voice-bootstrap.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL=<隔离PG> GUGU_IM_BOOTSTRAP_TEST_REDIS_URL=<专用Redis> GUGU_WEBUI_TEST_REDIS_URL=<另一个专用Redis库> GUGU_IM_FIXTURE_PYTHON=<离线ORM Python> <Node26> --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/session-delete-bootstrap.test.ts apps/web-host/tests/im/gateway/session-delete.test.ts apps/web-host/tests/im/gateway/reflection-postgres.test.ts apps/web-host/tests/im/gateway/run-sender.test.ts apps/web-host/tests/im/gateway/run-artifact-sender.test.ts apps/web-host/tests/im/gateway/reaction-postgres.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL=<隔离PG> GUGU_IM_BOOTSTRAP_TEST_REDIS_URL=<专用Redis> GUGU_WEBUI_TEST_REDIS_URL=<另一个专用Redis库> GUGU_IM_FIXTURE_PYTHON=<离线ORM Python> <Node26> --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/reflection-postgres.test.ts apps/web-host/tests/im/gateway/reflection-passive-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-mixed-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-triggers.test.ts apps/web-host/tests/im/gateway/reflection-tail.test.ts apps/web-host/tests/im/gateway/reflection-trigger-upgrade.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL=<隔离PG> GUGU_IM_BOOTSTRAP_TEST_REDIS_URL=<专用Redis> GUGU_IM_FIXTURE_PYTHON=<离线ORM Python> <Node26> --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/bootstrap.test.ts apps/web-host/tests/im/gateway/host-runtime.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL=<隔离PG> GUGU_IM_BOOTSTRAP_TEST_REDIS_URL=<专用Redis> GUGU_WEBUI_TEST_REDIS_URL=<另一个专用Redis库> GUGU_IM_FIXTURE_PYTHON=<离线ORM Python> <Node26> --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/reflection-daily-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-daily.test.ts apps/web-host/tests/im/gateway/reflection-passive-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-mixed-bootstrap.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL=<隔离PG> GUGU_IM_BOOTSTRAP_TEST_REDIS_URL=<专用Redis> GUGU_WEBUI_TEST_REDIS_URL=<另一个专用Redis库> GUGU_IM_FIXTURE_PYTHON=<离线ORM Python> <Node26> --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/reflection-owner-daily-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-owner-daily.test.ts apps/web-host/tests/im/gateway/reflection-daily-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-daily.test.ts apps/web-host/tests/im/gateway/reflection-postgres.test.ts
python -m pytest tests/agent/memory/test_memory_compaction_retrieval.py tests/agent/context/test_daily_compaction.py tests/im/test_im_memory_scopes.py -q -p no:cacheprovider
python -m pytest tests/agent/context/test_daily_compaction.py tests/im/test_im_memory_scopes.py -q -p no:cacheprovider
python -m pytest tests/agent/chat/test_chat_attachments_ownership.py tests/agent/context/test_reflection_failure_lifecycle.py tests/agent/test_reasoning_state.py -k 'delete_session or failed_database_delete_keeps_reflection_buffer' -q -p no:cacheprovider
python -m pytest tests/agent/context/test_reflection_threshold.py tests/im/test_group_reflection_policy.py tests/im/test_group_reflection_snapshot_reuse.py tests/im/test_im_memory_scopes.py -q -p no:cacheprovider
```

Python 命令在 `backend/` 执行，使用只读参考代码、内存 SQLite、假 Redis 和临时文件；启动前把 `GUGU_ENV_FILE` 与 `GUGU_CONFIG_OVERRIDE_FILE` 指向临时不存在的文件。Node 若需原生媒体依赖，使用隔离环境已校验的 `NODE_PATH` 与 `ESBUILD_BINARY_PATH`。

本轮使用本任务专用临时 PostgreSQL 16 / Redis 7；每项回归结束回收自身随机 schema、键和临时文件。合成账号与空测试库验证了行锁/事务回滚、去重及隔离、绑定 CAS/Lua 预算、投递锁及收据恢复、秘密暂存/清理与交互重放，以及原持久调度取消/恢复。未访问任何已有用户数据库。Linux Node 26 与对应 esbuild/jieba 原生依赖仅放临时目录，校验官方完整性，不安装系统服务。

以上历史组件测试仍使用可控平台/Provider、部分业务端口替身，不能据此证明四个真实平台、实际代理、全格式转码或 Node/Python 部署切换已验收。本轮实际 bootstrap 与真实生产资源整链路结果单独列于增量验收表；网络边界仍为替身，生产归属没有切换。不读取真实用户配置、凭据、上传目录或其他人的机器补齐测试。

可复现命令（先准备 Node 26、现有依赖与隔离 Python 环境）：

```sh
cd packages/core
node node_modules/vitest/vitest.mjs run tests/im/access.test.ts tests/im/inbound-batch.test.ts tests/im/memory-context.test.ts tests/im/reaction-tool.test.ts tests/im/run-delivery.test.ts tests/im/feishu-message.test.ts tests/im/qq-message.test.ts tests/im/qq-text.test.ts tests/im/wechat-message.test.ts tests/im/telegram-message.test.ts tests/im/telegram-format.test.ts
node node_modules/vitest/vitest.mjs run tests/im/inbound-preflight.test.ts
node node_modules/vitest/vitest.mjs run tests/im/shortcut.test.ts tests/im/memory-search-scopes.test.ts
node node_modules/vitest/vitest.mjs run tests/im tests/agent/tools/group-context.test.ts tests/agent/providers/runtime.test.ts
node node_modules/vitest/vitest.mjs run tests/im tests/agent/tools/group-context.test.ts tests/agent/providers/runtime.test.ts tests/agent/run/engine.test.ts
node node_modules/vitest/vitest.mjs run tests/agent/providers/openai-responses.test.ts
node node_modules/vitest/vitest.mjs run tests/agent/providers/transport.test.ts
cd ../../apps/web-host
node --import tsx --test --test-concurrency=1 tests/im/gateway/*.test.ts
node --import tsx --test --test-concurrency=1 tests/adapters/redis-stream-commands.test.ts tests/live/redis-live-subscription.test.ts tests/workers/worker-consumer.test.ts
node --import tsx --test --test-concurrency=1 tests/workers/worker-consumer-batch.test.ts
node --import tsx --test --test-concurrency=1 tests/agent/agent-dispatch-worker.test.ts tests/agent/agent-run-dispatch-postgres.test.ts tests/agent-config/configured-web-provider-binding.test.ts
node --import tsx --test --test-concurrency=1 tests/agent/agent-context-builder.test.ts tests/agent/agent-context-assembly.test.ts
cd ../../backend
PYTHONPATH=.:../compat/core-python/src <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/im/
PYTHONPATH=.:../compat/core-python/src <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/im/qq/test_qq_raw_ws.py tests/agent/providers/test_qface.py
PYTHONPATH=.:../compat/core-python/src <隔离venv>/bin/python -m pytest -q -p no:cacheprovider tests/im/wechat/test_wechat_gateway_components.py tests/im/test_wechat_quotes.py
```

Python 设置 `GUGU_ENV_FILE`、`GUGU_CONFIG_OVERRIDE_FILE` 为专用临时目录配置路径，`GUGU_TEST_REAL_REDIS=0`，沿用临时存储 fixtures。PowerShell 的 PYTHONPATH 分隔符为 `;`。

真实存储复现须提供**专用隔离**连接，再从 `apps/web-host` 执行；不要复用用户服务配置：

```sh
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/delivery-store.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test --test-concurrency=1 tests/im/gateway/conversation-postgres.test.ts tests/im/gateway/attachment-ingress.test.ts tests/im/gateway/message-materializer.test.ts tests/im/gateway/bot-config.test.ts tests/im/gateway/admission-postgres.test.ts
GUGU_IM_GATEWAY_TEST_REDIS_URL='<独占隔离Redis库连接>' node --import tsx --test tests/im/gateway/inbox.test.ts
GUGU_WEBUI_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/secret-input.test.ts tests/im/gateway/interaction-lookup.test.ts
GUGU_WEBUI_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test --test-concurrency=1 tests/im/gateway/interaction-lookup.test.ts tests/agent/agent-interaction-consume.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test --test-concurrency=1 tests/im/gateway/access-postgres.test.ts tests/im/gateway/conversation-postgres.test.ts tests/im/gateway/agent-reconstructor.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/shortcut-postgres.test.ts tests/im/gateway/shortcut-controls.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/memory-search.test.ts tests/agent/agent-rag-tool-ports.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/group-context.test.ts tests/im/gateway/context-reference-codec.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' GUGU_IM_GATEWAY_TEST_REDIS_URL='<独占隔离Redis连接>' node --import tsx --test tests/im/gateway/controls-postgres.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/feishu-persistent.test.ts tests/im/gateway/delivery-store.test.ts tests/im/gateway/feishu-client.test.ts tests/im/gateway/feishu-streaming.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/reaction-postgres.test.ts tests/im/gateway/run-artifact-sender.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' node --import tsx --test tests/im/gateway/rag-context.test.ts tests/im/gateway/memory-search.test.ts tests/agent/agent-rag-tool-ports.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG连接>' GUGU_WEBUI_TEST_REDIS_URL='<独占隔离Redis连接>' node --import tsx --test --test-concurrency=1 tests/im/gateway/conversation-postgres.test.ts tests/im/gateway/attention-runtime.test.ts tests/im/gateway/pending-ask.test.ts tests/im/gateway/pending-ask-dispatch.test.ts tests/im/gateway/attention-ledger.test.ts tests/im/gateway/attention-policy-postgres.test.ts tests/im/gateway/delivery-store.test.ts
```

最后 144 项统一命令（先按下段设置全部隔离连接变量，从 `apps/web-host` 执行）：

```sh
node --import tsx --test --test-concurrency=1 tests/im/gateway/attention-runtime.test.ts tests/im/gateway/pending-ask.test.ts tests/im/gateway/pending-ask-dispatch.test.ts tests/im/gateway/attention-ledger.test.ts tests/im/gateway/attention-policy-postgres.test.ts tests/im/gateway/delivery-store.test.ts tests/im/gateway/conversation-postgres.test.ts tests/im/gateway/agent-reconstructor.test.ts tests/im/gateway/run-sender.test.ts tests/im/gateway/run-artifact-sender.test.ts tests/im/gateway/controls-postgres.test.ts tests/im/gateway/feishu-persistent.test.ts tests/im/gateway/feishu-client.test.ts tests/im/gateway/feishu-streaming.test.ts tests/agent/agent-dispatch-worker.test.ts tests/agent/agent-persistent-runtime.integration.test.ts
```

PG 用随机 schema 和合成前置表测试锁互斥、重启恢复、attempt/scope 隔离，结束清理自身 schema；不测试现有用户表。Redis 要求 Node 入站 stream 不存在的空独占测试库，仅清理本轮记录的键，不清空数据库。缺参数时明确跳过，不运行 Docker，不触发 CI，不调用付费模型。

扩大回归同时提供 `GUGU_IM_GATEWAY_TEST_DATABASE_URL`、`GUGU_IM_GATEWAY_TEST_REDIS_URL`、`GUGU_WEBUI_TEST_DATABASE_URL`、`GUGU_WEBUI_TEST_REDIS_URL` 与 `GUGU_WORKER_TEST_REDIS_URL`，后两类沿用原测试变量。POSIX Provider 绑定测试必须在 Linux/macOS Node 26 运行；跨平台复用依赖目录时应准备对应平台原生包，不能通过跳过用例伪造通过。

## 生产流式、即时反馈与成员恢复增量

最终源码审查发现并补齐了底层组件已有、生产调用方尚未接通的能力：

- QQ私聊只有可信Bot的 `private_streaming_enabled=true` 且Markdown格式才装配 `qq/persistent.ts`，其余保持普通正文链。每帧/重试重验授权及原格式/开关；原buffer、stream ID、index、msg_seq、延后ROUND_END、工具/交互边界和已投图表均进入加密投影。真实renderer的PNG经正式QQ COS uploader和media发送，图前/图后分段，final不重复全文。只有当前段零ACK且明确FAILED_CONFIRMED时才持久切换plain-buffer，去掉过期msg_id并用独立收据主动发送当前未送正文；即使前文已送也不补发前文。未知HTTP、已ACK当前段或接受后SQL失败不重发、不降级普通文本；开关两向切换不能绕过旧accepted/pending/unknown正文或流状态，恢复原模式才接续原收据。Python流式函数虽接收中间回复偏好参数，但实际不使用，Node不另加“隐藏已开启流式”的新语义。
- Telegram私聊经共享 `stream.project` 投递draft、分轮、工具摘要、图表和最终正文，不用旁路observer。预览失败只关闭预览，不能冒充正式送达；明确拒绝且本事件零正式accepted时可恢复事件初始parser/buffer，接受后DB失败或结果未知则保持inflight。15秒草稿保活与事件串行，Host在释放投递租约前 `close()` 停止timer并排空。Telegram专用存储还将外层Core收据与保活SQL按同连接FIFO执行，避免两者争用busy；退出先停止入队再排空，默认其他平台仍拒绝无意并发、漏await仍销毁忙连接。API在异步取得transport后及重试前再次复核授权。
- 飞书入队前即时表情复用Core关键词/媒体规则，只匹配本条正文、不借引用原文；首次永久准入完成后、下载/入队前发送，重复事件不重复反应。QQ已物化附件按Bot与目标隔离10秒冷却，只在私聊或可信“仅响应@、非只读且确实@”群策略下即时确认，普通/自动群与纯文本不额外发送；格式来自当前Bot。两类体验反馈失败均不吞原消息，未经授权不发送。
- `rebuildMemberSnapshot` 已由正式production bindings接入独立反思消费者。platform-user成员可像Python一样从实际持久checkpoint恢复，不再强制等下一次Run；QQ私聊/群成员按原Session/source/Bot/member及当前模型、工具、scope复核，pending消息先暂缓。跨owner/群、身份变为owner或Bot停用均拒绝，公开group仍不能借成员或owner快照放宽重建。hydrate本身零Provider HTTP，成功分支才请求实际Provider。

展示策略由Core `imDisplayPolicy`读取规范化偏好：缺省all/隐藏中间回复，群隐藏过程，飞书私聊完整展示。生产只开放已有可信工具；native确认/credential组件测试不代表模型现可发起未注册的MCP/Shell确认，当前正式waiting入口是 `ask_user`。需要上游工具/intent描述器时继续显式列缺口，不注册空Schema。

共享存储升级：新安装的 `delivery-schema.sql` 已允许feishu/qq/telegram；已有库须在停止Node消费者并审查后显式执行 `projection-platform-upgrade.sql`。启动校验拒绝仍只允许飞书的旧约束，不自动DDL。飞书原密钥派生/AAD保持，QQ与Telegram使用独立platform域；升级重复执行不改既有密文。回滚旧Node前应排空或隔离新平台投影与流式收据，不能用旧普通文本消费者重放。

隔离证据（有重叠，不相加）：最后十文件统一回归100/100、零失败/跳过，含四平台、QQ流式/真实图表、两向开关切换和零受理主动回退九个正式bootstrap场景。生产链使用真实Node Run/PG/Redis/FS、真实PNG及正式上传协议，组件替身边界另列。QQ组件与sender37/37、Telegram/FIFO/API及相邻投影44/44、成员反思PG组件17/17及正式bindings1/1；即时反馈协议链11/11、Core快捷/权限/展示规则21/21、旧schema升级1/1。Python即时反馈/Telegram流式/快照四文件原样35/35，QQ文本与回复序列另45/45，私聊流式主基线 `test_qq_final_active_delivery.py` 原样22/22；零失败/跳过。真实账号、平台网络、Provider和OS强杀未验，网络均为替身，计时/PG并发用可控夹具。

复现从仓库根目录执行；Node26与Linux原生依赖沿此前约定，PG/Redis只用任务专用服务，以下统一回归命令包含新行为及旧共享链：

```sh
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG>' GUGU_WEBUI_TEST_DATABASE_URL='<隔离PG>' GUGU_IM_BOOTSTRAP_TEST_REDIS_URL='<专用Redis库>' GUGU_WEBUI_TEST_REDIS_URL='<另一个专用Redis库>' GUGU_IM_GATEWAY_TEST_REDIS_URL='<另一个专用Redis库>' GUGU_IM_FIXTURE_PYTHON='<离线ORM Python>' GUGU_IM_ORM_PYTHON='<离线ORM Python>' node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/bootstrap.test.ts apps/web-host/tests/im/gateway/host-runtime.test.ts apps/web-host/tests/im/gateway/agent-reconstructor.test.ts apps/web-host/tests/im/gateway/feishu-persistent.test.ts apps/web-host/tests/im/gateway/qq-persistent.test.ts apps/web-host/tests/im/gateway/telegram-persistent.test.ts apps/web-host/tests/im/gateway/delivery-store.test.ts apps/web-host/tests/im/gateway/member-reflection.test.ts apps/web-host/tests/im/gateway/reflection-postgres.test.ts apps/web-host/tests/im/gateway/production-fixtures.test.ts
node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test apps/web-host/tests/im/gateway/platform-connections.test.ts
cd packages/core
node node_modules/vitest/vitest.mjs run tests/im/shortcut.test.ts tests/im/access.test.ts
cd ../../backend
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 GUGU_ENV_FILE='<临时目录>/missing.env' GUGU_CONFIG_OVERRIDE_FILE='<临时目录>/missing.json' <隔离venv>/bin/python -m pytest tests/im/qq/test_qq_instant_ack.py tests/im/feishu/test_feishu_gateway_guards.py tests/im/telegram/test_telegram_streaming.py tests/im/test_group_reflection_snapshot_reuse.py -q -p no:cacheprovider
PYTHONPATH=.:../compat/core-python/src <隔离venv>/bin/python -m pytest tests/im/qq/test_qq_text.py tests/im/qq/test_qq_reply_sequences.py tests/im/qq/test_qq_final_active_delivery.py -q -p no:cacheprovider
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 GUGU_TEST_REAL_REDIS=0 GUGU_ENV_FILE='<临时目录>/missing.env' GUGU_CONFIG_OVERRIDE_FILE='<临时目录>/missing.json' <隔离venv>/bin/python -m pytest tests/im/ -q -p no:cacheprovider
```

## Linux真实图表发送复验

此前跨盘Linux的30秒超时现已在当前隔离依赖与原生产限制下复验通过，未改源码、断言或时限：`packages/charts/test/render.test.mjs` **3/3**（真实Mermaid/TeX有序PNG约27秒、输入限制及取消）；`feishu-streaming.test.ts` 精确选择默认正式renderer用例 **1/1**（两个独立子进程顺序约48秒，PNG签名/尺寸/像素预算、multipart原字节和最终卡片均验证，只有平台HTTP替身）。先前失败保留为历史记录，本结果不证明所有图型/大图、冷缓存并发负载或真实部署性能均已验收。

从仓库根目录使用Node26与隔离Linux原生依赖执行：

```sh
node --test packages/charts/test/render.test.mjs
node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-name-pattern=默认正式renderer apps/web-host/tests/im/gateway/feishu-streaming.test.ts
```

后续Telegram真实图表回归暴露冷启动/负载下Mermaid仍可能回退源码。已按请求只加载所需MathJax或Mermaid，且仅ZenUML源码加载对应外部插件，保留全部安全校验、PNG协议和原30秒时限。最新TG双真实PNG用例通过（约31秒为两个独立子进程总耗时）；Windows renderer/worker13项及随后renderer3项通过，QQ正式Run真实PNG链通过。没有延长生产时限或用渲染替身替换PNG；本地合成测试不证明任意负载下的生产性能保证。

本次没有修改Python消费归属或访问真实平台。

## 私有推理协议增量验收

`production-resources.ts` 已统一调用 `createProviderReasoningPersistence`：四种协议的当前Run私有值与checkpoint在同一CAS事务加密保存，重建资源后按原ref、round、area digest及上下文指纹精确恢复。协议格式使用实际Provider adapter归一化身份，不直接相信配置中的原始provider字符串。Anthropic工具轮不再误走仅接受Responses的格式校验；`off`也不会丢失当前Run工具调用需要的签名。沿用既有活动表和生命周期，无新增启动DDL或Agent循环。

跨Run只支持Python实际支持的Responses和Anthropic。Anthropic成功历史事务仅发布 `history_thinking_by_tool_id` 与 `tail_blocks`，保留thinking/signature、redacted块和原位置；加载时校验持久外层配置/owner/scope，再重绑新Run的可信内部身份。Node额外的完整响应块保存在活动Run侧表，供精确恢复（包含小数工具参数），不写入Python同形成功载荷；跨Run不宣称原始wire逐块相等。OpenAI Chat与Ollama的私有工具映射只在当前Run使用，不凭临时map发明Python没有的跨Run续接。`off`会真正失效旧成功状态；已有版本CAS、授权、工具Schema、TTL、清除和错密文拒绝边界继续复用。

隔离验收：PG组件及桥接 **12/12通过**；正式TG→Redis Worker→生产Node Run/Harness→实际工具→回复的Anthropic/OpenAI Chat/Ollama **3/3通过**，Responses原有三Run拒绝回归 **1/1通过**，均零失败/跳过。Anthropic包含工具轮签名、最终redacted/tail、重启后下一Run加载及off失效；Chat/Ollama验证真实工具调用与结果恰好一次且无跨Run状态。Ollama原生结果按tool_name配对，测试最初错误要求OpenAI的tool_call_id，核对现有投影后改为对应协议契约再通过。解密checkpoint/outbox及历史、平台回复、诊断均无合成私有标记。组件重启使用全新Provider实例；生产入口在成功Run之间停止/重启Node runtime，未执行OS强杀或真实平台/Provider验收。

Python `tests/agent/test_phase2_reasoning_drivers.py tests/agent/test_reasoning_state.py` 原样 **63/63通过**；其Anthropic载荷/历史位置、Chat不支持跨Run、off/绑定/TTL/CAS为本轮基线。生产及目标测试严格类型检查通过。复现从仓库根目录执行（均使用专用隔离服务，Python临时配置同下节）：

```sh
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG>' GUGU_WEBUI_TEST_DATABASE_URL='<隔离PG>' node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/agent/agent-reasoning-persistence.test.ts apps/web-host/tests/agent/agent-reasoning-bridge.test.ts
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG>' GUGU_IM_BOOTSTRAP_TEST_REDIS_URL='<专用Redis>' GUGU_IM_FIXTURE_PYTHON='<离线ORM Python>' node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/anthropic-reasoning-bootstrap.test.ts apps/web-host/tests/im/gateway/reasoning-bootstrap.test.ts
cd backend
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 GUGU_ENV_FILE='<临时目录>/missing.env' GUGU_CONFIG_OVERRIDE_FILE='<临时目录>/missing.json' <隔离venv>/bin/python -m pytest tests/agent/test_phase2_reasoning_drivers.py tests/agent/test_reasoning_state.py -q -p no:cacheprovider
```

网络仅平台/Provider替身；PG/Redis、随机schema、合成账号、本地FS、Core、Harness及工具时钟来自实际生产接线。没有切换Python消费归属、连接真实账号或付费模型。

## Node Web与IM会话创建并发增量验收

`modules/agent-sessions/persistence/agent-chat-preparation.ts:createPostgresWebChatSession` 已加入IM保留使用的同一owner行 `FOR NO KEY UPDATE NOWAIT` 锁，持有至调用方事务提交或回滚。Web未提交的新会话不能与IM的旧计数并行创建；竞争方明确失败并回滚，由下一次请求重读，不吞错或重复发送消息。使用NOWAIT避免已持Session锁的调用方与IM候选淘汰反序等待。其他owner独立；Web保留原有不自动淘汰的语义，所以不宣称全部入口总数永远不超过50。

Node两组回归共 **22/22通过，零失败/跳过**：真实PG会话保留及Web/IM双向竞争、跨owner、提交可见性/回滚，加既有Web聊天事务、附件claim、dispatch与引用工厂。生产与3个目标测试类型检查通过；Python `tests/im/test_im_session_reuse.py` 原样 **16/16通过**。会话保留组件的墓碑hook仍为明确替身；Web事务部分附件/队列端口为替身，生产整链路证据仍以此前bootstrap验收为准。

从仓库根目录执行，配置只用专用隔离变量；Python沿上一节临时配置约束：

```sh
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG>' GUGU_WEBUI_TEST_DATABASE_URL='<隔离PG>' GUGU_IM_FIXTURE_PYTHON='<离线ORM Python>' node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/session-retention.test.ts apps/web-host/tests/agent/agent-chat-preparation.test.ts apps/web-host/tests/agent/agent-chat-preparation-postgres.test.ts apps/web-host/tests/agent/agent-web-chat-preparation.test.ts
cd backend
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 GUGU_ENV_FILE='<临时目录>/missing.env' GUGU_CONFIG_OVERRIDE_FILE='<临时目录>/missing.json' <隔离venv>/bin/python -m pytest tests/im/test_im_session_reuse.py -q -p no:cacheprovider
```

未修改Python创建者。因此Node启用后的同一数据库写域仍不得并行运行未协调的Python会话创建/恢复入口，不能把停止IM消费者等同于所有Python写入口都已停止；部署须分离写域或保持单写者。未执行生产切换。

## owner profile/pattern 周期维护增量验收

实现与生产入口均已接通：成功的普通owner反思 → `reflection-postgres.ts` 同事务登记独立维护Job → `reflection-owner-periodic.ts` → 现有真实ProviderRuntime → `reflection-files.ts` 加密文件计划 → CAS应用、用量与任务状态提交 → RAG和业务context revision通知。Core `memory/owner-periodic.ts` 负责规则，不依赖PG/Redis；没有新增Agent循环或启动DDL。

两个字段分别检查100条、较上次整理后数量新增30条、距成功7天及距尝试1小时。只由实际活跃owner反思触发，不全局扫描静默用户发模型。请求前原子记录 `.agent/pattern_maintenance.json` 中对应字段的尝试时间；成功计划冻结实际完成时间和整理后数量，保留另一字段及额外键。输入只含该字段列表和正式压缩提示词，无主历史、工具或空上下文伪装。pattern仅可保留源ID，最多70条；结构错误只纠正一次且不回显坏输出，Provider异常不额外重试。源列表、metadata或权限漂移均拒绝覆盖。

请求阶段加密持久化；过期租约重领到“请求已开始但无计划”时以 `periodic_result_unknown` 结束，不重发未知模型请求或伪造零费用。该场景用真实PG持久阶段模拟，尚未执行OS强杀验收。已有计划优先恢复，即使COMMIT实际成功但客户端回包丢失且已到第5次attempt，也不误判dead或重复模型/用量。同owner旧计划未完成时后续请求等待；成功维护不推进消息反思游标。文件提交后的业务revision通知为尽力发送，失败仅固定脱敏诊断，持久RAG任务另行恢复。

Python行为回归：`tests/agent/memory/test_memory_periodic.py`、`tests/agent/context/test_longterm_compaction.py` 原样 **15/15通过，零跳过**。Core周期规则 **9/9**；Host周期、owner daily、群daily行为 **13/13**。九文件统一回归 **45/45，零失败/跳过**，包含四平台正式bootstrap、默认Python零Node依赖、真实PG唯一归属锁、两类daily、周期五轮真实Node对话和计划恢复。生产类型检查、定向测试严格类型检查及Core普通增量构建通过；新增测试元数据132项通过。计数含重复覆盖，不相加。

整链路使用临时随机PG schema、独占Redis库、合成账号、真实Node Harness/Provider协议/本地文件；仅平台与Provider网络替身。周期测试覆盖非法来源ID纠正、失败不推进水位、1小时/7天/+30、静默不触发、计划重启、跨字段互斥、逐响应已知费用与unknown、额外metadata保留及真实Redis revision通知。真实账号、平台网络、代理和生产部署均未验收。安全差异：Python部分非有限数值会被夹取、写为非标准JSON或抛OverflowError；Node统一拒绝pattern中的非有限数值，不能据15项通过声称这些边界完全等价。

从仓库根目录复现（隔离连接变量须指向任务专用资源；Python配置路径指向临时不存在文件）：

```sh
cd packages/core
node node_modules/vitest/vitest.mjs run tests/agent/memory/owner-periodic.test.ts
cd ../..
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG>' GUGU_IM_BOOTSTRAP_TEST_REDIS_URL='<专用Redis>' GUGU_WEBUI_TEST_REDIS_URL='<另一专用Redis库>' GUGU_IM_FIXTURE_PYTHON='<离线ORM Python>' node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/bootstrap.test.ts apps/web-host/tests/im/gateway/host-runtime.test.ts apps/web-host/tests/im/gateway/reflection-daily-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-daily.test.ts apps/web-host/tests/im/gateway/reflection-owner-daily-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-owner-daily.test.ts apps/web-host/tests/im/gateway/reflection-owner-periodic.test.ts apps/web-host/tests/im/gateway/reflection-periodic-bootstrap.test.ts apps/web-host/tests/im/gateway/reflection-postgres.test.ts
cd backend
PYTHONPATH=.:../compat/core-python/src PYTHONDONTWRITEBYTECODE=1 GUGU_ENV_FILE='<临时目录>/missing.env' GUGU_CONFIG_OVERRIDE_FILE='<临时目录>/missing.json' <隔离venv>/bin/python -m pytest tests/agent/memory/test_memory_periodic.py tests/agent/context/test_longterm_compaction.py -q -p no:cacheprovider
```

回滚旧Node消费者前，除daily任务外也须排空或显式失效 `periodic:<field>:<父任务ID>` 的加密周期任务及其文件计划；旧版本不能将未知维护载荷作为普通反思完成。Python默认消费归属及其状态未修改，未执行任何实际切换。

## 初次连接失败与反馈授权补充

- 首次握手尚未交付 `GatewayConnection` 时，飞书 SDK、平台 media/client 或 Telegram API 关闭失败都透传 `GatewayConnectionCleanupError`。监督器冻结该 Bot 的未知归属，配置刷新、改版或删除不允许替代启动；其他 Bot 可继续工作。Host 停止仍拒绝释放有效消费锁，避免清理未知被误当成“没有活动连接”。正常握手失败且资源关闭成功保持原有退避重试。
- 四平台控制回复使用原 PG 准入收据的 scope、控制事件 HMAC 和首次准入时刻，每次平台发送及重试前复核当前权限；QQ/飞书的真实 Token 刷新之后也重新检查。Telegram 媒体失败通知只使用同一事件的可信 guard，`admitted` 重投不重跑秘密/控制预检，不接受载荷伪造的授权时刻。
- 最终隔离 PG 联合生命周期/协议/反馈回归74/74，零失败、跳过；其中真实 PG 验证初次清理未知后第二个 Node 仍无法取得消费锁，独立 Node 子进程实际 SIGKILL 并等待 exit 后同锁可接管。该进程用例只证明归属锁释放，不证明平台连接或 Agent Run 的强杀恢复。平台网络、授权及准入端口在对应组件测试中为明确替身，不等同真实账号或部署验收。
- 最终源码四平台正式 bootstrap 复验4/4，零失败、跳过：实际 PG/Redis/本地来源→平台适配器→IM Worker→正式 Run/Harness→原平台回复，保留重启重投不再 Run、明确拒绝的 outbox 恢复及停用配置通知断连断言；仅平台与 Provider 网络替身。生产构建与目标测试严格类型检查通过；137个新增测试的元数据检查通过。此前十文件100项快照与本节有重叠，不相加。

复现使用任务专用隔离 PG，从仓库根目录执行；解释器与隔离原生依赖沿前述约定：

```sh
GUGU_IM_GATEWAY_TEST_DATABASE_URL='<隔离PG>' node --import ./node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web-host/tests/im/gateway/host-runtime.test.ts apps/web-host/tests/im/gateway/supervisor.test.ts apps/web-host/tests/im/gateway/feishu-connection.test.ts apps/web-host/tests/im/gateway/qq-connection.test.ts apps/web-host/tests/im/gateway/platform-connections.test.ts apps/web-host/tests/im/gateway/platform-feedback-authorization.test.ts apps/web-host/tests/im/gateway/telegram-polling.test.ts apps/web-host/tests/im/gateway/wechat-polling.test.ts
```

## 切换与后续最小任务

| 后续最小切片 | 具体接线位置与边界 |
| --- | --- |
| 其他会话写入口与显式删除 | 显式删除已接 Node 同事务永久墓碑、持久GC和真实取消，隔离认证HTTP整链路5/5，含Bot停用/群停用/平台解绑后真实Provider abort与零平台出站；未知投递仍409。Node Web真实创建已加入同一owner行锁并经真实PG双向竞争/回滚/跨owner验收。Python参考创建者不参与新协议，部署须保持同写域单写者；不得修改Python参考代码或清理其Redis状态 |
| 媒体能力边界 | 原生音频附加ASR字幕及精细sessions事件已接并通过隔离验收。HEIC在默认Python生产入口也未激活解码，Node保持明确拒绝；真实HEIC解码属于后续能力补齐，不能用已安装依赖或进程内测试注册冒充旧生产支持。真实平台仍未验 |
| 相同字节媒体的稳定引用 | 已修正指纹单值覆盖：同指纹登记各附件ID，按消息锚点及原附件顺序匹配；新codec恢复不依赖异步读取完成顺序。相同图片/原发及引用语音、跨批次消息、重复固化、缺失原附件拒绝均已验；物化14/14、图片生产4/4、语音生产11/11通过。真实平台尚未验收 |
| 私有推理协议 | `agent-reasoning-persistence.ts` 已接Anthropic/Responses成功跨Run状态和四协议当前Run加密恢复；OpenAI Chat/Ollama不提供Python没有的跨Run续接。实际恢复边界及隔离证据见私有推理增量验收；真实Provider与OS强杀仍另验 |
| 反思长期维护 | 群daily、owner daily与profile/pattern周期维护均已接Core规则和正式持久消费者；周期维护的实现、生产接线、Python回归与隔离验收见上节。真实平台及进程部署仍须单独验收 |
| 执行工具与部署 | `executor.ts` / 正式 ToolRegistry 需真实 MXC/受控 MCP 接口后才能开放对应工具；Shell 仍未注册。图表Linux renderer 3/3与真实PNG→飞书上传1/1已通过且未放宽30秒上限；四个平台真实账号、故障恢复及整进程部署另验 |

Node 生产启动入口已实现，Python 消费归属不变。隔离 PG/Redis 与网络替身验收后，仍须按平台执行真实账号、进程故障和部署验收。默认 `IM__RUNTIME_OWNER=python` 不创建 Node IM 服务；只有显式设为 `node` 且 `IM__PYTHON_GATEWAY_STOPPED`、`IM__PYTHON_WORKER_STOPPED` 均为 `true` 或 `1` 才允许开始构造。断言是部署交接条件，Node 不会自行停止 Python。

切换前必须停止对应 **Python Gateway 与 Python IM Worker/消费入口**，确认旧 pending 和运行排空或完成显式移交；若 IM 与通用 Worker 共进程，先隔离消费入口或停止该进程，不能只停 Gateway。之后才能启用 Node 的唯一消费者。仅使用不同 consumer group 仍会双消费；Node 必须使用独立 stream、健康键、锁和运行命名空间，禁止清理 Python 状态。回滚也须先停 Node、核对任务/投递状态再启 Python。当前尚未执行任何切换。

Node 已构造服务在 stop 后仍保留 owner 清除围栏；默认 Python、从未构造 Node 服务的 Web 请求不访问 Node Job。因此 Node→Python 交接必须先排空或显式失效 Node 反思 Job，尤其是已经准备的文件计划；不能把默认 Python 路径的旧删除操作当成跨运行时 revision 围栏，之后直接重启遗留 Node Job。

群daily维护复用此队列，以 `daily:<上批任务ID>` 和加密 `dailyDrain` 标识独立批次，不新增启动DDL。回滚到不识别该载荷的旧Node版本前也必须先排空或显式失效这些维护任务；不能让旧消费者把维护任务按普通反思确认完成。

Node 自身的队列版本也须审查：生产批次 Worker 只接受 Gateway 控制分流后生成的 `im2` 专用准入密封，使用独立 HKDF 密钥及 AAD；普通 `im1` 收据仍可用于内部持久材料，但不能降级重跑秘密/选项预检。若曾运行旧 Node 入站原型，先排空或隔离旧 `im1` Stream，不能原样交给新消费者。消费时只重新验证当前身份、权限和群策略，避免排队旧文本被后来激活的凭据 stage 或选项消费。任意载荷布尔标记、改前缀或替换路由均不能产生可信准入。
