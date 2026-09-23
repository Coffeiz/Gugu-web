"""`LLMRunner._run_anthropic`/`_run_openai` 主循环特征测试（characterization tests）。

PRD-LLM-1 Phase 2 前置：这两条循环各自完整实现工具调用/核实轮/防幻觉守卫控制流，
重复约 90%，是下一步"合并成一条循环 + provider 适配器提供标准化流"的目标，但现状
**没有任何端到端测试**——贸然合并的风险跟"修一个 bug"不对等。这份测试先把现有行为
钉死，给后续合并提供回归安全网；不改任何主循环代码。

现有场景（`test_verify_*`/`test_readonly_*`/`test_openai_clean_pass_matches_anthropic`）
移植自原 `scripts/smoke_self_verify.py`（手动冒烟脚本，原本只能手跑、不进 CI，场景已
完整迁到这里后已删除，避免两份资产分叉维护）——移植时注意：原脚本直接对模块全局赋值
（`core._stream_round = fake_stream_round`、`registry.dispatch = fake_dispatch` 等）
不会自动撤销，混进 pytest 一个进程里跑会污染其它测试文件；这里全部改用
`monkeypatch.setattr`，测试结束自动复原。

后续场景覆盖三条防幻觉守卫（叙事/意图播报/决策拒绝）、句末冒号续写和空回复兜底——
这几处正是合并时最容易被悄悄改坏的分支，因为两条循环里
是逐字复制的同一段判断，合并时任何一次「顺手改一下措辞/顺序」都可能让两路从此不同步。
"""
import asyncio
import collections
import json
from types import SimpleNamespace

import pytest

import agent.core as core
import agent.context.compaction as compaction
from agent.loop_drivers import RoundResult
from agent.core import (
    LLMRunner, _FINALIZE_PROMPT, _VERIFY_PROMPT,
)
from agent.tools import registry

_CONFIRMATION_TOOL_NAMES = tuple(
    name for name in registry.snapshot().all_tool_names()
    if (tool := registry.snapshot().get(name))
    and (tool.destructive or tool.requires_confirmation)
)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """跑得快：_stream_round 的退避 + genstream.typed_stream 的逐字打字延迟都不用真等。"""
    async def _fast_sleep(_seconds):
        return None
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)


@pytest.fixture()
def dispatched(monkeypatch):
    """记录本测试内被 dispatch 的工具名；同时把 registry 的几个查表函数打成空/固定值——
    这几个循环不真的按 schema 校验参数，打桩掉省得引入真实工具注册表的重依赖。"""
    calls: list[str] = []

    async def fake_dispatch(uid, name, inp):
        calls.append(name)
        return (f"ok:{name}", None)

    monkeypatch.setattr(registry, "dispatch", fake_dispatch)
    monkeypatch.setattr(registry, "anthropic_schemas", lambda names: [])
    monkeypatch.setattr(registry, "openai_schemas", lambda names: [])
    monkeypatch.setattr(registry, "labels", lambda: {})
    monkeypatch.setattr(registry, "get", lambda name: None)
    return calls


AI = SimpleNamespace(model="fake", base_url="http://local", api_key="dummy",
                     provider="anthropic", max_tokens=100, thinking="disabled")


def make_runner(**kwargs):
    return LLMRunner(tool_names=[], settings=SimpleNamespace(ai=AI), **kwargs)


async def drain(gen):
    """跑完 SSE 生成器：返回 (事件类型计数, 流式吐出去的全部 token 文本, error 事件的 detail 文案列表)。"""
    ev = collections.Counter()
    text = []
    errors = []
    async for chunk in gen:
        try:
            d = json.loads(chunk[len("data: "):])
        except Exception:
            continue
        ev[d.get("type")] += 1
        if d.get("type") == "token":
            text.append(d.get("content", ""))
        elif d.get("type") == "error":
            errors.append(d.get("detail", ""))
    return ev, "".join(text), errors


def n_verify(messages):
    return sum(1 for m in messages if m.get("content") == _VERIFY_PROMPT)


async def test_progress_only_round_is_retried_but_draft_remains_visible(monkeypatch):
    """模型的普通 draft 实时可见；守卫追问本身仍不泄漏。"""
    patch_anthropic(monkeypatch, [
        msg([TX("正在为你查询最新信息。")]),
        msg([TX("查完了，结果如下。")]),
    ])

    ev, text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", [{"role": "user", "content": "查一下最新信息"}], AI)
    )

    # 第一轮普通 draft 应实时可见；守卫后的追问内容不应再次泄漏。
    assert text == "正在为你查询最新信息。"
    assert ev["_new_round"] == 1
    assert errors == []


async def test_final_reply_compacts_at_provider_threshold(monkeypatch):
    """无工具的最终回复达到 90% 时，也必须在结束前走同一压缩路径。"""
    calls = []

    async def fake_compact(messages, *args, **kwargs):
        calls.append(kwargs.get("model_cfg"))
        return list(messages), True

    monkeypatch.setattr(compaction, "compact_context", fake_compact)
    final = msg([TX("最终回复")])
    final.usage.input_tokens = 950
    patch_anthropic(monkeypatch, [final])
    ai = SimpleNamespace(**AI.__dict__, context_tokens=1000)
    runner = LLMRunner(tool_names=[], settings=SimpleNamespace(ai=ai))

    ev, text, errors = await drain(runner._run_anthropic(
        "u", "sys", [{"role": "user", "content": "测试"}], ai,
    ))

    assert text == "最终回复"
    assert errors == []
    assert len(calls) == 1
    assert ev["_context_compaction"] == 2


# ── 假 Anthropic 消息块（迁自 scripts/smoke_self_verify.py）─────────────────────
class TU:  # tool_use
    type = "tool_use"
    def __init__(self, name, i, inp):
        self.name, self.id, self.input = name, i, inp
    def model_dump(self):
        return {"type": "tool_use", "name": self.name, "id": self.id, "input": self.input}


class TX:  # text
    type = "text"
    def __init__(self, t):
        self.text = t
    def model_dump(self):
        return {"type": "text", "text": self.text}


def msg(blocks):
    return SimpleNamespace(content=blocks,
                            usage=SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0))


