# Agent 系统架构

> 本文描述当前 Gugu-web 的 Agent 模块如何分层、协作和隔离。具体接口参数、平台细节和部署命令以代码及对应专题文档为准。

## 1. 架构原则

1. 渠道适配与 Agent 编排分离。Web、QQ、微信、飞书和定时任务可以有不同的输入输出协议，但共用同一套 run/round、上下文、工具和持久化逻辑。
2. Canonical history 是工具调用、工具结果和交互状态的语义事实源。Provider 或渠道只能转换展示格式，不能重新定义消息语义；Provider 私有推理续接状态单独存储，不能写入 canonical history。
3. 权限由后端代码决定。提示词可以说明稳定的行为规则，但不能替代注册过滤、用户设置、会话状态和 dispatch 校验。
4. 上下文组装集中管理。Snapshot、History、RAG、Memory、Knowledge 和当前消息按固定顺序组装，渠道层不自行拼接第二套上下文。
5. 业务执行与安全边界分离。危险确认控制误操作，Shell 容器、身份、网络和配额控制真正的执行边界。

## 2. 总体分层

```text
Web / QQ / 微信 / 飞书 / 定时任务
                |
          Gateway / Router
                |
        ConversationSession
                |
        Agent Orchestration
       Run -> Round -> Tool loop
                |
  +-------------+-------------+
  |             |             |
Context     Capability     Provider
Snapshot    Tool/Skill     LLM adapters
History     Permission     Retry/stream
RAG/Memory  Interaction
                |
       Business Tool Execution
                |
 PostgreSQL / Redis / Storage / sandboxd
                |
      LoopScope / Usage / Audit
```

模型级 `reasoning_persistence` 在 run 开始固定，由
`ReasoningStateCoordinator` 负责 provider state 的加载、恢复、提交和失效；状态服务独立于
canonical history。LoopScope 只接收受限生命周期摘要，Provider payload 不进入普通历史、日志或
渠道消息。

当前主链路由 Python/FastAPI 承担。TypeScript 主要提供 RAG lexical worker 和 LoopScope 相关服务，不是完整的 TypeScript Agent 后端。

## 3. 服务与进程

### 3.1 `gugu-backend`

FastAPI 业务服务，提供用户态和 Admin API，同时承载 Web Agent 请求、核心业务服务和 Agent 共享模块。

### 3.2 `gugu-worker`

消费 Redis 中的 IM 入站消息，调用统一 Agent loop，并把阶段性结果和最终结果交给对应渠道发送。

### 3.3 `gugu-gateway`

根据用户机器人配置管理 QQ、飞书、微信等 IM 网关进程或连接生命周期。它负责连接和进程管理，不负责重新实现 Agent 推理。

### 3.4 TypeScript services

TypeScript lexical worker 为 RAG 提供常驻词法索引、BM25 搜索、索引 patch 和评分能力。LoopScope 的 TypeScript 服务负责接收和查询运行诊断数据。

### 3.5 `sandboxd`

Shell 沙盒执行服务。生产普通用户的 Shell 请求通过 Docker 执行器进入容器边界，执行结果再返回 Agent。沙盒不可用时不得静默回退到宿主机执行器。

### 3.6 基础设施

- PostgreSQL：用户、业务对象、会话、消息、工具交互、记忆和审计等持久数据。
- Redis：IM 入站队列、实时事件、临时状态和部分跨进程协调。
- Local/OSS storage：用户文件、附件和其他持久文件内容。

## 4. 核心模块边界

### 4.1 Gateway

位置：`backend/agent/gateway/` 和各渠道的 `agent/im/` 适配代码。

负责：

- 解析平台消息、附件、引用和身份信息。
- 找到或创建 `ConversationSession`。
- 将平台请求转换为统一 Agent 请求。
- 将 Agent 事件转换为 Web、QQ、微信或飞书的发送格式。

不负责：

- 不决定模型是否调用工具。
- 不自行组装完整 LLM 上下文。
- 不绕过统一权限和确认门。

### 4.2 Agent orchestration

位置：`backend/agent/runner.py`、`backend/agent/core.py`、`backend/agent/router.py`。

负责：

- 建立 run 和 round 生命周期。
- 调用上下文准备、LLM provider 和工具执行器。
- 处理并行或连续工具调用、交互等待、取消、重试和结束条件。
- 记录消息、工具事件、用量和诊断信息。

其中 Provider 推理状态的诊断只记录 `off/summary/miss/reused/unavailable/expired/provider_rejected`
等状态、计数、大小和 digest，不记录推理正文、用户正文、完整工具参数或凭据。

不负责：

- 不实现某个渠道的独有展示。
- 不把 provider 的 wire message 当作持久化事实。

### 4.3 Context

位置：`backend/agent/context/`。

负责：

- 读取 Snapshot、History、Memory、Knowledge、RAG 和当前消息。
- 以 provider-neutral 结构生成本轮上下文。
- 维护上下文预算、压缩、baseline 和缓存前缀稳定性。
- 在 provider 边界执行必要的协议转换。

不负责：

- 不决定工具权限。
- 不执行工具。
- 不把系统提示词、Snapshot 或当前消息交给历史压缩器随意改写。

### 4.4 Capability

位置：`backend/agent/capabilities/`、`backend/agent/tools/`、`backend/agent/skills/`。

