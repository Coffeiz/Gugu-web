# PRD — LoopScope 0.1：Gugu AgentLoop 开发与 Trace 调试工具

## 1. 文档状态

- 状态：0.1 首版实现
- 基线：`dev`
- 开发分支：`feat/loopscope-v0.1`
- 目标：先服务 Gugu 的真实 AgentLoop 调试，但从目录、协议、运行和持久化边界上保证未来可以整体拆成独立仓库。

## 2. 产品定位

LoopScope 不是单纯的日志/Trace 列表，而是一个围绕 **Session → Turn → Run → Span** 组织的 Agent 开发环境：

1. 开发者可以在完整对话界面里与真实 Agent 连续多轮对话。
2. 同一个界面可以在「普通」和「详细」模式间切换。
3. 每个 Session 有独立监控页，可以查看该会话每一轮 Run 的完整 loop。
4. 每个节点可展开检查 timing、输入、输出、prompt、模型候选草稿、tool arguments/result、guard follow-up 等。
5. 用户可从 `/dev` 进入 LoopScope，但 LoopScope 本身不 import Gugu 前后端源码。

> 「详细模式」只展示应用明确产生/捕获的调试字段，例如 prompt、模型候选输出、结构化 reasoning summary（如果 provider/应用显式提供）、tool call 和 guard 事件。LoopScope 不尝试提取或展示模型私有隐藏思维链。

## 3. 0.1 架构约束

### 3.1 仓库边界

```text
Gugu-web/
├─ frontend/
├─ backend/
└─ loopscope/
   ├─ frontend/
   └─ backend/
```

硬约束：

- `loopscope/frontend` 是独立 Vite + Vue 工程。
- `loopscope/backend` 是独立 FastAPI + SQLite 工程。
- LoopScope 不能通过相对路径、alias 或 workspace source import 调用 `frontend/` / `backend/` 源码。
- Gugu 侧只允许存在很薄的 instrumentation/adapter；本版复用 `backend/agent/runtime/trace.py` 作为已有 trace 边界。
- 把 `loopscope/` 整体复制到空目录后，应仍可独立安装、启动和测试。

### 3.2 设计系统

LoopScope 复制当前 Gugu 需要的基础 token 值到自己的 `frontend/src/styles/tokens.css`，之后由 LoopScope 自己维护，不自动引用/同步 Gugu token 文件。

必须提供 `/tokens` 独立令牌页面，展示：

- 色板与语义色
- typography
- spacing
- radius
- elevation
- trace semantic tokens
- 常用控件/状态

### 3.3 持久化

LoopScope 使用独立 SQLite：

```text
loopscope/data/loopscope.db
```

首版开启 WAL。结构化元数据和 JSON payload 直接存 SQLite，不引入 PostgreSQL/Redis/Artifact Store。

## 4. 核心信息模型

```text
Session
└─ Turn / Run
   ├─ Context span
   ├─ LLM round span
   ├─ Tool span
   ├─ Guard/follow-up span
   └─ Output
```

0.1 Collector payload 以完整 Run snapshot 为传输单位。Gugu Agent 执行不等待 LoopScope：发送失败只丢调试数据，不影响 Agent 主链路。

## 5. 功能需求

### FR-1 多 Session 对话工作台

- 左侧展示 Gugu 当前用户的多个会话。
- 可创建新会话并连续发送多轮消息。
- 会话切换后加载对应历史。
- 通过 `/dev` 打开时，用 `postMessage` 在内存/SessionStorage 中传递本地开发 token 与 API 地址；token 不进入 URL，也不写 LoopScope SQLite。
- 支持直接打开 LoopScope 后在 Settings 手工配置 Gugu api/token。

### FR-2 普通 / 详细对话模式

普通模式只展示对话结果和基础 run 状态。

详细模式额外展示：

- Run id / trace id
- 总耗时 / token usage
- 每轮 LLM
- tool calls
- guard / follow-up
- 模型候选草稿（应用可见输出，不等同隐藏思维链）
- 关键 input/output 预览

### FR-3 Session 独立监控页

路由：

```text
/sessions/:sessionId/monitor
```

每个会话独立查看：

- Run 列表
- 完整 Span 顺序
- kind / name / status / duration
- 节点展开
- input / output / attributes
- prompt/messages
- tool args/result
- 模型候选输出

### FR-4 Gugu Trace 接入

0.1 在 Gugu 现有 `agent.runtime.trace` 边界上增加 **仅开发配置启用** 的 LoopScope hook：

```env
LOOPSCOPE_ENABLED=true
LOOPSCOPE_ENDPOINT=http://127.0.0.1:4320
```

hook 负责：

- 绑定 Web conversation session id
- 捕获 LLMRunner 输入
- 包装每个 `driver.run_round`
- 包装统一 `registry.dispatch`
- 捕获模型候选输出/usage/tool_calls
- 捕获 tool arguments/result
- 捕获 `_new_round` 后追加的内部 follow-up prompt 作为 guard span
- 捕获最终对用户发布的 sanitized token 作为 Run output
- Run 完成后 best-effort 异步发送给 LoopScope Collector

默认关闭；LoopScope 不可用时 Agent 行为不变。

### FR-5 Collector / SQLite

API：

```text
POST /api/collector/runs
GET  /api/sessions
GET  /api/sessions/{session_key}/runs
GET  /api/runs/{run_id}
GET  /api/health
```

### FR-6 Design Tokens 页面

`/tokens` 是 LoopScope 自己的 design system 验收页，不读取 Gugu 源码。

## 6. 非目标（0.1）

- 不做 SaaS / 团队账号 / RBAC。
- 不做 PostgreSQL、Redis、独立 Artifact Store。
- 不做从任意 Span checkpoint 恢复执行。
- 不做自动 Prompt 优化/Eval/Dataset 平台。
- 不承诺完整 OpenTelemetry 兼容。
- 不抓取模型私有隐藏 chain-of-thought。
- Raw IM / Scheduler 入口协议预留，首版 UI 先聚焦 Web 连续对话与真实 loop trace；后续通过独立 adapter 加入，不把渠道逻辑写死在 Scope core。

## 7. 0.1 验收

1. `loopscope/frontend`、`loopscope/backend` 可独立运行。
2. 有独立 SQLite/WAL。
3. `/dev` 使用 Gugu 设计令牌重做，并可点击进入 LoopScope。
4. LoopScope 可接收 `/dev` 安全 bootstrap，不把 token 放 URL/SQLite。
5. 可查看多个 Gugu session 并进行连续对话。
6. 对话可切普通/详细模式。
7. 每个 session 有独立 monitor 路由。
8. monitor 能展开每个节点查看详细输入/输出。
9. Gugu 启用 `LOOPSCOPE_ENABLED` 后可上报真实 prompt、LLM rounds、tools、guards、final output。
10. LoopScope 关闭/不可达不影响 Gugu AgentLoop。
11. `/tokens` 可独立检查 LoopScope token、elevation、motion 和 Trace semantic 状态。
12. `loopscope/docker-compose.yml` 可把独立 frontend/backend 与 SQLite volume 一起拉起，但两者仍保持独立进程。