def patch_anthropic(monkeypatch, script):
    """把 core._stream_round 换成按脚本顺序逐轮吐出假 final message 的假实现——
    `_run_anthropic` 内部通过模块全局名字调用 _stream_round，所以打在模块属性上就够了。"""
    q = collections.deque(script)

    async def fake_stream_round(client, kwargs, adapter=None):
        m = q.popleft()
        txt = "".join(b.text for b in m.content if b.type == "text") or ""
        if txt:
            yield ("token", txt)
        yield ("final", m)

    monkeypatch.setattr(core, "_stream_round", fake_stream_round)


# ── 假 OpenAI 流式 chunk（迁自 scripts/smoke_self_verify.py，仅 parity 测试用）──────
def _text_chunks(t):
    return [SimpleNamespace(usage=None, choices=[SimpleNamespace(
                delta=SimpleNamespace(content=t, tool_calls=None))]),
            SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5), choices=[])]


def _tool_chunks(name, t=None):
    ch = []
    if t:
        ch.append(SimpleNamespace(usage=None, choices=[SimpleNamespace(
            delta=SimpleNamespace(content=t, tool_calls=None))]))
    tc = SimpleNamespace(index=0, id=f"c_{name}", function=SimpleNamespace(name=name, arguments="{}"))
    ch.append(SimpleNamespace(usage=None, choices=[SimpleNamespace(
        delta=SimpleNamespace(content=None, tool_calls=[tc]))]))
    ch.append(SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5), choices=[]))
    return ch


def patch_openai(monkeypatch, rounds):
    rounds = collections.deque(rounds)

    class FakeCompletions:
        async def create(self, **kw):
            data = rounds.popleft()

            async def agen():
                for c in data:
                    yield c
            return agen()

    class FakeOpenAI:
        def __init__(self, **kw):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    import openai
    monkeypatch.setattr(openai, "AsyncOpenAI", FakeOpenAI)


# ══════════════════════════════════════════════════════════════════════════
# 移植自 scripts/smoke_self_verify.py 的 5 个场景
# ══════════════════════════════════════════════════════════════════════════

