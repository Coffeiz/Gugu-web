# 群定时任务完整 loop（imctx + 群记忆注入） PRD

> 状态：✅ 已实施（代码完成，测试通过，待评审合并）
> 创建：2026-08-07
> 最近更新：2026-08-08
> 关联模块：`backend/app/scheduled_tasks.py`、`backend/agent/runner.py`、`backend/agent/imctx.py`、`backend/agent/im/context_loader.py`
> 关联文档：[`PRD-IM-6-IM会话复用与消息窗口裁剪.md`](./PRD-IM-6-IM会话复用与消息窗口裁剪.md)、[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)、[`【已完成】PRD-SCHEDULE-1-定时任务完整AgentLoop执行.md`](./【已完成】PRD-SCHEDULE-1-定时任务完整AgentLoop执行.md)

## 0. 背景与问题

### 0.1 现状：群定时任务到点执行时是「裸」状态

用户在 QQ 群通过咕咕的 `create_scheduled_task` 工具创建群定时任务时（`delivery_mode="current_group"`），`delivery_targets` 写入 `chat_type: "group"` 的群目标（`backend/agent/tools/scheduled_tasks.py:51-89`）。任务到点触发时，`execute_task` 走 `_run_agent` 跑 AgentLoop，**但 imctx 是空的**：

- `backend/app/scheduled_tasks.py` 全文无 `set_im` 调用
- `backend/agent/runner.py` 全文无 `set_im` 调用
- IM 路径的 `set_im` 是在 worker 处理 IM 消息时设的，定时任务路径不经过

**后果**：
1. 群定时任务执行时，`group_context_search` 工具硬拦（`agent/tools/group_context.py:11-14`：`if im.get("chat_type") != "group" → 返回「当前不在群聊上下文」`）——即使 system prompt 提示「本任务要发到 X 群」，模型也查不了群消息。
2. 群长期记忆（`agent/memory/scopes.py` 的 `MemoryScope(scope_type="group")`）不加载：执行阶段走 `loaders.load_memory(user_id)`，只读 owner 私聊 `.agent/`，**完全读不到群 profile/summary/daily/memory**。
3. 模型在 system prompt 里看到的还是「owner 的私人项目/事件/文件/记忆」上下文，与「任务要发到 X 群」的语义割裂——产出文本可能引用 owner 私有内容，**在群场景下存在信息泄露面**。

### 0.2 目标

让群定时任务到点执行时**复用群聊主路径的 imctx + 群记忆加载机制**：

1. **imctx 注入**：`_run_agent` 检测到 `delivery_targets` 含群目标时，调 `set_im(chat_type="group", chat_id, channel_id, puid)`，让群路径的工具（`group_context_search`）可用。
2. **群记忆注入**：复用 `agent.im.context_loader.load_im_memory` 的群记忆读取路径，把 `format_im_memory(...)` 拼到 system prompt 末尾，**不破坏** owner 记忆的注入（owner 记忆合理加载，用户接受）。
3. **作用域隔离**：imctx 用 ContextVar，作用域只在「本轮 execution」任务内；`set_im` 后必须保证同 task 内 execution → report 阶段可见，任务结束时用 `finally: imctx.clear()` 显式清理，不污染其他任务。
4. **不影响私聊/网页任务**：群目标才走这条路径，私聊/Web 任务的现有行为零变化。
5. **最小化改动**：不重写 `_run_scheduled_once`、不动 `builder.build` 签名、不动 `agent/tools/` 任何工具实现。

## 1. 设计

### 1.1 触发条件

`_run_agent` 入口检测 `delivery_targets` 中是否存在 `chat_type == "group"` 的目标：

```python
def _detect_group_target(target_map: dict | None) -> dict | None:
    """从 delivery_targets 抽第一个群目标（单群假设，符合 delivery_mode 工具语义）。"""
    if not isinstance(target_map, dict):
        return None
    for channel, tgt in target_map.items():
        if isinstance(tgt, dict) and tgt.get("chat_type") == "group" and tgt.get("chat_id"):
            return tgt
    return None
```