负责：

- 读取工具和 Skill 注册信息。
- 根据用户、会话、平台和 Admin 设置过滤可用能力。
- 按需提供工具 Schema，并校验工具输入。
- 维护 `ask_user`、确认门等交互能力。

工具描述和 Skill 正文是模型参考信息；最终 dispatch 校验仍由代码执行。

### 4.5 Provider

位置：`backend/agent/providers/` 和 `backend/agent/llm/`。

负责：

- 将 canonical context 转成供应商协议。
- 处理流式输出、tool call、tool result、模型上下文限制和有限重试。
- 将供应商响应转换回统一的 Agent 事件。

不负责：

- 不改变历史中工具调用的名称、参数或结果归属。
- 不决定是否注入某个 RAG 来源。

### 4.6 RAG、Memory 与 Knowledge

位置：`backend/agent/rag/`、`backend/agent/memory/`、`backend/agent/knowledge/`。

- RAG 负责按 scope 和来源召回上下文候选，并通过 TypeScript lexical worker 完成词法检索。
- Memory 负责用户相关的长期信息和反思结果。
- Knowledge 负责项目、系统、规则、流程和资料结论，不等同于个人 Memory。

三者都只能输出供 Context 层使用的结构化上下文，不应直接修改当前消息或越过权限边界。

### 4.7 Tool execution

工具执行位于 `backend/agent/tools/` 及其业务服务调用方。

```text
Tool schema
    -> 参数校验
    -> ownership / permission
    -> destructive confirmation（如需要）
    -> 业务服务或 sandboxd
    -> canonical tool result
    -> history / channel event
```

文件、项目、日历、画布、通知、联网和 Shell 等工具共享这条校验和结果链路，不能由单个渠道直接调用底层服务伪造成功结果。

## 5. 一次请求的数据流

```text
1. 渠道收到消息
2. Gateway 归一化文本、附件、身份和会话标识
3. 读取或创建 ConversationSession
4. 读取 session snapshot 与已持久化 history
5. 读取当前权限能力、Memory、Knowledge 和 RAG 候选
6. Context 生成 canonical messages
7. Provider 发起 LLM round
8. 无 tool call：持久化最终回复并结束
9. 有 tool call：校验、执行、持久化工具事件和结果
10. 继续下一 round，直到最终回复、暂停交互或失败
11. 渠道适配器发送事件和最终结果
12. 写入 LoopScope、用量、审计和会话状态
```

当前消息与 RAG 的边界必须在第 4 步确定：自动召回不应把本轮刚发送、尚未成为历史上下文的用户消息再次作为可召回对话内容。

## 6. 持久化边界

| 数据 | 主要存储 | 说明 |
|---|---|---|
| 用户和业务对象 | PostgreSQL | 按用户归属隔离 |
| Session / Message | PostgreSQL | 保存会话状态和 canonical history |
| 工具调用 / 交互等待 | PostgreSQL | 支持确认、恢复、过期和审计 |
| IM 入站队列 | Redis | 跨进程传递消息，不替代消息持久化 |
| 文件和附件 | Local/OSS | 元数据与物理对象分离 |
| RAG 文档和索引 | PostgreSQL、进程缓存、TS worker | 通过 revision、TTL 和 patch 更新 |
| Run / Round / Span | LoopScope 存储 | 用于执行诊断和性能分析 |

展示消息不是唯一事实源。刷新页面或切换渠道时，应从结构化历史重新渲染，而不是依赖某一次流式显示结果。

## 7. 权限与安全边界

权限判断至少经过以下层次：

```text
Admin capability switch
    -> user setting
    -> session / channel context
    -> registry filtering
    -> tool dispatch validation
    -> executor boundary
```

其中：

- Admin 关闭能力时，用户侧应隐藏该能力入口并拒绝调用。
- 用户和会话设置只能缩小权限，不能扩大 Admin 未开放的能力。
- 文件和数据库查询必须检查用户归属。
- destructive 工具必须经过确认门。
- Shell 的危险命令分类只用于确认提示；Docker sandboxd 才是普通用户执行 Shell 的隔离边界。

## 8. 可观测性

每次 Agent 执行以 run 为主实体，内部包含多个 round 和 span。诊断至少覆盖：

- LLM 输入、输出和 token/cache 使用。
- 工具调用、参数校验、结果和耗时。
- RAG 来源、候选数、命中数、过滤原因、索引和 worker 耗时。
- 上下文组装、压缩、重试、取消和最终状态。

LoopScope 用于查看这些运行事实；普通业务日志仍须遵循脱敏和最小化原则。

## 9. 当前限制

- Agent 业务主链路仍是 Python，TypeScript 只承载已拆出的专项服务。
- 不同 IM 平台仍需要独立的发送格式适配，不能保证所有平台支持相同的交互卡片能力。
- RAG 的文档读取、索引缓存和跨 scope 处理仍需要同时关注数据库、Python service 和 TS worker 三层边界。
- Shell 的本机执行器和 Docker 沙盒具有不同安全语义，生产普通用户不能把本机执行器当作隔离环境。

后续新增或重构模块时，应先明确它属于哪一层、拥有哪条数据边界，以及是否复用现有 canonical history、权限校验和可观测性链路。
