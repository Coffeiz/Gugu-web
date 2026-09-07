# Agent 职责边界

本目录承载 Agent 的通用运行能力。本文档固化模块职责和依赖方向，避免把 Web、IM、定时任务或供应商细节继续堆回 `runner.py`。

## 总体原则

一次 Agent 运行的职责流向如下：

```text
Web / IM / 定时任务入口
        ↓
应用运行编排（runner）
        ↓
上下文组装（context） + 模型工具循环（core）
        ↓
Provider / Tool
        ↓
运行结果收口、持久化和记忆后处理
        ↓
入口适配层输出（SSE / IM 消息 / 定时任务投递）
```

边界规则：

- `core` 不感知 Web、IM、Redis、HTTP/SSE 或平台发送。
- `context` 只组装一次运行所需的消息和上下文，不发送、不持久化、不负责 baseline。
- `runner` 是应用级运行编排器，不是传输层，也不是平台网关。
- `gateway/web` 负责 Web 协议、SSE 事件和页面展示语义，不实现另一套模型工具循环。
- `im/loop` 负责 IM 平台入口、身份/权限、快捷指令、输入输出和活动状态，不复制模型循环。
- 标题、摘要和后台会话任务统一由 `conversation/lifecycle.py` 负责。
- 定时触发、锁、重试和投递由 `app.scheduled_tasks` 负责；单次 Agent 执行由 `scheduled_execution.py` 负责。

## 模块职责

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `core.py` | Provider 调用、流式轮次、工具派发、继续/恢复、工具调用守卫和模型循环状态 | Web/IM 传输、会话持久化、平台消息发送 |
| `context/run_context.py` | 历史消息、RAG 尾部、provider 清洗、媒体、当前用户和消息顺序的统一组装；生成 `PreparedRun` | 调用 LLM、工具执行、发送事件、写数据库 |
| `runner.py` | Web/IM 共用的运行编排：配置、会话、上下文、附件、配额、能力过滤、调用 `LLMRunner`、结果收口、持久化和记忆后处理 | HTTP/SSE 协议、IM 平台路由和发送、定时器调度 |
| `gateway/web.py` | Web 请求、SSE 订阅/恢复、token/round/timeline 事件、Web 错误和完成态、页面可见的运行状态 | Provider 细节、工具循环、IM 规则 |
| `im/loop.py` | IM 消息进入、ActorContext/AgentRequest、身份和权限、快捷指令、typing/activity、平台回复和交互确认 | Provider 调用和模型工具循环 |
| `im/context_runtime.py` | IM 专属的记忆快照、身份块、引用消息、连续性桥接和主动引导投影 | 通用上下文组装、Web 展示 |
| `conversation/lifecycle.py` | 标题/摘要 prompt、生成、后台调度和会话生命周期任务 | Web/IM 传输和模型主循环 |
| `scheduled_execution.py` | 把一个已触发的定时任务转换为一次非流式 Agent 执行，返回文本、错误和元数据 | 触发、锁、重试、计划状态和外部投递 |
| `memory/reflection_input.py` | 统一构造反思输入，区分群聊/私聊边界并过滤工具结果 | 运行循环、Provider 调用和消息发送 |
| `outbound.py` | 对外输出前的确定性清洗和格式化 | 生成模型回复、平台路由 |
| `runtime/` | 跨进程运行状态和 trace/观测能力 | 业务编排和用户可见文案 |

## 调用方向

允许的主要依赖方向：

```text
gateway/web ─┐
im/loop     ─┼→ runner → context / core / memory / conversation lifecycle
scheduled   ─┘

core → providers / tools
context → context 数据源和纯组装逻辑
```

新增代码遵守以下约束：

1. Provider 参数、工具循环、工具结果替换或调用上限，放到 `core.py` 或对应 provider/tool 模块。
2. 历史拼接、压缩边界、RAG 尾部、媒体消息和 provider 格式差异，放到 `context/`；不要在 Web、IM、定时任务入口各维护一份。
3. 共用的运行前后处理放到 `runner.py` 或独立的领域模块；不得从 `runner` 反向导入 `gateway/*`、平台 gateway 或 HTTP/SSE 实现。
4. Web 的 token、round、timeline、`done` 和 `session_title` 事件只在 `gateway/web.py` 映射；不要把 SSE 事件名写入 `core` 或通用上下文。
5. IM 的 owner/member、平台身份、快捷指令、typing、确认交互和发送失败处理只在 `im/`；不要把平台分支塞进模型循环。
6. 标题和摘要统一调用 `conversation.lifecycle`；不要在入口或 runner 重新实现 prompt、后台任务和重复调度。
7. 定时任务的计划状态、锁和重试属于 `app/scheduled_tasks`；`scheduled_execution` 只处理一次执行。
8. 新的跨入口能力优先提取为无平台依赖的 service/helper，并补充对应边界测试；不要复制到第三个入口。

## Web 运行边界说明

Web 为了实现实时 SSE，目前在 `gateway/web.py` 保留了部分直接消费模型事件的代码；这属于 Web 事件适配，不应扩展成第二套运行逻辑。后续如需继续拆分，应提取共享的 prepared-run/执行结果协议，让 Web 只负责事件映射，不能把 Web 细节下沉到 `runner` 或 `core`。

`runner.py` 中的 `run_scheduled_execution` 仅保留旧导入路径兼容。新代码应直接导入：

```python
from agent.scheduled_execution import run_scheduled_execution
```

不要新增对 `runner` 私有 helper 的跨模块依赖。

## 修改前检查清单

- 这是通用运行能力，还是入口/平台展示能力？先确定归属再改代码。
- 是否会引入 `core → gateway/im/app` 的反向依赖？如果会，停止并重新拆边界。
- 是否有第二份历史拼接、工具循环、标题摘要或调度逻辑？优先复用现有模块。
- 是否需要持久化或改变运行配置？先检查数据流、权限边界和现有测试。
- 临时探针、诊断脚本和测试中间产物验证后必须删除，不进入 `backend/agent`。

## 变更后验证

后端行为变更至少执行：

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q
.venv/bin/python -m compileall -q agent app
```

只修改文档或纯重命名时，至少执行：

```bash
git diff --check
```
