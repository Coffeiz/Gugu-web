# 反思触发阈值统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网页和所有私聊共用可配置反思阈值；所有群聊反思共用 50 条群消息阈值，并保留 4 分 30 秒闲置收束。

**Architecture:** 用 `web_private_reflection_threshold` 替换 Owner 专属配置名；旧 `reflection_threshold` 不再支持，缺少新字段时使用默认值 10。私聊 IM 成员任务按持久 cursor 的 `pending_agent_count` 聚合，达到阈值后创建持久反思任务；群 scope、member-batch 和群内 Owner 缓冲统一使用 `GROUP_MESSAGE_THRESHOLD=50`，移除群级 1 小时单独触发。闲置扫描继续补齐未反思范围，主会话完整历史前缀和幂等任务保持不变。

**Tech Stack:** Python 3、Pydantic、SQLAlchemy、Redis、Vue 3、TypeScript、pytest、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-22-reflection-trigger-thresholds-design.md`

## Global Constraints

> 状态：本计划对应的阈值统一、完整 session 历史反思、统计口径修正和死代码清理均已完成；以下任务清单为实施记录。

- 网页和所有私聊对象（Owner 与非 Owner）共用一个可配置阈值。
- 达到私聊阈值时反思；未达到时，最后一轮后空闲 4 分 30 秒则收束待处理内容。
- 所有群聊反思（群级、群友批量、群内 Owner）统一走 50 条群消息阈值。
- 群内未到 50 轮的剩余内容在最后一条群消息后空闲 4 分 30 秒时收束。
- 反思继续使用对应主对话的完整历史前缀；保留持久任务的幂等和失败重试语义。
- 旧字段 `reflection_threshold` 不再映射；缺少新字段时使用默认值 10。
- 运行配置文件属于用户数据，不由本功能直接改写。
- 群聊阈值保持代码常量 50，不新增群聊阈值配置。
- 注释、文档和用户可见文案使用简体中文；真实用户名使用虚构占位名。
- 不提交中间改动；完成并经用户确认后再统一处理提交。

## Review Focus

- 旧配置只提供 `reflection_threshold`：该键被忽略，新字段使用默认值 10；由 Task 1 的旧键忽略测试覆盖。
- 私聊消息未达阈值但过了 4 分 30 秒：只反思一次且只覆盖尚未反思范围；由 Task 2 的闲置收束与重复扫描测试覆盖。
- 私聊 scope 之间隔离：一个联系人的轮数不能帮另一个联系人达到阈值；由 Task 2 的 scope 隔离测试覆盖。
- 群级、群友与群内 Owner 三条路径在第 50 条前后必须使用同一阈值；由 Task 3 的边界测试覆盖。
- 群消息不足 50 条时仍需在 4 分 30 秒空闲后收束；由 Task 3 的 idle 测试覆盖。

---

### Task 1: 重命名网页/私聊阈值配置并移除旧字段兼容

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/agent/memory/reflection.py`
- Modify: `frontend/src/stores/config.ts`
- Modify: `frontend/src/views/Admin/Agent/memory/components/MemoryMaintenanceSettings.vue`
- Modify: `frontend/src/i18n/sections/memorySettings.ts`
- Test: `backend/tests/test_reflection_threshold.py`
- Test: `backend/tests/test_reflection_units.py`

**Interfaces:**
- Produces `AgentBehaviorSettings.web_private_reflection_threshold: int` with default 10 and range 1–100.
- Legacy input `reflection_threshold` is ignored; the new field uses its default when absent.
- Frontend reads and saves `agent.web_private_reflection_threshold` and labels it “网页/私聊反思触发阈值”。

- [x] **Step 1: Add config default and legacy-field rejection tests**

In `backend/tests/test_reflection_threshold.py`, add tests asserting:

```python
from app.core.config import AgentBehaviorSettings

assert AgentBehaviorSettings.model_validate({}).web_private_reflection_threshold == 10
assert AgentBehaviorSettings.model_validate({"reflection_threshold": 7}).web_private_reflection_threshold == 10
assert AgentBehaviorSettings.model_validate({
    "reflection_threshold": 7,
    "web_private_reflection_threshold": 4,
}).web_private_reflection_threshold == 4
```

