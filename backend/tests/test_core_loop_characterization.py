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

后 5 个场景是新增的，覆盖原脚本没测到的三条防幻觉守卫（叙事/意图播报/决策拒绝）+
空回复兜底 + 轮次上限——这几处正是合并时最容易被悄悄改坏的分支，因为两条循环里
是逐字复制的同一段判断，合并时任何一次「顺手改一下措辞/顺序」都可能让两路从此不同步。
"""
import asyncio
import collections
import json
from types import SimpleNamespace

import pytest

import agent.core as core
import agent.context.compaction as compaction
from agent.core import (
    LLMRunner, MAX_ROUNDS, MAX_TOOL_CALLS, MAX_VERIFY, _FINALIZE_PROMPT, _VERIFY_PROMPT,
)
from agent.tools import registry


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
    return calls


AI = SimpleNamespace(model="fake", base_url="http://local", api_key="dummy",
                     provider="anthropic", max_tokens=100, temperature=0.7, thinking="disabled")


def make_runner():
    return LLMRunner(tool_names=[], settings=SimpleNamespace(ai=AI))


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


async def test_progress_only_round_is_retried_without_leaking_placeholder(monkeypatch):
    """模型只吐“正在查询”且没有 tool call 时，不能把占位话术当成最终回复。"""
    patch_anthropic(monkeypatch, [
        msg([TX("正在为你查询最新信息。")]),
        msg([TX("查完了，结果如下。")]),
    ])

    ev, text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", [{"role": "user", "content": "查一下最新信息"}], AI)
    )

    # 守卫后的第二轮没有真实工具调用时，追问内容不应再次成为用户可见回复。
    assert text == ""
    assert ev["_new_round"] == 1
    assert errors == []


async def test_final_reply_runs_provider_usage_compaction_check(monkeypatch):
    """无工具的长最终回复也必须走 run 级 provider usage 90% 检查。"""
    calls = []

    async def fake_compact(messages, *args, **kwargs):
        calls.append(kwargs.get("force"))
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
    assert calls == [True]
    assert ev["_context_compaction"] == 1


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
    """成功写入后立即复查，跳过旧流程里无信息的“先收尾、再复查”模型回合。"""
    patch_anthropic(monkeypatch, [
        msg([TX("好的"), TU("create_project", "1", {})]),          # R1 建（带字）
        msg([TX("我来核实一下"), TU("get_project", "2", {})]),     # R2 核实：查（只读）
        msg([TX("我确认一下结果")]),                                  # R3 核验轮文字（静默）
        msg([TX("建好了项目X，3阶段5待办都在 ✅")]),                 # R4 最终收束回复
    ])
    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "建好了项目X" in text
    assert "我来核实一下" not in text, "核实过程文字没被抑制"
    assert "get_project" in dispatched
    assert n_verify(messages) == 1
    assert _FINALIZE_PROMPT in [m.get("content") for m in messages]
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_verify_summary_does_not_add_redundant_finalize_round(monkeypatch, dispatched):
    """核验轮已经给出具体结果时，不再额外调用一次最终收束模型。"""
    patch_anthropic(monkeypatch, [
        msg([TU("create_project", "1", {})]),
        msg([TU("get_project", "2", {})]),
        msg([TX("项目X已创建，阶段和待办都已保存 ✅")]),
    ])
    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "项目X已创建" in text
    assert _FINALIZE_PROMPT not in [m.get("content") for m in messages]
    assert n_verify(messages) == 1
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_verify_fix_then_reverify(monkeypatch, dispatched):
    """核实阶段发现漏项 → 只发一次「发现漏了X」说明，其余核对文字仍静默，补做后再触发一轮核实。"""
    patch_anthropic(monkeypatch, [
        msg([TX("好的"), TU("create_project", "1", {})]),          # R1 建
        msg([TU("get_project", "2", {})]),                         # R2 核实：查（只读，无字）
        msg([TX("发现漏了一个待办，补一下"), TU("add_todo", "3", {})]),  # R3 发现+补 → 说明应发出
        msg([TU("get_project", "4", {})]),                         # R4 补做后立即复查
        msg([TX("都核实过了")]),                                    # R5 核验轮文字（静默）
        msg([TX("项目已补全，所有内容都核实通过")]),                 # R6 最终收束回复
    ])
    messages = [{"role": "user", "content": "建个项目"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert "好的" in text
    assert "发现漏了一个待办" in text, f"补做说明没发出来：{text!r}"
    assert "add_todo" in dispatched
    assert "项目已补全" in text
    assert n_verify(messages) == 2, f"应注入 2 次系统自检（补做触发再核实），实际 {n_verify(messages)}"
    assert ev["_usage"] == 1 and ev["error"] == 0


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


async def test_note_get_counts_as_verify_observation(monkeypatch, dispatched):
    """思维笔记的历史命名不应导致读回后还被重复要求复查。"""
    patch_anthropic(monkeypatch, [
        msg([TU("note_create", "1", {})]),
        msg([TU("note_get", "2", {})]),
        msg([TX("我确认一下笔记")]),
        msg([TX("笔记已记录")]),
    ])
    messages = [{"role": "user", "content": "记一条笔记"}]
    runner = LLMRunner(tool_names=["note_create", "note_get"], settings=SimpleNamespace(ai=AI))
    _ev, text, _errors = await drain(runner._run_anthropic("u", "sys", messages, AI))
    assert "note_get" in dispatched
    assert "笔记已记录" in text
    assert n_verify(messages) == 1


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


async def test_verify_capped_at_max_verify(monkeypatch, dispatched):
    """反复补做 → 核实注入封顶 MAX_VERIFY 次，不会死循环、也不报错。"""
    script = [
        msg([TU("create_project", "0", {})]),   # R1 建（tool）→ did_mutate
    ]
    for i in range(5):   # 每轮核实都"又补一刀"，应被封顶在 MAX_VERIFY
        script.append(msg([TU("update_todo", f"u{i}", {})]))
    script.append(msg([TX("已完成")]))
    patch_anthropic(monkeypatch, script)
    messages = [{"role": "user", "content": "建项目并补全"}]
    ev, text, _errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert n_verify(messages) == MAX_VERIFY, f"应封顶 {MAX_VERIFY} 次，实际 {n_verify(messages)}"
    assert ev["_usage"] == 1 and ev["error"] == 0


async def test_openai_clean_pass_matches_anthropic(monkeypatch, dispatched):
    """Anthropic / OpenAI 两路同构：同样的"干净核实通过"场景，OpenAI 路行为一致。"""
    patch_openai(monkeypatch, [
        _tool_chunks("create_project", "好的"),   # R1 建
        _tool_chunks("get_project", "核对中"),     # R2 核实查（只读）
        _text_chunks("我确认一下结果"),             # R3 核验轮文字（静默）
        _text_chunks("项目X 已创建并核验完成 ✅"),  # R4 最终收束回复
    ])
    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text, _errors = await drain(make_runner()._run_openai("u", messages, AI))
    assert "项目X 已创建并核验完成" in text
    assert "核对中" not in text
    assert "get_project" in dispatched
    assert ev["_usage"] == 1 and ev["error"] == 0


# ══════════════════════════════════════════════════════════════════════════
# 新增：原冒烟脚本没覆盖的分支——三条防幻觉守卫 + 空回复兜底 + 轮次上限
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


async def test_max_rounds_exhausted_reports_friendly_error(monkeypatch, dispatched):
    """普通任务轮次撞上限 → 不报硬错误、不死循环，给友好提示。"""
    # 每轮都真调一个只读工具、且从不产出纯文字收尾；核实预算没有打开时，
    # 普通任务只能消耗 MAX_ROUNDS 轮。
    # 本用例只验证轮次上限；把独立的工具总量上限临时抬高，避免两个保护条件互相抢先触发。
    monkeypatch.setattr(core, "MAX_TOOL_CALLS", MAX_ROUNDS + 1)
    total_rounds = MAX_ROUNDS + 1
    script = [msg([TU("get_project", str(i), {})]) for i in range(total_rounds)]
    patch_anthropic(monkeypatch, script)
    messages = [{"role": "user", "content": "反复查一下"}]
    ev, text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    assert ev["error"] == 0
    assert ev["_usage"] == 0   # 走的是轮次上限提示分支，不是正常收尾
    assert "/unlimited" in text and "30 轮" in text
    assert errors == []


async def test_max_rounds_choice_resumes_same_run_after_unlimited_selected(monkeypatch, dispatched):
    """达到轮次上限后点击解除限制，必须继续原 run，而不是只修改会话后结束。"""
    monkeypatch.setattr(core, "MAX_TOOL_CALLS", MAX_ROUNDS + 1)

    class Prompt:
        id = 901
        kind = "choice"
        title = "要继续这个长任务吗？"
        body = "本次已经达到 30 轮。"
        expires_at = SimpleNamespace(isoformat=lambda: "2026-08-26T00:00:00+08:00")

    async def fake_create_prompt(*, user_id, session_id):
        return Prompt(), [{"id": "goal", "label": "解除工具调用限制", "token": "token"}]

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "selected", "option_id": "continue"}

    monkeypatch.setattr("app.services.interactions.create_goal_mode_prompt", fake_create_prompt)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)
    # 先消耗完整的第一段轮次，解除后下一轮返回正常正文。
    script = [msg([TU("get_project", str(i), {})]) for i in range(MAX_ROUNDS)]
    script.append(msg([TX("解除限制后继续完成")]))
    patch_anthropic(monkeypatch, script)
    messages = [{"role": "user", "content": "执行长任务"}]
    ev, text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", messages, AI, session_id=1)
    )

    assert ev["interaction_required"] == 1
    assert ev["_new_round"] >= 1
    assert "解除限制后继续完成" in text
    assert errors == []


async def test_eight_round_limit_emits_continue_prompt(monkeypatch, dispatched):
    """配置普通上限为 8 轮时，也必须进入同一条继续交互，而不是静默结束。"""
    monkeypatch.setattr(core, "MAX_ROUNDS", 8)
    monkeypatch.setattr(core, "MAX_TOOL_CALLS", 9)

    class Prompt:
        id = 902
        kind = "choice"
        title = "要继续这个任务吗？"
        body = "本次已达到轮次上限。"
        expires_at = SimpleNamespace(isoformat=lambda: "2026-08-26T00:00:00+08:00")

    async def fake_create_prompt(*, user_id, session_id):
        return Prompt(), [{"id": "continue", "label": "解除本轮调用限制", "token": "token"}]

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "selected", "option_id": "cancel"}

    monkeypatch.setattr("app.services.interactions.create_goal_mode_prompt", fake_create_prompt)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)
    patch_anthropic(monkeypatch, [msg([TU("get_project", str(i), {})]) for i in range(8)])
    ev, _text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", [{"role": "user", "content": "查一下"}], AI, session_id=1)
    )

    assert ev["interaction_required"] == 1
    assert errors == []


async def test_tool_calls_exhausted_before_next_real_dispatch(monkeypatch, dispatched):
    """实际工具调用达到 run 上限后，剩余 tool call 只补结果，不再执行真实工具。"""
    calls = [TU("get_project", str(i), {}) for i in range(MAX_TOOL_CALLS + 1)]
    script = [msg(calls[index:index + 2]) for index in range(0, len(calls), 2)]
    patch_anthropic(monkeypatch, script)
    messages = [{"role": "user", "content": "查很多次"}]
    ev, _text, errors = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))

    assert len(dispatched) == MAX_TOOL_CALLS
    assert ev["error"] == 1
    assert any("查询步骤有点多" in detail for detail in errors)


async def test_tool_budget_prompt_resumes_same_run_after_continue(monkeypatch, dispatched):
    """达到工具次数上限后选择继续，必须等待并继续同一个 run。"""
    class Prompt:
        id = 903
        kind = "choice"
        title = "步骤较多，要继续吗？"
        body = "本轮已达到普通工具调用次数。"
        expires_at = SimpleNamespace(isoformat=lambda: "2026-08-26T00:00:00+08:00")

    async def fake_create_prompt(*, user_id, session_id):
        return Prompt(), [{"id": "continue", "label": "继续执行", "token": "token"}]

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "selected", "option_id": "continue"}

    monkeypatch.setattr("app.services.interactions.create_tool_budget_prompt", fake_create_prompt)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)
    script = [msg([TU("get_project", str(i), {}) for i in range(MAX_TOOL_CALLS + 1)])]
    script.append(msg([TX("继续完成")]))
    patch_anthropic(monkeypatch, script)
    ev, text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", [{"role": "user", "content": "执行任务"}], AI, session_id=1)
    )

    assert ev["interaction_required"] == 1
    assert ev["_new_round"] >= 1
    assert len(dispatched) == MAX_TOOL_CALLS + 1
    assert "继续完成" in text
    assert errors == []


async def test_tool_budget_prompt_blocks_pending_batch_after_cancel(monkeypatch, dispatched):
    """拒绝许可时，当前待执行批次全部阻止，并让模型说明未执行内容。"""
    class Prompt:
        id = 904
        kind = "choice"
        title = "步骤较多，要继续吗？"
        body = "本轮已达到普通工具调用次数。"
        expires_at = SimpleNamespace(isoformat=lambda: "2026-08-26T00:00:00+08:00")

    async def fake_create_prompt(*, user_id, session_id):
        return Prompt(), [{"id": "cancel", "label": "先停在这里", "token": "token"}]

    async def fake_wait_for_resolution(**_kwargs):
        return {"status": "cancelled", "option_id": "cancel"}

    monkeypatch.setattr("app.services.interactions.create_tool_budget_prompt", fake_create_prompt)
    monkeypatch.setattr("app.services.interactions.wait_for_resolution", fake_wait_for_resolution)
    patch_anthropic(monkeypatch, [
        msg([TU("get_project", str(i), {}) for i in range(MAX_TOOL_CALLS + 1)]),
        msg([TX("已根据现有结果整理，剩余请求未执行")]),
    ])
    ev, text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", [{"role": "user", "content": "执行任务"}], AI, session_id=1)
    )

    assert ev["interaction_required"] == 1
    assert len(dispatched) == 0
    assert "剩余请求未执行" in text
    assert errors == []


async def test_goal_mode_allows_more_than_normal_tool_limit(monkeypatch, dispatched):
    """长任务模式解除工具次数上限，但仍沿用同一条 Runner 控制流。"""
    script = [msg([TU("get_project", str(i), {})]) for i in range(MAX_TOOL_CALLS + 1)]
    from agent.core import _GOAL_DONE_MARKER
    script.append(msg([TX(f"任务完成 { _GOAL_DONE_MARKER }")]))
    patch_anthropic(monkeypatch, script)
    messages = [{"role": "user", "content": "长任务模式测试"}]
    session = SimpleNamespace(session_context={"goal_mode": True})
    ev, text, errors = await drain(
        make_runner()._run_anthropic("u", "sys", messages, AI, session=session)
    )

    assert len(dispatched) == MAX_TOOL_CALLS + 1
    assert ev["error"] == 0
    assert "任务完成" in text
    assert errors == []


def test_goal_completion_requires_explicit_marker():
    from agent.core import _GOAL_DONE_MARKER, _goal_completed, _strip_goal_marker

    assert not _goal_completed("任务一完成")
    assert _goal_completed(f"全部完成 {_GOAL_DONE_MARKER}")
    assert _strip_goal_marker(f"完成了 {_GOAL_DONE_MARKER}") == "完成了"