async def test_verify_clean_pass(monkeypatch, dispatched):
    """成功写入后直接收束，不再自动注入复查轮。"""
    patch_anthropic(monkeypatch, [
        msg([TX("好的"), TU("create_project", "1", {})]),
        msg([TX("建好了项目X，3阶段5待办都在 ✅")]),
    ])
    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "建好了项目X" in text
    assert "好的" in text, "普通 round draft 应实时展示"
    assert dispatched == ["create_project"]
    assert n_verify(messages) == 0
    assert _FINALIZE_PROMPT not in [m.get("content") for m in messages]
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_verify_summary_does_not_add_redundant_finalize_round(monkeypatch, dispatched):
    """工具结果后直接使用模型的下一轮收束，不注入复查提示。"""
    patch_anthropic(monkeypatch, [
        msg([TU("create_project", "1", {})]),
        msg([TX("项目X已创建，阶段和待办都已保存 ✅")]),
    ])
    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "项目X已创建" in text
    assert _FINALIZE_PROMPT not in [m.get("content") for m in messages]
    assert n_verify(messages) == 0
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_send_file_does_not_trigger_readback_verification(monkeypatch, dispatched):
    """发送二进制附件成功后不能自动调用 read_file 读取正文。"""
    patch_anthropic(monkeypatch, [
        msg([TU("send_file", "1", {"file_id": 42})]),
        msg([TX("文件已发送")]),
    ])
    messages = [{"role": "user", "content": "把这个文件发给我"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert dispatched == ["send_file"]
    assert "文件已发送" in text
    assert n_verify(messages) == 0
    assert ev["_usage"] == 1


async def test_verify_fix_then_reverify(monkeypatch, dispatched):
    """不自动复查；模型只有在自己决定需要时才会继续调用工具。"""
    patch_anthropic(monkeypatch, [
        msg([TX("好的"), TU("create_project", "1", {})]),
        msg([TX("项目已创建，后续如需补充请告诉我")]),
    ])
    messages = [{"role": "user", "content": "建个项目"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "好的" in text, "普通 round draft 应实时展示"
    assert dispatched == ["create_project"]
    assert "项目已创建" in text
    assert n_verify(messages) == 0
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_tool_round_text_streams_as_its_own_round(monkeypatch, dispatched):
    """带工具调用的模型轮次也实时展示 draft，并由 round 事件切分气泡。"""
    patch_anthropic(monkeypatch, [
        msg([TX("我先读取笔记并按行修改。"), TU("note_update", "1", {})]),
        msg([TU("note_get", "2", {})]),
        msg([TX("笔记已更新。")]),
    ])
    messages = [{"role": "user", "content": "修改笔记"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))

    assert text == "我先读取笔记并按行修改。笔记已更新。"
    assert ev["tool_call"] == 2


async def test_readonly_no_verify_triggered(monkeypatch, dispatched):
    """纯查询任务不触发核实——核实只在真的做过增删改之后才该发生。"""
    patch_anthropic(monkeypatch, [
        msg([TU("get_project", "1", {})]),
        msg([TX("这个项目现在有3个阶段")]),
    ])
    messages = [{"role": "user", "content": "看看进度"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "这个项目现在有3个阶段" in text
    assert n_verify(messages) == 0
    assert ev["_usage"] == 1


async def test_external_mutating_tool_can_skip_local_verification(monkeypatch, dispatched):
    """外部工具仍禁止自动重放，但不因 mutates 标记强制进入本地复查。"""
    tool = SimpleNamespace(mutates=True, verify_after_call=False)
    monkeypatch.setattr(registry, "get", lambda name: tool if name == "mcp_gaode_maps_weather" else None)
    patch_anthropic(monkeypatch, [
        msg([TU("mcp_gaode_maps_weather", "1", {"city": "南京"})]),
        msg([TX("南京今天阴天，最高 29 度。")]),
    ])
    messages = [{"role": "user", "content": "查一下南京天气"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "南京今天阴天" in text
    assert n_verify(messages) == 0
    assert ev["_usage"] == 1


async def test_compound_mutating_tool_read_action_does_not_trigger_verify(monkeypatch, dispatched):
    """整体可写的复合工具，其 list 分支仍应按只读调用处理。"""
    tool = SimpleNamespace(mutates=True, mutates_for_input=lambda args: args.get("action") == "add")
    monkeypatch.setattr(registry, "get", lambda name: tool if name == "manage_mcp_servers" else None)
    patch_anthropic(monkeypatch, [
        msg([TU("manage_mcp_servers", "1", {"action": "list"})]),
        msg([TX("当前没有配置 MCP 服务")]),
    ])
    messages = [{"role": "user", "content": "看看 MCP 服务"}]
    ai = SimpleNamespace(**AI.__dict__, context_tokens=1000)
    runner = LLMRunner(tool_names=["manage_mcp_servers"], settings=SimpleNamespace(ai=ai))
    ev, text, _errors = await drain(runner._run_anthropic("u", "sys", messages, ai))
    assert "当前没有配置 MCP 服务" in text
    assert n_verify(messages) == 0
    assert ev["_usage"] == 1


async def test_compound_tool_read_action_ends_post_mutation_verify(monkeypatch, dispatched):
    """复合工具的写入动作也不自动触发复查。"""
    tool = SimpleNamespace(
        mutates=True,
        mutates_for_input=lambda args: args.get("action") == "add",
        observes_for_input=lambda args: args.get("action") == "list",
    )
    monkeypatch.setattr(registry, "get", lambda name: tool if name == "manage_mcp_servers" else None)

    async def fake_dispatch(_uid, name, args):
        assert name == "manage_mcp_servers"
        if args.get("action") == "add":
            return {"success": True}, None
        return {"items": []}, None

    monkeypatch.setattr(core.registry, "dispatch", fake_dispatch)
    patch_anthropic(monkeypatch, [
        msg([TU("manage_mcp_servers", "add-1", {"action": "add"})]),
        msg([TX("MCP 服务配置已经完成")]),
    ])
    messages = [{"role": "user", "content": "添加 MCP 服务"}]
    ai = SimpleNamespace(**AI.__dict__, context_tokens=1000)
    runner = LLMRunner(tool_names=["manage_mcp_servers"], settings=SimpleNamespace(ai=ai))
    ev, text, _errors = await drain(runner._run_anthropic("u", "sys", messages, ai))

    assert "MCP 服务配置已经完成" in text
    assert n_verify(messages) == 0
    assert ev["_usage"] == 1


async def test_note_get_counts_as_verify_observation(monkeypatch, dispatched):
    """写入思维笔记后直接收束，不自动追加读回。"""
    patch_anthropic(monkeypatch, [
        msg([TU("note_create", "1", {})]),
        msg([TX("笔记已记录")]),
    ])
    messages = [{"role": "user", "content": "记一条笔记"}]
    runner = LLMRunner(tool_names=["note_create", "note_get"], settings=SimpleNamespace(ai=AI))
    _ev, text, _errors = await drain(runner._run_anthropic("u", "sys", messages, AI))
    assert dispatched == ["note_create"]
    assert "笔记已记录" in text
    assert n_verify(messages) == 0


async def test_failed_write_does_not_trigger_verify(monkeypatch, dispatched):
    """工具明确失败时不应浪费一次复查模型调用。"""
    async def failed_dispatch(_uid, _name, _input):
        return ('{"error":"写入失败"}', None)

    monkeypatch.setattr(registry, "dispatch", failed_dispatch)
    patch_anthropic(monkeypatch, [
        msg([TU("create_project", "1", {})]),
        msg([TX("创建失败，请稍后重试")]),
    ])
    messages = [{"role": "user", "content": "建项目"}]
    _ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "创建失败" in text
    assert n_verify(messages) == 0


async def test_goal_mode_popup_cancel_ends_run_gracefully(monkeypatch, dispatched):
    """删除自动复查后，普通写入不会触发核实弹窗。"""
    patch_anthropic(monkeypatch, [
        msg([TU("create_project", "create", {})]),
        msg([TX("已完成")]),
    ])
    messages = [{"role": "user", "content": "创建项目"}]

    ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))

    assert "已完成" in text
    assert ev["_cancelled"] == 0
    assert ev["interaction_required"] == 0
    assert n_verify(messages) == 0
    assert errors == []


async def test_goal_mode_popup_system_cancel_still_emits_cancelled(monkeypatch, dispatched):
    """系统取消语义仍由独立取消守卫负责，不依赖复查流程。"""
    patch_anthropic(monkeypatch, [
        msg([TX("已完成")]),
    ])
    messages = [{"role": "user", "content": "创建项目"}]

    ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))

    assert ev["_cancelled"] == 0
    assert "已完成" in text
    assert n_verify(messages) == 0
    assert errors == []


async def test_tool_confirmation_cancel_replaces_tool_result_and_finalizes(monkeypatch, dispatched):
    """确认卡点「取消」：取消结果落进工具往返并补收尾正文，不留 dangling 工具调用。"""
    async def fake_create_tool_confirmation(**_kwargs):
        return {
            "prompt_id": 903,
            "kind": "confirm",
            "title": "任务已暂停 · 发送邮件",
            "body": "确认后将继续执行当前任务。",
            "options": [{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
            "task_paused": True,
            "expires_at": "2026-09-10T21:00:00+08:00",
        }

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "cancelled", "option_id": "cancel", "text": "取消"}

    monkeypatch.setattr("app.services.interactions.create_tool_confirmation", fake_create_tool_confirmation)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)

    patch_anthropic(monkeypatch, [msg([TU("send_email", "call-1", {})])])
    messages = [{"role": "user", "content": "发邮件"}]

    ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI, session_id=1))

    assert ev["interaction_required"] == 1
    assert "已取消这项操作" in text
    assert ev["_cancelled"] == 0
    assert errors == []
    # 内存里的 pending 工具结果必须已被取消结果替换，收尾持久化才不会写回占位符。
    tool_results = [
        block.get("content") for m in messages if m.get("role") == "user"
        for block in (m.get("content") or []) if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    assert any('"status": "cancelled"' in (c or "") for c in tool_results)


@pytest.mark.parametrize("target_name", _CONFIRMATION_TOOL_NAMES)
async def test_confirmation_adapter_routes_every_confirmable_tool(monkeypatch, dispatched, target_name):
    """所有注册为 destructive/requires_confirmation 的工具都必须以最终工具名进入确认桥。"""
    blocked = json.dumps({
        "status": "waiting_confirmation", "needs_confirm": True,
        "summary": "需要确认的操作", "confirm_code": "test-code",
    }, ensure_ascii=False)
    dispatches: list[tuple[str, dict]] = []
    confirmations: list[str] = []

    async def fake_dispatch(_uid, name, arguments):
        dispatches.append((name, arguments))
        return blocked, None

    async def fake_create_tool_confirmation(**kwargs):
        confirmations.append(kwargs["tool_name"])
        assert kwargs["session_id"] == 807
        return {
            "prompt_id": 980, "kind": "confirm", "title": "需要确认",
            "body": "确认后继续。",
            "options": [{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
            "task_paused": True, "expires_at": "2026-09-12T23:00:00+08:00",
        }

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "cancelled", "option_id": "cancel", "text": "取消"}

    monkeypatch.setattr(core.registry, "dispatch", fake_dispatch)
    monkeypatch.setattr("app.services.interactions.create_tool_confirmation", fake_create_tool_confirmation)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)
    patch_anthropic(monkeypatch, [msg([TU("call_tool", "wrapped-confirm", {
        "name": "call_tool",
        "arguments": {"name": target_name, "arguments": {"probe": "confirm-routing"}},
    })])])

    ev, _text, errors = await drain(make_runner()._run_anthropic(
        "u", "sys", [{"role": "user", "content": "执行操作"}], AI, session_id=807,
    ))

    assert dispatches == [(target_name, {"probe": "confirm-routing"})]
    assert confirmations == [target_name]
    assert ev["interaction_required"] == 1
    assert errors == []


def test_call_tool_adapter_rejects_excessive_nesting():
    payload = {"name": "send_email", "arguments": {"probe": True}}
    for _ in range(core._MAX_CALL_TOOL_ADAPTER_DEPTH):
        payload = {"name": "call_tool", "arguments": payload}

    target, arguments, error = core._resolve_tool_call("call_tool", payload)

    assert target == "invalid_tool_call"
    assert arguments == {}
    assert error["error"] == "tool_call_invalid"
    assert error["issues"][0]["rule"] == "max_depth"


async def test_tool_confirmation_confirm_replays_tool_without_model_recall(monkeypatch, dispatched):
    """确认后由服务端按原参数重投工具：模型只汇报结果，不再被要求重新调用一次。"""
    import json as _json

    blocked = _json.dumps({
        "status": "waiting_confirmation", "needs_confirm": True,
        "summary": "将发送邮件", "confirm_code": "abc123",
    }, ensure_ascii=False)
    calls: list[str] = []

    async def fake_dispatch(_uid, name, _inp):
        calls.append(name)
        if len(calls) == 1:
            return blocked, None          # 首次：被确认门拦截，未执行
        return _json.dumps({"status": "ok", "text": "邮件已发送"}, ensure_ascii=False), None

    async def fake_create_tool_confirmation(**_kwargs):
        return {
            "prompt_id": 904, "kind": "confirm", "title": "任务已暂停 · 发送邮件",
            "body": "确认后将继续执行当前任务。",
            "options": [{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
            "task_paused": True,
            "expires_at": "2026-09-10T21:00:00+08:00",
        }

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "confirmed", "option_id": "confirm", "confirm": True}

    monkeypatch.setattr(core.registry, "dispatch", fake_dispatch)
    monkeypatch.setattr("app.services.interactions.create_tool_confirmation", fake_create_tool_confirmation)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)

    # 第二轮脚本只有文字、没有工具调用：旧流程（要求模型重新调用）在这里拿不到
    # 第二次 dispatch，工具结果会停留在「已确认，请重新调用」占位文案。
    patch_anthropic(monkeypatch, [
        msg([TU("send_email", "call-1", {})]),
        msg([TX("邮件已经发送出去了 ✅")]),
    ])
    messages = [{"role": "user", "content": "帮我发邮件"}]

    ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI, session_id=1))

    assert calls == ["send_email", "send_email"], "确认后必须由服务端重投一次原调用"
    assert "邮件已经发送出去了" in text
    assert ev["_cancelled"] == 0
    assert errors == []
    tool_results = [
        block.get("content") for m in messages if m.get("role") == "user"
        for block in (m.get("content") or []) if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    assert any("邮件已发送" in (c or "") for c in tool_results), "真实执行结果必须回写进工具往返"
    assert not any("请直接重新调用" in (c or "") for c in tool_results)


async def test_mcp_confirm_replay_enters_credential_prompt_without_loop(monkeypatch, dispatched):
    """MCP 添加的确认后凭据表单必须继续挂起 Run，不能把表单交给模型造成循环。"""
    blocked = json.dumps({
        "status": "waiting_confirmation", "needs_confirm": True,
        "summary": "添加 MCP server [飞猪]", "confirm_code": "mcp-confirm",
    }, ensure_ascii=False)
    credential_form = {
        "_interaction": "ask_user", "kind": "form", "title": "补全 MCP 服务凭据",
        "body": "请输入凭据", "options": [],
        "secret_fields": [{"name": "Authorization", "label": "Authorization", "type": "secret"}],
        "secret_target": {"kind": "mcp_credentials", "server_id": "00000000-0000-0000-0000-000000000001"},
        "allow_text_input": False,
    }
    calls: list[str] = []
    prompt_calls: list[str] = []
    waits = iter([
        {"status": "confirmed", "option_id": "confirm", "confirm": True},
        {"status": "answered", "prompt_id": 907, "text": "MCP 凭据已安全保存"},
    ])

    async def fake_dispatch(_uid, name, _inp):
        calls.append(name)
        if len(calls) == 1:
            return blocked, None
        return json.dumps(credential_form, ensure_ascii=False), None

    async def fake_create_tool_confirmation(**_kwargs):
        return {
            "prompt_id": 906, "kind": "confirm", "title": "任务已暂停 · 管理 MCP 服务",
            "body": "确认后将继续执行当前任务。",
            "options": [{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
            "task_paused": True, "expires_at": "2026-09-10T21:00:00+08:00",
        }

    async def fake_create_agent_prompt(**kwargs):
        prompt_calls.append(kwargs["tool_name"])
        return SimpleNamespace(
            id=907,
            kind="form",
            title="补全 MCP 服务凭据",
            body="请输入凭据",
            schema_json={"secret_fields": credential_form["secret_fields"], "allow_text_input": False},
            expires_at=SimpleNamespace(isoformat=lambda: "2026-09-10T21:00:00+08:00"),
        ), []

    async def fake_wait_for_resolution(**_kwargs):
        return next(waits)

    monkeypatch.setattr(core.registry, "dispatch", fake_dispatch)
    monkeypatch.setattr("app.services.interactions.create_tool_confirmation", fake_create_tool_confirmation)
    monkeypatch.setattr("app.services.interactions.create_agent_prompt", fake_create_agent_prompt)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)

    patch_anthropic(monkeypatch, [
        msg([TU("manage_mcp_servers", "call-mcp-1", {"action": "add", "name": "飞猪"})]),
        msg([TX("MCP 服务已添加，请继续填写凭据。")]),
    ])
    messages = [{"role": "user", "content": "帮我添加飞猪 MCP 服务"}]

    ev, text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", messages, AI, session_id=1)
    )

    assert calls == ["manage_mcp_servers", "manage_mcp_servers"]
    assert prompt_calls == ["manage_mcp_servers"]
    assert ev["interaction_required"] == 2
    assert "MCP 服务已添加" in text
    assert errors == []


async def test_confirmed_replay_result_reaches_canonical_batch(monkeypatch, dispatched):
    """确认后重投的真实结果必须落进 canonical 批次（落库与历史回放的事实源）。

    只改活消息的话，落库的工具往返仍是「等待确认」占位：下一次 run 回放会把已经
    执行过的破坏性操作读成没执行，用户看到的记录也和实际不符。
    """
    blocked = json.dumps({
        "status": "waiting_confirmation", "needs_confirm": True,
        "summary": "将发送邮件", "confirm_code": "abc123",
    }, ensure_ascii=False)
    calls: list[str] = []

    async def fake_dispatch(_uid, name, _inp):
        calls.append(name)
        if len(calls) == 1:
            return blocked, None          # 首次：被确认门拦截，未执行
        return json.dumps({"status": "ok", "text": "邮件已发送"}, ensure_ascii=False), None

    async def fake_create_tool_confirmation(**_kwargs):
        return {
            "prompt_id": 906, "kind": "confirm", "title": "任务已暂停 · 发送邮件",
            "body": "确认后将继续执行当前任务。",
            "options": [{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
            "task_paused": True,
            "expires_at": "2026-09-10T21:00:00+08:00",
        }

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "confirmed", "option_id": "confirm", "confirm": True}

    monkeypatch.setattr(core.registry, "dispatch", fake_dispatch)
    monkeypatch.setattr("app.services.interactions.create_tool_confirmation", fake_create_tool_confirmation)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)

    patch_anthropic(monkeypatch, [
        msg([TU("send_email", "call-1", {})]),
        msg([TX("邮件已经发送出去了 ✅")]),
    ])
    from agent.context.assembly import PromptMessages
    messages = PromptMessages([{"role": "user", "content": "帮我发邮件"}])

    _ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI, session_id=1))

    assert "邮件已经发送出去了" in text
    assert errors == []
    persisted = json.dumps(messages.canonical_batch_records, ensure_ascii=False)
    assert "邮件已发送" in persisted, "重投的真实结果必须写进 canonical 批次"
    assert "waiting_confirmation" not in persisted, "落库的工具往返不能停在「等待确认」占位"