- [x] **Step 2: Run the focused config tests and confirm the legacy-field case fails**

Run from `backend/`:

```bash
PYTHONPATH=. .venv/bin/pytest tests/test_reflection_threshold.py -k 'config or threshold' -q
```

Expected before cleanup: the legacy-field assertion fails because the old validator still maps the value.

- [x] **Step 3: Keep the new setting and remove legacy input mapping**

Remove the `model_validator(mode="before")` that copied legacy `reflection_threshold`. Validate the new field in the range 1–100. Rename `_owner_reflection_threshold` to `_web_private_reflection_threshold` and update all private Owner call sites to read the new setting. Do not write `config.override.json`, `.env`, or other runtime config files.

- [x] **Step 4: Rename the admin field and localized copy**

Update the config store default, memory settings input binding, Chinese/Japanese/English labels and hints. The hint must say it applies to web and all private conversations; group reflections use the fixed 50-message rule.

- [x] **Step 5: Re-run the focused config tests**

Run the command from Step 2. Expected: all selected tests pass, including default behavior when the old field is present.

### Task 2: Aggregate QQ private reflection turns at the shared threshold

**Files:**
- Modify: `backend/agent/memory/reflection.py`
- Modify: `backend/agent/memory/reflection_jobs.py`
- Modify: `backend/agent/memory/im_reflection.py` only if worker completion must reset the existing pending-turn counter atomically with cursor advancement
- Test: `backend/tests/test_reflection_threshold.py`
- Test: `backend/tests/test_im_memory_scopes.py`

**Interfaces:**
- Owner reflection buffer reads `settings.agent.web_private_reflection_threshold`.
- `observe_private_member_activity(scope, session_id, platform_user_id, *, now=None, force=False)` increments the platform-user cursor’s `pending_agent_count` for each completed turn.
- On threshold, `observe_private_member_activity` creates one durable `private-owner` task for the unreflected range and schedules it with the current snapshot when available.
- Below threshold, it records activity but does not dispatch a model call; the existing 3-minute `settle_idle_scopes` path creates/reuses the pending task.

- [x] **Step 1: Add failing threshold aggregation tests**

Add tests using synthetic user, bot, platform-user scopes and persisted `ConversationMessage` rows. Assert that `threshold - 1` completed turns enqueue no task; the threshold turn enqueues one task with the range from `last_reflected_message_id + 1` through the current user message; and a second contact’s counter remains zero.

- [x] **Step 2: Add failing idle fallback and duplicate-scan tests**

Assert that a private scope below threshold is settled once after the 3-minute cutoff, the task covers the outstanding range, and a second idle scan does not create another reflection for the same range.

- [x] **Step 3: Run the focused private-reflection tests and verify expected failures**

Run from `backend/`:

```bash
PYTHONPATH=. .venv/bin/pytest tests/test_reflection_threshold.py tests/test_im_memory_scopes.py -k 'private or owner_reflection' -q
```

Expected before implementation: the new tests fail because private activity currently enqueues a task on each completed turn.

- [x] **Step 4: Implement persistent pending-turn aggregation**

Update the `MemoryReflectionCursor` under its existing row lock, increment `pending_agent_count`, and reserve one batch by subtracting the configured threshold when reached. Enqueue a durable task for the full unreflected range. If enqueue fails after counter reservation, the 4-minute-30-second idle scan still recovers the range from `last_reflected_message_id`. When an idle task is created, clear any leftover private pending count only if the cursor still points at the settled message. Preserve cursor advancement, scope locks, job idempotency and retry behavior. Keep `last_message_at` current so idle settlement still occurs after 4 minutes 30 seconds.

- [x] **Step 5: Use the renamed setting in the web/Owner buffer**

Replace reads of `reflection_threshold` with `web_private_reflection_threshold` in the private Owner buffer. Preserve its existing per-session isolation and idle flush behavior.

- [x] **Step 6: Run focused private-reflection tests**

Run the command from Step 3. Expected: threshold, isolation, idle fallback and duplicate-scan assertions pass.

### Task 3: Apply the 50-message threshold to every group reflection path

