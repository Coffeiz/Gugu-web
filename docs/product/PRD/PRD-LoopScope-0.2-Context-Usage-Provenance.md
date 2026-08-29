# PRD — LoopScope 0.2：Context & Usage Provenance

## 1. 状态

- 状态：实现
- 基线：`dev`
- 日期：2026-08-17
- 前置：LoopScope 0.1 已合并并完成基本可用性测试。

## 2. 目标

0.1 能回答「Agent 这一轮做了什么」。0.2 继续回答：

1. 这个 Span 实际调用的是哪个 Python 文件 / 函数？
2. Context 到底从哪些来源组装？
3. 哪些 Markdown Prompt 被读取，文件原文是什么？
4. 哪些 Memory / DB 数据被加载并进入本轮？
5. 每轮 LLM 实际消耗多少 input / output token，多少来自 cache？
6. 哪个 Context / Tool 让下一轮 Prompt 变大？

## 3. Monitor UX

Monitor 不再是独立页面。

```text
Session sidebar | Current Session
                | [Conversation] [Monitor]
```

点击 Monitor 只切换当前 Session 的主体布局，Session 列表、标题和当前 Session 身份保持不变。

Span 卡片默认只显示：

- kind / name / status
- duration
- Python source
- token usage / token impact 摘要

以下面板独立开关，不再“一次展开全部”：

```text
[Content] [Input] [Output] [Source] [Attributes]
```

## 4. Code Provenance

每个 Span 增加：

```json
{
  "code": {
    "file": "backend/agent/tools/calendar.py",
    "module": "agent.tools.calendar",
    "function": "list_events",
    "qualname": "list_events",
    "line": 128
  }
}
```

Tool Span 指向真实 handler；LLM Span 指向 provider driver 的 `run_round`；Guard/State 指向 `LLMRunner._run_loop`；Context 来源指向 loader / builder。

## 5. Context Provenance

Gugu 业务返回值不为 LoopScope 改 shape。开发期开启 LoopScope 时，在现有统一边界旁路包装：

- `agent.context.loaders.*`
- `agent.context.builder.build`
- `LLMRunner._run_loop`

Context Assembly 下可出现：

```text
Context Assembly
├─ DB · Projects
├─ DB · User timezone
├─ DB · Calendar events
├─ DB · Files overview
├─ DB · Style preferences
├─ Memory retrieval
├─ persona.md
├─ skills.md
├─ policy.md
├─ default.md
├─ Rendered project context
├─ Rendered calendar context
├─ Rendered files context
├─ Assembled memory block
├─ Prompt stable prefix
├─ Prompt dynamic suffix
└─ Conversation messages sent to loop
```

Prompt file Span 的 Content 面板必须可查看文件正文；DB / Memory Span 的 Output 必须能查看本轮实际读取的数据。

## 6. Token 模型

### 6.1 Provider actual usage

Run 和 LLM Span：

```text
input
output
cache_read
cache_write（provider/driver 可得时）
fresh_input
total
cache_ratio
```

实际 usage 与本地估算不可混用。

### 6.2 Context / Tool token impact

非 LLM Span 使用估算字段：

```text
source_tokens
included_tokens
argument_tokens
result_tokens
prompt_tokens_estimate
prompt_growth_estimate
```

UI 必须用 `~` 明示其为估算值。

## 7. 持久化

SQLite 增加：

```text
runs.usage_json
spans.code_json
spans.usage_json
spans.token_impact_json
```

0.1 数据库启动时 `ALTER TABLE` 原地迁移，不要求删除历史数据。

## 8. Changelog

仓库增加 `loopscope/CHANGELOG.md`；前端增加 `/changelog` 页面。后续 LoopScope 用户可见能力 / Trace schema / storage migration 都必须记录。

## 9. 非目标

- 不实现源码编辑器；只展示源码定位 metadata。
- 不通过 LoopScope Server 主动读取 Gugu 源码目录。
- 不抓取模型私有隐藏 chain-of-thought。
- 不把所有 SQLAlchemy 查询全局录制；0.2 聚焦「真正参与 Agent Context 的 loader」。
- 不做 Replay / Run Diff。

## 10. 验收

1. Monitor 不再有 `/sessions/:id/monitor` 独立路由。
2. 当前 Session 内可在 Conversation / Monitor 间切换。
3. Span Input / Output 可分别展开。
4. Span 能显示 `.py` 文件、函数和行号。
5. Context 下能看到 Prompt 文件，并单独打开正文。
6. Context 下能看到 Memory 与 DB loader 的真实输出。
7. Run 顶部显示总体 token 与 cache read。
8. 每个 LLM Span 显示实际 token；Context / Tool 显示估算 token impact。
9. 0.1 SQLite 可原地升级。
10. 有仓库 Changelog 与应用 Changelog 页面。
11. LoopScope 关闭或不可达不改变 Gugu AgentLoop 行为。