async def test_tool_confirmation_state_survives_wait_but_replay_is_single_shot(monkeypatch, dispatched):
    """重投失败（授权未生效）时用错误结果收尾，不能把确认占位当成功结果发出。"""
    import json as _json

    blocked = _json.dumps({
        "status": "waiting_confirmation", "needs_confirm": True,
        "summary": "将发送邮件", "confirm_code": "abc123",
    }, ensure_ascii=False)

    async def fake_dispatch(_uid, _name, _inp):
        return blocked, None      # 重投仍被拦截（授权没兑换成功）

    async def fake_create_tool_confirmation(**_kwargs):
        return {
            "prompt_id": 905, "kind": "confirm", "title": "任务已暂停 · 发送邮件",
            "body": "确认后将继续执行当前任务。",
            "options": [{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
            "task_paused": True,
            "expires_at": "2026-09-10T21:00:00+08:00",
        }

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "confirmed", "option_id": "confirm", "confirm": True}

    monkeypatch.setattr(core.registry, "dispatch", fake_dispatch)
    monkeypatch.setattr("app.services.interactions.create_tool_confirmation", fake_create_tool_confirmation)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)

    patch_anthropic(monkeypatch, [
        msg([TU("send_email", "call-1", {})]),
        msg([TX("这次没发出去，稍后再试")]),
    ])
    messages = [{"role": "user", "content": "帮我发邮件"}]

    _ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI, session_id=1))

    assert "这次没发出去" in text
    assert errors == []
    tool_results = [
        block.get("content") for m in messages if m.get("role") == "user"
        for block in (m.get("content") or []) if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    assert any("确认未生效" in (c or "") for c in tool_results)
    assert not any("needs_confirm" in (c or "") for c in tool_results), "确认占位不能留在工具往返里"


async def test_user_cancel_closes_tool_bubble_and_starts_new_round(monkeypatch, dispatched):
    """用户点「取消」：气泡要有终态，收尾正文必须另起一轮。

    停在等待态的气泡刷新后依然显示「等待回复」（展示时间线存的就是进交互门时那条
    status="waiting"）；收尾正文若和上一轮同帧，前端会把它拼进「工具调用前那条气泡」，
    用户看到的是「取消了，但底部没有任何下文」。
    """
    import json as _json

    blocked = _json.dumps({
        "status": "waiting_confirmation", "needs_confirm": True,
        "summary": "将删除定时任务", "confirm_code": "abc123",
    }, ensure_ascii=False)
    calls: list[str] = []

    async def fake_dispatch(_uid, name, _inp):
        calls.append(name)
        return blocked, None      # 被确认门拦截，从未执行

    async def fake_create_tool_confirmation(**_kwargs):
        return {
            "prompt_id": 906, "kind": "confirm", "title": "任务已暂停 · 删除定时任务",
            "body": "确认后将继续执行当前任务。",
            "options": [{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
            "task_paused": True,
            "expires_at": "2026-09-10T21:00:00+08:00",
        }

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "cancelled", "option_id": "cancel", "text": "取消"}

    monkeypatch.setattr(core.registry, "dispatch", fake_dispatch)
    monkeypatch.setattr("app.services.interactions.create_tool_confirmation", fake_create_tool_confirmation)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)

    patch_anthropic(monkeypatch, [msg([TU("delete_scheduled_task", "call-1", {"task_id": 266})])])
    messages = [{"role": "user", "content": "把定时任务删掉"}]

    frames = []
    async for chunk in make_runner()._run_anthropic("u", "sys", messages, AI, session_id=1):
        try:
            frames.append(json.loads(chunk[len("data: "):]))
        except Exception:
            continue

    kinds = [f.get("type") for f in frames]
    assert kinds.count("tool_done") == 2, "进交互门一条 waiting，取消后必须再补一条终态"
    waiting_index = kinds.index("tool_done")
    cancelled_index = kinds.index("tool_done", waiting_index + 1)
    assert frames[waiting_index]["status"] == "waiting"
    assert frames[cancelled_index]["status"] == "cancelled", "气泡没有终态就会永远停在「等待回复」"
    assert frames[cancelled_index]["tool_call_id"] == frames[waiting_index]["tool_call_id"]

    tokens = [i for i, f in enumerate(frames) if f.get("type") == "token"]
    assert tokens, "取消后要有收尾正文"
    assert cancelled_index < tokens[0], "先给气泡收终态，再发收尾正文"
    # 分帧必须用 round_start：_new_round 会被 _recover_interrupted_continuation 判成
    # 「续轮还没开始」而重发一次模型请求，用户会在取消文案后又看到一条自我解释。
    assert kinds.index("round_start", cancelled_index) < tokens[0], "收尾正文必须另起一轮"
    assert "_new_round" not in kinds[cancelled_index:], "取消收尾不能再发 _new_round 触发续轮恢复"
    assert "已取消" in "".join(f.get("content", "") for f in frames if f.get("type") == "token")
    assert calls == ["delete_scheduled_task"], "取消不能触发重投"

    tool_results = [
        block.get("content") for m in messages if m.get("role") == "user"
        for block in (m.get("content") or []) if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    assert any('"status": "cancelled"' in (c or "") for c in tool_results), "取消结果要落进本轮工具往返"


async def test_openai_clean_pass_matches_anthropic(monkeypatch, dispatched):
    """OpenAI 路写入后也不自动追加复查轮。"""
    patch_openai(monkeypatch, [
        _tool_chunks("create_project", "好的"),   # R1 建
        _text_chunks("项目X 已创建 ✅"),            # R2 最终收束回复
    ])
    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text, _errors = await drain(make_runner()._run_openai("u", messages, AI))
    assert "项目X 已创建" in text
    assert dispatched == ["create_project"]
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_responses_failure_falls_back_with_current_tools(monkeypatch):
    """Responses 失败后同一轮回退 Chat Completions，不能丢动态工具或提前写缓存。"""
    import agent.loop_drivers as loop_drivers
    import agent.providers.openai_responses as responses
    import app.services.provider_diagnostics as diagnostics

    prepare_calls = []
    events = []

    class _CapabilityContext:
        metadata_only = False
        fixed_adapter = False

        def select_for_messages(self, _messages):
            return SimpleNamespace(tool_names=("dynamic_tool",))

    class _ReasoningState:
        def __init__(self):
            self.failed_reasons = []

        async def prepared(self, _driver, _ctx):
            return None

        async def failed(self, reason):
            self.failed_reasons.append(reason)

        async def round_finished(self, *_args):
            return None

        async def completed(self):
            return None

    class _ResponsesDriver:
        api_format = "responses"
        continuation_available = True

        def prepare(self, tool_names, *_args, **_kwargs):
            prepare_calls.append(("responses", list(tool_names)))
            return object(), SimpleNamespace()

        def update_tools(self, *_args, **_kwargs):
            return None

        async def run_round(self, *_args, **_kwargs):
            raise responses.ResponsesCompatibilityError(400)
            yield  # 保持这是一个异步生成器

    class _ChatDriver:
        api_format = "openai"
        continuation_available = False

        def prepare(self, tool_names, *_args, **_kwargs):
            prepare_calls.append(("chat", list(tool_names)))
            return object(), SimpleNamespace()

        async def run_round(self, *_args, **_kwargs):
            events.append("chat")
            yield ("token", "fallback 成功")
            yield ("done", RoundResult(text="fallback 成功", tool_calls=[], raw=[]))

    monkeypatch.setattr(core, "OpenAIResponsesDriver", _ResponsesDriver)
    monkeypatch.setattr(loop_drivers, "OpenAIDriver", _ChatDriver)

    ai = SimpleNamespace(**AI.__dict__, api_format="responses", context_tokens=1000)
    runner = LLMRunner(
        tool_names=["initial_tool"],
        settings=SimpleNamespace(ai=ai),
        capability_context=_CapabilityContext(),
    )
    state = _ReasoningState()
    ev, text, errors = await drain(runner._run_responses(
        "u", "sys", [{"role": "user", "content": "测试"}], ai,
        reasoning_state=state,
    ))

    assert text == "fallback 成功"
    assert errors == []
    assert ev["error"] == 0
    assert prepare_calls == [("responses", ["dynamic_tool"]), ("chat", ["dynamic_tool"])]
    assert state.failed_reasons == ["responses_incompatible"]
    assert events == ["chat"]


# ══════════════════════════════════════════════════════════════════════════
# 新增：原冒烟脚本没覆盖的分支——三条防幻觉守卫 + 空回复兜底
# ══════════════════════════════════════════════════════════════════════════

async def test_narration_guard_nudges_once_then_gives_up(monkeypatch, dispatched):
    """整段生成一个工具都没真调、却用文字"假装"在读/改文件 → 追一轮逼它真调；
    只追一次——第二次仍不真调工具就不再重复逼，也不把守卫追问内容输出给用户。"""
    patch_anthropic(monkeypatch, [
        msg([TX("让我读一下这个文件，读到了，改好了！")]),   # R1 叙事口吻、零工具 → 命中 narration 守卫
        msg([TX("好的，明白了")]),   # R2 仍零工具；内容应被抑制，不再追第三次
    ])
    messages = [{"role": "user", "content": "帮我改一下这个文件"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    nudges = [m for m in messages if m.get("content") == core._NARRATION_NUDGE]
    assert len(nudges) == 1, "叙事守卫应该只追一次，不能无限重试"
    assert nudges[0]["role"] == "system"
    assert ev["_usage"] == 1 and ev["error"] == 0
    assert "好的，明白了" not in text


async def test_narration_guard_does_not_treat_reported_fact_as_local_mutation(monkeypatch, dispatched):
    """检索结果中的第三方事实不能被误判为本轮发送/修改操作。"""
    patch_anthropic(monkeypatch, [
        msg([TX("好——查了下，Take-Two 已经发出传票，公开资料还不完整。")]),
    ])
    messages = [{"role": "user", "content": "查一下这个案件的调查进展"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert not [m for m in messages if m.get("content") == core._NARRATION_NUDGE]
    assert "已经发出传票" in text
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_intent_announce_guard_nudges_once(monkeypatch, dispatched):
    """宣告"我这就去查/建/改…"的将来式却零工具 → 逼它当场做，只追一次。"""
    patch_anthropic(monkeypatch, [
        msg([TX("我这就去帮你查一下项目进度")]),   # 宣告将来式、零工具 → 命中意图守卫
        msg([TX("查到了，项目进度是 80%")]),        # 被逼后仍零工具，内容不应输出
    ])
    messages = [{"role": "user", "content": "帮我查一下项目进度"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    nudges = [m for m in messages if m.get("content") == core._INTENT_NUDGE]
    assert len(nudges) == 1
    assert "项目进度是 80%" not in text
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_colon_ended_reply_retries_without_fixed_prefix_and_shows_completion(monkeypatch, dispatched):
    """任意开头的句末冒号都会触发一次续写；续写无需工具时仍要展示给用户。"""
    patch_anthropic(monkeypatch, [
        msg([TX("看一下当前在跑的定时任务，找管插画推送和每日新闻速览的：")]),
        msg([TX("句末冒号表示下文可能尚未输出，回复应接着把说明说完整。")]),
    ])
    messages = [{"role": "user", "content": "检查这两个定时任务"}]
    ai = SimpleNamespace(**AI.__dict__, context_tokens=100_000)

    ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, ai))

    nudge = core.guard_locale("zh-CN").colon_nudge
    assert any(m.get("content") == nudge for m in messages)
    assert "看一下当前在跑的定时任务" in text
    assert "句末冒号表示下文可能尚未输出" in text
    assert ev["_new_round"] == 1
    assert ev["_usage"] == 1 and errors == []


async def test_colon_guard_does_not_expose_unverified_tool_claim_from_retry(monkeypatch, dispatched):
    """冒号续写仍声称已查文件但没有工具回执时，不能把未核实结果显示给用户。"""
    patch_anthropic(monkeypatch, [
        msg([TX("看一下当前任务：")]),
        msg([TX("我查了一下文件，发现任务写入到了个人文件夹。")]),
    ])
    ai = SimpleNamespace(**AI.__dict__, context_tokens=100_000)

    _ev, text, _errors = await drain(make_runner()._run_anthropic(
        "u", "sys", [{"role": "user", "content": "检查任务配置"}], ai,
    ))

    assert "看一下当前任务：" in text
    assert "我查了一下文件" not in text


async def test_intent_announce_guard_skips_questions(monkeypatch, dispatched):
    """宣告将来式但其实是在征询（带问号）→ 不该被逼，这是在等用户拍板。"""
    patch_anthropic(monkeypatch, [
        msg([TX("要我现在去查一下项目进度吗？")]),   # 问句，_announces_intent 应判 False，不触发守卫
    ])
    messages = [{"role": "user", "content": "项目怎么样了"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    nudges = [m for m in messages if m.get("content") == core._INTENT_NUDGE]
    assert len(nudges) == 0, "问句/征询不该被意图守卫误伤"
    assert "要我现在去查一下项目进度吗" in text


@pytest.mark.parametrize(("locale", "draft", "completion"), [
    ("zh-CN", "看一下当前在跑的定时任务：", "目前无法确认具体任务配置，因此不会猜测写入位置。"),
    ("en-US", "Here are the scheduled tasks:", "I can't verify their current configuration, so I won't guess their write locations."),
])
async def test_colon_guard_still_runs_after_a_previous_tool_round(
    monkeypatch, dispatched, locale, draft, completion,
):
    """通用冒号守卫按当前轮是否调工具判断，不被同一 run 前面的工具调用挡住。"""
    patch_anthropic(monkeypatch, [
        msg([TU("get_project", "1", {})]),
        msg([TX(draft)]),
        msg([TX(completion)]),
    ])
    messages = [{"role": "user", "content": "检查当前定时任务"}]
    ai = SimpleNamespace(**AI.__dict__, context_tokens=100_000)

    ev, text, _errors = await drain(
        make_runner(locale=locale)._run_anthropic("u", "sys", messages, ai)
    )

    nudge = core.guard_locale(locale).colon_nudge
    nudges = [m for m in messages if m.get("content") == nudge]
    assert len(nudges) == 1
    assert draft in text
    assert completion in text
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_decision_dodge_guard_nudges_once(monkeypatch, dispatched):
    """用户明确要求改动，模型却零工具、用"不用改/已合理"驳回 → 逼它执行或问清，不许擅自不做。"""
    patch_anthropic(monkeypatch, [
        msg([TX("这个不需要重新排序，已经挺合理的了")]),   # 用户要排序，模型零工具驳回 → 命中决策守卫
        msg([TX("好的，已经帮你重新排好序了")]),           # 守卫后的纯文本应被丢弃
    ])
    messages = [{"role": "user", "content": "帮我把这些任务重新排序一下"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    nudges = [m for m in messages if m.get("content") == core._DECISION_NUDGE]
    assert len(nudges) == 1
    assert text == "这个不需要重新排序，已经挺合理的了"
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_empty_reply_falls_back_after_one_retry(monkeypatch, dispatched):
    """整轮无正文、没动工具、不在核实阶段 → 先追一轮要正文；仍空则给句得体兜底，不能裸露空气泡。"""
    patch_anthropic(monkeypatch, [
        msg([TX("")]),   # R1 空正文
        msg([TX("")]),   # R2 追问后仍空 → 触发兜底文案
    ])
    messages = [{"role": "user", "content": "你好"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    retry_prompts = [m for m in messages
                      if m.get("content") == "（把要回复用户的话直接说出来就好，别只在心里想。）"]
    assert len(retry_prompts) == 1, "空回复应该只追问一次"
    assert "没太接住" in text or "换个说法" in text, f"应该吐出兜底文案，实际：{text!r}"
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_agent_loop_has_no_product_tool_call_cap(monkeypatch, dispatched):
    """普通对话不设产品级工具调用上限；中断由用户控制。"""
    calls_per_round = 12
    script = [
        msg([
            TU("get_project", f"{round_index}-{call_index}",
               {"project_id": round_index * calls_per_round + call_index + 1})
            for call_index in range(calls_per_round)
        ])
        for round_index in range(31)
    ]
    script.append(msg([TX("全部查询完成")]))
    patch_anthropic(monkeypatch, script)
    ev, text, errors = await drain(make_runner()._run_anthropic(
        "u", "sys", [{"role": "user", "content": "连续查询多个项目"}], AI,
    ))
    assert dispatched == ["get_project"] * (31 * calls_per_round)
    assert "全部查询完成" in text
    assert ev["tool_done"] == 31 * calls_per_round
    assert errors == []
    assert ev["error"] == 0


async def test_scheduled_agent_loop_fails_before_dispatch_above_30_calls(monkeypatch, dispatched):
    """定时 run 保留 30 次专属上限，超额批次不派发并返回失败事件供外层重试。"""
    from agent.scheduled import ScheduledLLMRunner

    patch_anthropic(monkeypatch, [
        msg([TU("get_project", str(index), {"project_id": index + 1})])
        for index in range(31)
    ])
    runner = ScheduledLLMRunner([], SimpleNamespace(ai=AI))
    ev, text, errors = await drain(runner._run_anthropic(
        "u", "sys", [{"role": "user", "content": "定时查询任务"}], AI,
    ))

    assert dispatched == ["get_project"] * 30
    assert errors == ["定时任务达到工具调用上限（30 次）"]
    assert text == ""
    assert ev["tool_done"] == 30


async def test_scheduled_agent_loop_has_100_round_limit(monkeypatch, dispatched):
    """定时 run 的轮次上限仅由 ScheduledLLMRunner 提供，普通 runner 不受影响。"""
    from agent.scheduled import ScheduledLLMRunner

    patch_anthropic(monkeypatch, [
        msg([TU("get_project", str(index), {"project_id": index + 1})])
        for index in range(3)
    ])
    runner = ScheduledLLMRunner([], SimpleNamespace(ai=AI))
    assert runner.round_limit_per_run == 100
    assert runner.tool_call_limit_per_run == 30
    # 将轮次压到 2 以便快速验证同一控制路径；单独禁用工具限额，避免先触发 30 次工具限制。
    runner.round_limit_per_run = 2
    runner.tool_call_limit_per_run = None
    runner.fail_on_tool_call_limit = False
    ev, _text, errors = await drain(runner._run_anthropic(
        "u", "sys", [{"role": "user", "content": "定时查询任务"}], AI,
    ))

    assert dispatched == ["get_project"] * 2
    assert errors == ["定时任务达到模型轮次上限（2 轮）"]
    assert ev["tool_done"] == 2


def test_goal_completion_requires_explicit_marker():
    from agent.core import _GOAL_DONE_MARKER, _goal_completed, _strip_goal_marker

    assert not _goal_completed("任务一完成")
    assert _goal_completed(f"全部完成 {_GOAL_DONE_MARKER}")
    assert _strip_goal_marker(f"完成了 {_GOAL_DONE_MARKER}") == "完成了"


async def test_polluted_tool_name_salvaged_before_dispatch_and_events(monkeypatch):
    """工具名被 XML 片段污染时（MiniMax 偶发），在循环名字定稿处全局抢救：
    dispatch 收到、tool_call/tool_done 事件展示、写入下一轮 canonical 历史的
    都是干净名，而不是把 XML 垃圾透传给用户和模型。"""
    polluted = 'create_file"><target><space>personal</space></target>'
    patch_anthropic(monkeypatch, [
        msg([TU(polluted, "1", {"content": "x"})]),
        msg([TX("文件已创建")]),
    ])
    calls: list[str] = []

    async def fake_dispatch(uid, name, inp):
        calls.append(name)
        return (json.dumps({"ok": True}), None)

    monkeypatch.setattr(registry, "dispatch", fake_dispatch)
    monkeypatch.setattr(registry, "anthropic_schemas", lambda names: [])
    monkeypatch.setattr(registry, "openai_schemas", lambda names: [])
    monkeypatch.setattr(registry, "labels", lambda: {})

    events = []
    async for chunk in make_runner()._run_anthropic("u", "sys", [{"role": "user", "content": "建文件"}], AI):
        try:
            d = json.loads(chunk[len("data: "):])
        except Exception:
            continue
        if d.get("type") in ("tool_call", "tool_done"):
            events.append((d["type"], d.get("name")))

    assert calls == ["create_file"], f"dispatch 应收到干净名：{calls}"
    assert events and all(name == "create_file" for _t, name in events), \
        f"前端事件不应看到污染名：{events}"


async def _recover_frames(stub_frames, monkeypatch):
    """跑一次 _recover_interrupted_continuation，返回 (此轮吐出的帧, 重发模型的次数)。"""
    runner = make_runner()
    retries: list[int] = []

    async def fake_provider(*_a, **_kw):
        retries.append(1)
        for f in stub_frames:
            yield f"data: {json.dumps(f, ensure_ascii=False)}\n\n"

    monkeypatch.setattr(runner, "_run_provider", fake_provider)

    async def first():
        for f in stub_frames:
            yield f"data: {json.dumps(f, ensure_ascii=False)}\n\n"

    out = []
    async for line in runner._recover_interrupted_continuation(
        first(), "u", "sys", [], use_anthropic=True, model_cfg=None, session_id=1,
    ):
        out.append(line)
    return out, len(retries)


async def test_continuation_recovery_refires_only_without_round_start(monkeypatch):
    """续轮恢复只看 _new_round 之后有没有 round_start。

    取消收尾必须发 round_start：发 _new_round 的话，收尾正文后紧接着结束流会被判成
    「续轮中断」，凭空再发一次模型请求，用户在取消文案后又会看到一条自我解释。
    """
    pending = [{"type": "_new_round", "round_id": "round-1", "next_round": 2}]
    _out, refires = await _recover_frames(pending, monkeypatch)
    assert refires == 1, "只发 _new_round 不跟 round_start 时，恢复逻辑会重发模型请求"

    settled = [
        {"type": "_new_round", "round_id": "round-1", "next_round": 2},
        {"type": "round_start", "round_id": "round-2"},
    ]
    out, refires = await _recover_frames(settled, monkeypatch)
    assert refires == 0, "续轮已开始（round_start）就不该再发模型请求"
    assert [json.loads(l[len("data: "):])["type"] for l in out] == ["_new_round", "round_start"]