- 单群假设：`delivery_mode="current_group"` 工具只写一个 key（`backend/agent/tools/scheduled_tasks.py:75-87`），`delivery_targets` 至多一个群目标。
- 多群场景暂不支持（与 `delivery_mode` 工具的当前约束一致）；将来要支持再让 `_run_agent` 串行跑多次。
- 没匹配到群目标 → 完全不动 imctx，行为与现状一致。

### 1.2 imctx 注入

在 `backend/app/scheduled_tasks.py` 的 `_run_agent` 开头：

```python
group_target = _detect_group_target(target_map)
im_token = None
if group_target:
    from agent.imctx import set_im
    im_token = set_im(
        platform=group_target["platform"],
        message_id=None,            # 定时任务无具体触发的 IM 消息
        channel_id=group_target.get("channel_id"),
        chat_id=group_target["chat_id"],
        puid=group_target.get("puid"),
        chat_type="group",
    )
try:
    # 现有 execution + report 流程
    ...
finally:
    # 群定时任务 set_im 过：本轮 execution 结束后清理 imctx，避免 ContextVar 残留
    # 到 execute_task 协程结束（P2 生命周期债务）。私聊/Web 未 set_im，无需清理。
    if group:
        from agent import imctx
        imctx.clear()
```

**为什么 finally 里用 `clear()` 而不是不清理**：
- `agent/imctx.set_im` 内部用 `ContextVar.set`（看 `imctx.py`），`imctx.py` 暴露了 `clear()`（`_im.set(None)`），用它显式清理，避免 ContextVar 残留到 `execute_task` 协程结束（P2 生命周期债务）。
- 不新增 `reset(token)` 接口：保持 imctx 现有 API 不变（`clear()` 是既有方法，非新增）。
- 在同一 task 内的 execution + report 阶段共享同一 set 是**期望行为**——report 阶段不调工具，但 imctx 残留不影响 report 文本产出。

**为什么 `message_id=None`**：
- 定时任务**没有具体触发的 IM 消息 id**；`group_context_search` 不需要 message_id 也能用（只依赖 `chat_id`/`channel_id`/`chat_type`）。
- worker 的 `set_im` 传 message_id 是给 `react` 工具和 iLink context_token 用的，定时任务不调这些工具，留 None 安全。

### 1.3 群记忆注入

**注入点选择**：execution 阶段的 **user message 开头**拼上群 memory 段。

- 为什么不拼 system prompt：`builder.build(...)` 在 `runner._run_scheduled_once` 里调用，`_run_agent` 拿不到 system prompt；要注入 system 得改 runner 签名，违反「不动 runner.py」约束。
- 拼到 user message 开头：模型在 user 段看到「## 当前群组记忆...」效果上等价于 system 段，token 成本一样、不污染 system 模板。
- report 阶段不注入：见 1.3-4 决策。

**实现（`_run_agent` 入口）**：

```python
if group_target:
    # set_im 让 group_context_search 等群工具可用
    from agent.imctx import set_im
    set_im(
        platform=group_target["platform"],
        message_id=None,            # 定时任务无具体触发的 IM 消息
        channel_id=group_target.get("channel_id"),
        chat_id=group_target["chat_id"],
        puid=group_target.get("puid"),
        chat_type="group",
    )
    # 读群 memory（owner 视角，不读 platform_user 维度）
    from agent.memory.scopes import MemoryScope
    from agent.memory.scope_lifecycle import preview_scope
    from agent.im.context_loader import format_im_memory
    bot_id = str(group_target.get("channel_id") or "")
    if bot_id:
        group_scope = MemoryScope(
            owner_user_id=user_id,
            platform=group_target["platform"],
            bot_id=bot_id,
            scope_type="group",
            scope_id=str(group_target["chat_id"]),
        )
        group_memory = await preview_scope(group_scope) or {}
        scope_block = format_im_memory({"group": group_memory}, role="owner")
        if scope_block:
            prompt = scope_block + "\n\n" + prompt   # 拼到 user prompt 开头
```

**几个细节决策**：

