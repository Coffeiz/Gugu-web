# PLAN：Agent run 生命周期下一阶段边界（LLM18-009）

> 创建：2026-09-18
> 来源：PRD-LLM-18 LLM18-009（评估 IM loop 的 route/policy/execution/delivery 拆分及 web gateway 迁移，形成下一阶段边界结论；不在本阶段扩大 Runner 迁移范围）
> 前置：Phase 1-2 已落地 `agent/run/`（preparation/execution/finalization 单一实现），`runner.py` 收成 Sink 适配层（f371f185、25773fac）

## 1. 当前生命周期版图

| 入口 | 第一段准备 | 事件消费 | 收尾 | 状态 |
|---|---|---|---|---|
| `runner.run_collect`（QQ/飞书文本/定时任务经 OwnerAgentLoop 回调） | `prepare_agent_run` ✅ | `consume_agent_events(CollectSink)` ✅ | `finalize_agent_run` ✅ | 已收敛 |
| `runner.run_stream`（飞书卡流） | 同上 ✅ | `consume_agent_events(WebStreamSink)` ✅ | 同上 ✅ | 已收敛 |
| `agent/gateway/web.py`（Web SSE，含心跳/排队/续看） | **自持第三份**（stream() 内联 snapshot/history/附件准备，`_generate_unlocked` 组装） | 自持 SSE 发射循环 | 自行调 `finalize_run` | 未迁移 |
| `agent/scheduled_execution.py` | 自持（定时任务专属 snapshot 组装） | `_collect` 兼容包装（已走统一消费器） | 自持 | 消费器已统一，准备段未迁移 |

## 2. IM loop 四层拆分边界（`agent/im/loop.py`，约 1200 行）

目标形态（PRD-LLM-18 §3.4）：

```text
normalize/route -> IM policy -> Agent execution -> DeliverySink
```

- **normalize/route**：消息归一化、shortcut、命令解析、owner/member 路由（`select_loop`）。产出标准 `AgentRequest` 与路由上下文，不触碰 LLM。
- **IM policy**：`policy_for` 的平台策略、restricted 裁剪、`filter_tool_names`、群/私聊差异、显示中间回复偏好。输入请求与路由上下文，输出策略对象——不再散落在执行流程中途。
- **Agent execution**：只调 `runner.run_collect/run_stream`（或未来 `agent/run` 的直连入口），经 `on_interaction`/`on_tool_event`/`on_round` 回调拿事件。
- **DeliverySink**：QQ 分轮发送、飞书 CardKit patch、传输失败 drain。把现在 loop.py 里"消费 token/round 并发送"的代码收成显式 Sink 对象，与 `CollectSink`/`WebStreamSink` 同一事件契约（FR-RUN-02 表）。

迁移顺序建议（每步独立可回滚）：

1. 先抽 DeliverySink：loop.py 的 QQ/飞书发送回调改为 Sink 对象，行为不变；
2. 再抽 normalize/route 与 policy：纯搬运 + 单测；
3. 最后删 loop.py 内残留的生命周期副本。

红线：迁移期间 QQ/飞书真实客户端回归（分轮、CardKit、drain）必须每步跑；`group_mode`/restricted 语义不变。

## 3. web gateway 迁移边界（`agent/gateway/web.py`）

web.py 是最早的第三条生命周期，特点是 SSE 协议帧（started/phase/notice/done/queued_baseline 等）、生成租约心跳、排队任务与续看（resume）。迁移方案：

- **准备段**：`stream()` 内联的 snapshot/history/附件准备改调 `prepare_agent_run`。差异点需先收编为参数：乐观用户消息与 pending_queue 确认、quota 预检前置（web 在读库前就返回 4xx 语义）、greeting/references 注入。建议在 `prepare_agent_run` 增加 web 专属 option 对象，而非 if-web 分支（PRD 风险表：平台条件显式传入）。
- **消费段**：`_generate_unlocked` 的 SSE 发射循环改 `WebStreamSink` 扩展形态（SSE 帧映射属前端协议，保持帧格式逐字节兼容）。
- **收尾段**：`finalize_run` 调用切 `finalize_agent_run`；web 的 origin 回声抑制已统一。

顺序建议：先做 heartbeat/queued/resume 的回归测试加固（现状无专门测试），再动准备段，最后动 SSE 发射。

## 4. 不迁移项

- `scheduled_execution.py` 的准备段：定时任务有自己的 snapshot 组装（无会话交互语义），收益低；其事件消费已统一。可在他处需要改定时任务时顺手迁移。
- `agent/loop/machine.py` 状态机与 `loop_drivers.py`：PRD-LLM-25 产物，本边界不触碰。

## 5. 验收基线

- `tests/test_run_preparation_parity.py`、`tests/test_run_lifecycle.py` 持续全绿；
- 迁移 web 前先补 SSE 帧协议的 characterization 测试（锁定现有帧序列）；
- 迁移 IM 前确认 QQ/飞书真机回归路径（devserver 5173 + 真机账号）。