**Files:**
- Modify: `backend/agent/memory/reflection_jobs.py`
- Modify: `backend/agent/memory/reflection.py`
- Modify: `backend/agent/im/loop.py`
- Test: `backend/tests/test_im_memory_scopes.py`
- Test: `backend/tests/test_reflection_threshold.py`

**Interfaces:**
- `GROUP_MESSAGE_THRESHOLD` remains the single constant with value 50.
- `observe_group_message(...)` schedules both group and member-batch work at the 50th eligible group message.
- Group-owner buffer is flushed by the same group-scope 50-message event, never by a separate Owner-only counter or the web/private setting.
- Four-minute-30-second idle settlement remains the partial-batch fallback for group and member scopes.

- [x] **Step 1: Add failing group threshold boundary tests**

Extend group-scope tests to assert that 49 messages do not dispatch group/member reflections and the 50th message makes both task types eligible exactly once.

- [x] **Step 2: Add failing group-owner threshold test**

Add a routing test for `record_passive_im_message`: group threshold from an Owner message appends it before draining, while a non-Owner threshold message drains the existing Owner buffer. Assert Owner-only buffered message count does not independently trigger reflection.

- [x] **Step 3: Add failing group idle settlement test**

Assert that a group with fewer than 50 messages still produces only the pending group/member task(s) after 4 minutes 30 seconds idle and that repeated settlement does not duplicate completed ranges.

- [x] **Step 4: Run focused group tests and verify expected failures**

Run from `backend/`:

```bash
PYTHONPATH=. .venv/bin/pytest tests/test_im_memory_scopes.py tests/test_reflection_threshold.py -k 'group or member_batch' -q
```

Expected before implementation: group scope may not schedule at 50, and group-owner buffering still follows the private config.

- [x] **Step 5: Unify group-trigger behavior on the shared 50-message constant**

Make the 50-message event schedule both group and member-batch jobs. Propagate the event from `record_passive_im_message`: Owner messages are appended then drained, while non-Owner messages trigger a drain of the existing Owner buffer. Remove the independent one-hour group reflection trigger and Owner-only 50-turn trigger; keep the 3-minute idle flush for incomplete batches.

- [x] **Step 6: Run focused group tests**

Run the command from Step 4. Expected: 49/50 boundaries, both tasks, group-owner threshold and idle settlement pass.

### Task 4: Update the IM reflection contract documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/prds/【已完成】PRD-IM-11-群成员长期记忆.md`
- Modify: `docs/devlog/README.md`
- Create: `docs/devlog/2026-09-22-反思触发阈值统一.md`

- [x] **Step 1: Update PRD trigger table and idle interval**

Document web/private shared configurable threshold, group/member/group-owner 50-message threshold, and 3-minute idle flush; remove the stale 15-minute wording and per-turn private-owner trigger description.

- [x] **Step 2: Add a concise user-visible changelog entry and detailed Chinese devlog**

Add a short entry to `CHANGELOG.md`; put implementation rationale, configuration defaults, old/new paths and verification evidence in the new devlog. Do not include real account names or conversation bodies.

- [x] **Step 3: Review documentation against the approved spec**

Confirm every trigger number and scope name matches the spec and implemented constant.

### Task 5: Integrated review and verification

**Files:**
- Review all files changed by Tasks 1–4.

- [x] **Step 1: Run focused backend tests**

Run:

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest tests/test_reflection_threshold.py tests/test_im_memory_scopes.py -q
```

- [x] **Step 2: Run relevant frontend tests**

Run the existing Vitest suite for any config-store or memory-settings tests added in Task 1. If the change only affects static locale text and binding, use the project’s existing typecheck/build validation instead of creating a brittle snapshot test.

- [x] **Step 3: Run source checks and inspect the final diff**

Run `python -m compileall -q backend/app backend/agent` from repository root, `git diff --check`, and inspect the focused diff to ensure no unrelated existing worktree changes were staged or rewritten.

- [x] **Step 4: Report verification and remaining risks**

Report actual command outputs, changed files, and any unverified runtime/production behavior. Do not commit until the user confirms the fix works, per repository instructions.