1. **role 选 "owner"**：
   - `load_im_memory` 里 `role="member"` 会额外读 `platform_user` 维度记忆（私聊发言人在群里的平台记忆）。
   - 群定时任务是**用户本人创建的**（owner 视角），不是群里某个成员发言触发的——按 owner 角色加载，避免给群定时任务注入"当前发言人"记忆造成串扰。
   - 复用 `format_im_memory(..., role="owner")`：只会渲染 `group` 字段的 `profile / summary`，不渲染 `platform_user` 段（看 `format_im_memory` 实现：role 不是 "member" 时跳过 personal 段）。

6. **`bot_id` 取 `channel_id`**：
   - `MemoryScope.bot_id` 在 IM 体系里就是 `UserBot.id`（看 `scopes.py` docstring 和 `agent.im.context_loader` 的 `load_im_memory`：`bot_id = str(request.platform_bot_id or "")`）。
   - `delivery_targets[channel]["channel_id"]` 在 `owner_private_targets` / 群目标里都是 `UserBot.id`（看 `app/scheduled_tasks.py:owner_private_targets` 写的是 `str(row.id)`）。
   - 两者口径一致，直接传。

7. **`preview_scope` vs `read_scope`**：
   - 用 `preview_scope`（轻量、按权限裁剪）而不是 `read_scope`（读原始文件），跟 `load_im_memory` 的现有用法保持一致——群记忆可能有 owner-only 字段，`preview_scope` 已经按当前角色过滤。
   - 不要因为这是"系统任务"就提升权限，反而要更严——避免把不该发到群的内容（owner-only 标记）误注入群定时任务的 system prompt。

4. **report 阶段不重复注入**：
   - report 阶段是 `minimal_context=True`，不加载 owner 记忆，按现有设计不重新走 `builder.build`。
   - 且 `run_scheduled_report` 在 `agent.scheduled_report.build_prompt` 里**自己拼** task_prompt + execution_text（不经过 `_run_agent`），如果要从 `_run_agent` 注入群 memory，得改 runner 签名——与「不动 runner.py」冲突。
   - **实现选择**：群 memory 只在 **execution 阶段**注入（拼到 user prompt 开头），report 阶段不注入。理由：report 阶段不带工具、只整理措辞，execution_text 里已经隐含群上下文（执行时看到了），再注入一次是重复；单群场景下 execution 已决定产出方向，report 主要做语气润色。
   - 如果将来发现 report 阶段措辞不对齐群语气，再升级——优先低成本实现，必要时再动 runner 签名。

### 1.4 owner 记忆是否要保留

**保留**。理由：
- 用户在问题讨论中明确说"加载也合理，毕竟只有 owner 能定定时任务"。
- 群定时任务的本质是 owner 让咕咕跑任务，owner 私聊的上下文对任务执行有正向价值（项目/事件/记忆里的事实可能跟任务相关）。
- 群 memory 是**补充**维度，不是替代 owner 记忆。
- 隐私风险：owner 记忆已经塞进 system prompt 很久了，定时任务本来就走 owner 视角，本次只是**额外加上群维度**，不扩大已有风险面。

### 1.5 单群/多群

- 单群：实现就是 1.1 ~ 1.4。
- 多群：当前 `delivery_mode` 工具只支持单群，**不实现**。等工具层支持多群时再扩展（让 `_run_agent` 串行跑多次 execution，每次 set 不同群的 imctx，产出 N 份文本分别投递）。

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `backend/app/scheduled_tasks.py` | 新增 `_detect_group_target`；`_run_agent` 入口调 `set_im` + 加载 `preview_scope` + 拼 `format_im_memory` 到 system prompt；execution/report 两阶段共用 |
| `backend/tests/test_scheduled_group_imctx.py` | 新增 pytest：群定时任务执行时 imctx 正确 / 群记忆注入 / 私聊任务不注入群记忆 / message_id=None 等 |

**不动**：
- `backend/agent/runner.py`（保持 `_run_scheduled_once` 通用性）
- `backend/agent/imctx.py`（不引入 reset API；清理用既有 `clear()`，见 §1.2）
- `backend/agent/tools/`（工具实现零变化，群工具自己从 imctx 读）
- `backend/agent/im/context_loader.py`（直接复用 `load_im_memory` / `format_im_memory`，不改实现）
- `backend/agent/context/builder.py`（builder.build 签名不变，群记忆走末尾追加）

