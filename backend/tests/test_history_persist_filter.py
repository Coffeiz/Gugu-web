"""持久化前的历史过滤：core 工具循环 delta 里，只有真工具往返该落库，
守卫注入的合成 prompt / 核实内心戏是控制信令、不进对话历史（否则下轮从 content_json
重建时每轮重灌「【系统自检】…」，污染上下文 + 白烧 token）。见 agent/sanitize.tool_rounds_only。
"""
from __future__ import annotations

from agent.security.sanitize import sanitize_messages, tool_rounds_only


def _assistant_tool_use(uid="t1", name="create_project"):
    return {"role": "assistant", "content": [
        {"type": "text", "text": "这就给你建"},
        {"type": "tool_use", "id": uid, "name": name, "input": {"name": "X"}},
    ]}


def _user_tool_result(uid="t1"):
    return {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": uid, "content": "{\"id\": 1}"},
    ]}


def test_keeps_real_tool_rounds():
    delta = [_assistant_tool_use(), _user_tool_result()]
    assert tool_rounds_only(delta) == delta


def test_drops_synthetic_control_user_prompts():
    """守卫注入的合成 user 消息是纯字符串 content（无工具块）→ 丢。"""
    delta = [
        {"role": "assistant", "content": [{"type": "text", "text": "改好了"}]},   # narration 那轮的假装文字
        {"role": "user", "content": "【系统提醒 · 缺少工具回执】…"},            # _NARRATION_NUDGE
    ]
    assert tool_rounds_only(delta) == []


def test_drops_verify_round_inner_monologue():
    """核实轮 assistant 是纯文本、无 tool_use（UI 已丢弃）→ 不该进历史。"""
    delta = [
        {"role": "assistant", "content": [{"type": "text", "text": "我核对一下…确认无误"}]},
        {"role": "user", "content": "【系统自检 · 请认真执行】你刚才执行了增删改…"},   # _VERIFY_PROMPT
    ]
    assert tool_rounds_only(delta) == []


def test_mixed_delta_keeps_only_tool_pairs_in_order():
    """真实 delta：真工具往返 + 一轮核实内心戏 + 补做工具往返 → 只留两对工具往返，顺序不乱。"""
    a1, r1 = _assistant_tool_use("t1", "create_project"), _user_tool_result("t1")
    verify_asst = {"role": "assistant", "content": [{"type": "text", "text": "复查：好像漏了阶段"}]}
    verify_prompt = {"role": "user", "content": "【系统自检 · 请认真执行】…"}
    a2, r2 = _assistant_tool_use("t2", "update_project"), _user_tool_result("t2")

    kept = tool_rounds_only([a1, r1, verify_asst, verify_prompt, a2, r2])
    assert kept == [a1, r1, a2, r2]
    # tool_use ↔ tool_result 配对不被拆散
    assert kept[0]["content"][-1]["id"] == kept[1]["content"][0]["tool_use_id"]
    assert kept[2]["content"][-1]["id"] == kept[3]["content"][0]["tool_use_id"]


def test_empty_and_stringonly_messages_dropped():
    assert tool_rounds_only([]) == []
    assert tool_rounds_only([{"role": "user", "content": "普通文字"}]) == []
    assert tool_rounds_only([{"role": "assistant", "content": []}]) == []


def test_canonical_and_openai_tool_messages_are_kept():
    canonical_call = {"role": "assistant", "content": [{"type": "tool_call"}]}
    canonical_result = {"role": "tool", "content": [{"type": "tool_result"}]}
    openai_call = {"role": "assistant", "content": None, "tool_calls": [{"id": "call-1"}]}
    assert tool_rounds_only([canonical_call, canonical_result, openai_call]) == [
        canonical_call, canonical_result, openai_call,
    ]


def test_sanitize_drops_tool_result_without_id_without_raising():
    messages = [
        {"role": "user", "content": "开始"},
        _assistant_tool_use("call-1"),
        _user_tool_result("call-1"),
        {"role": "user", "content": [{"type": "tool_result", "content": "坏数据"}]},
    ]

    cleaned = sanitize_messages(messages)

    assert len(cleaned) == 3
    assert cleaned[2]["content"][-1]["tool_use_id"] == "call-1"
    assert all(
        block.get("tool_use_id")
        for message in cleaned
        for block in message["content"]
        if block.get("type") == "tool_result"
    )