## 3. 验收

### 3.1 单元测试（pytest）

新增 `backend/tests/test_scheduled_group_imctx.py`：

1. `test_detect_group_target_picks_group` — 单群目标识别
2. `test_detect_group_target_skips_private` — `chat_type="c2c"` 不识别
3. `test_detect_group_target_none` — 无 delivery_targets / 无群目标
4. `test_run_agent_group_target_sets_imctx` — 群定时任务执行时 `imctx.get_im()` 返回群身份（用 `monkeypatch` 捕获 set_im 调用，验证参数）
5. `test_run_agent_private_target_no_imctx` — 私聊/网页任务执行时**不调** set_im
6. `test_run_agent_group_injects_group_memory` — 群定时任务 execution 阶段的 prompt 包含 `format_im_memory` 输出（mock LLM 抓 messages）
7. `test_run_agent_group_message_id_none` — 验证 `set_im(message_id=None)`
8. `test_run_agent_no_group_memory_when_no_target` — 无群目标时 prompt 不含群 memory（兜底）

### 3.2 手工验证

devserver 端到端：
1. 用 playwright/playwright 账号在 QQ 群让咕咕创建"每天 8 点发本群早报"任务，`delivery_mode="current_group"`
2. 改 cron 到 1 分钟后，等触发
3. worker 日志应能看到：
   - `execute_task` 入口有 `set_im` 痕迹（如果加了日志）
   - execution 阶段模型能成功调 `group_context_search`（之前会报"当前不在群聊上下文"）
   - system prompt 长度增加（群 memory 几十~几百 token）
4. 群消息应收到定时任务产出

### 3.3 回归

跑完整后端 pytest 套件（`PYTHONPATH=. .venv/bin/pytest`），确认：
- 私聊定时任务：行为不变
- 网页定时任务：行为不变
- 多群场景（目前没有）：未受影响

## 4. 风险与回滚

| 风险 | 缓解 |
|---|---|
| imctx 残留污染其他任务 | `_run_agent` 用 `try/finally` 在任务结束时 `imctx.clear()`，显式清理；私聊/Web 未 set_im 无需清理 |
| 群 memory 注入让 token 成本上升 | `preview_scope` 返回的内容通常几十~几百 token，低于 owner memory；不调就不注入 |
| 群 memory 里 owner-only 字段泄漏到群 | `preview_scope` 已经按角色裁剪，role="owner" 看的就是公开 group memory；与 IM 群聊主路径口径一致 |
| `set_im` 在定时任务路径引入后影响其他 agent 行为 | set_im 只让 `get_im()` 不再为 None；IM 工具内部的 None 兜底（`im or {}`）依然安全 |
| `_run_agent` 是 execution + report 共用入口，改它要保证两阶段行为正确 | 测试 1.3.4 + 1.3.8 显式覆盖两阶段 |

回滚方案：`_detect_group_target` 不命中 → 完全不动 imctx / system prompt，行为与现状一致。所以**回滚就是删除 `_run_agent` 里 `if group_target:` 分支**。

## 5. 开放问题（待评审时定）

1. **execution 阶段也注入群 memory 是否合理？** 当前决策是注入（与 IM 群聊主路径一致）；如果觉得"群定时任务应更轻量"，可以只 report 阶段注入，execution 阶段只 set_im。
2. **role 选 "owner" 还是 "member"？** 当前选 "owner"（不加载 platform_user 维度），如果想让群定时任务"看到群里某个 @ 咕咕的人"的记忆，可以改 "member"——但群定时任务无具体发言人，"member" 没意义。倾向保持 "owner"。
3. **多群扩展时机**：等 `delivery_mode` 工具支持多群后再做。本次不实现。

## 6. 关联

- 上游：`PRD-IM-6-IM会话复用与消息窗口裁剪.md`（`delivery_targets` 字段落地）
- 上游：`PRD-IM-3-群组与成员记忆.md`（群 memory 体系 + `format_im_memory` 实现）
- 上游：`PRD-SCHEDULE-1-定时任务完整AgentLoop执行.md`（`_run_agent` 两阶段架构）
- 上游：`agent/imctx.py`（IM 上下文透传机制）
