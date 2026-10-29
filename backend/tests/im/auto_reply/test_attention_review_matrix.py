"""PRD-IM-17 v1.4 评审用场景矩阵，覆盖用户可观察的群聊准入结果。"""
from dataclasses import replace

import pytest

from agent.im.auto_reply.attention import (
    AttentionKind,
    AttentionMessage,
    AttentionMode,
    AttentionSnapshot,
    BotReplyFact,
    decide_attention,
)


NOW = 1_761_746_400_000


def message(text="", **overrides):
    values = {
        "event_id": f"{NOW}-0", "platform": "qq", "bot_id": "bot-a",
        "group_id": "group-a", "platform_message_id": "message-a",
        "sender_id": "member-a", "event_received_ms": NOW,
        "platform_sent_ms": None, "raw_text": text, "media_only": False,
        "media_kinds": (), "processable_media": None,
        "mentioned_current_bot": False, "mentioned_other_bot": False,
        "mentioned_other_member": False, "has_unresolved_mention": False,
        "reply_to_platform_message_id": None, "reply_target_sender_id": None,
        "reply_target_is_bot": None, "quote_text": None, "sender_is_bot": False,
    }
    values.update(overrides)
    return AttentionMessage(**values)


def complete_snapshot(**kwargs):
    return AttentionSnapshot(complete=kwargs.pop("complete", True), watermark_ms=NOW, **kwargs)


# 各条代表一个独立对话情境。用于审阅的是 kind/reason，避免测试绑定分解细节。
SCENARIOS = [
    # autonomous：任意普通消息沿既有 Agent Run，不被新规则拦截。
    ("自主-普通陈述", "autonomous", "今天下雨", {}, {}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-短感谢", "autonomous", "谢谢", {}, {}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-贴纸", "autonomous", "", {"media_only": True, "media_kinds": ("sticker",)}, {}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-未解析@", "autonomous", "@someone hi", {"has_unresolved_mention": True}, {}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-其他Bot@", "autonomous", "@other 看看", {"mentioned_other_bot": True}, {}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-裸图片", "autonomous", "", {"media_only": True, "media_kinds": ("image",)}, {}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-解决确认", "autonomous", "已经解决了", {}, {"resolved_question_ids": frozenset({"q1"}), "question_owners": {"q1": "member-a"}}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-忙碌群提问", "autonomous", "Python 超时怎么处理？", {}, {"messages": tuple(message("闲聊", event_id=f"{NOW-i*1000}-0", sender_id=f"m{i}") for i in range(8))}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-无完整历史", "autonomous", "有人知道吗？", {}, {"complete": False}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-额度耗尽", "autonomous", "FastAPI 超时怎么排查？", {}, {}, False, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-显式@", "autonomous", "咕咕，看看这个", {"mentioned_current_bot": True}, {}, False, (), "ALLOW_RUN", "autonomous_bypass"),
    ("自主-引用Bot追问", "autonomous", "仍然不行，连接池超时", {"reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-1000, "member-a", True)}}, True, (), "ALLOW_RUN", "autonomous_bypass"),
    # 显式邀请与可信续接在 scored 模式直达原 Run。
    ("显式原生@安静档", "quiet", "看一下", {"mentioned_current_bot": True}, {}, False, (), "DIRECT", "DIRECT_invitation"),
    ("别名明确提问自然档", "natural", "咕咕，FastAPI 超时怎么查？", {}, {}, False, ("咕咕",), "DIRECT", "DIRECT_invitation"),
    ("别名只有称呼不构成邀请", "natural", "咕咕你好", {}, {}, True, ("咕咕",), "PASSIVE", "not_open_candidate"),
    ("Bot引用可验证追问", "quiet", "还是不行，连接池超时", {"reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-30_000, "member-a", True)}}, False, (), "CONTINUE", "CONTINUE_verified_reply"),
    ("Bot引用超出续接窗口", "quiet", "还是不行，连接池超时", {"reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-121_000, "member-a", True)}}, True, (), "PASSIVE", "not_open_candidate"),
    ("Bot引用收件人不匹配", "quiet", "还是不行，连接池超时", {"reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-30_000, "member-b", True)}}, True, (), "PASSIVE", "not_open_candidate"),
    ("Bot引用发送未确认", "quiet", "还是不行，连接池超时", {"reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-30_000, "member-a", False)}}, True, (), "PASSIVE", "not_open_candidate"),
    ("Bot引用历史不完整", "quiet", "还是不行，连接池超时", {"reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"complete": False, "bot_replies": {"r1": BotReplyFact("r1", NOW-30_000, "member-a", True)}}, True, (), "PASSIVE", "not_open_candidate"),
    ("感谢不是可信续接", "active", "谢谢", {"reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-30_000, "member-a", True)}}, True, (), "PASSIVE", "H02_short_reaction"),
    ("引用他人回复", "active", "你这个说法怎么理解？", {"reply_to_platform_message_id": "human1", "reply_target_is_bot": False}, {}, True, (), "PASSIVE", "H04_reply_to_other"),
    # 硬拒绝与话题关闭。
    ("纯贴纸", "active", "", {"media_only": True, "media_kinds": ("sticker",)}, {}, True, (), "PASSIVE", "H01_reaction_only_media"),
    ("收到", "natural", "收到", {}, {}, True, (), "PASSIVE", "H02_short_reaction"),
    ("问号单独一条", "active", "？", {}, {}, True, (), "PASSIVE", "H02_short_reaction"),
    ("@其他成员", "active", "@someone 看一下", {"mentioned_other_member": True}, {}, True, (), "PASSIVE", "H03_other_mention"),
    ("@其他Bot", "natural", "@otherbot 帮我查下", {"mentioned_other_bot": True}, {}, True, (), "PASSIVE", "H03_other_mention"),
    ("可信具体问题已解决", "active", "已经解决了", {"reply_to_platform_message_id": "q1"}, {"resolved_question_ids": frozenset({"q1"}), "question_owners": {"q1": "member-a"}}, True, (), "PASSIVE", "H08_question_resolved"),
    ("他人声称问题解决不拒绝", "active", "已经解决了", {"sender_id": "member-b", "reply_to_platform_message_id": "q1"}, {"resolved_question_ids": frozenset({"q1"}), "question_owners": {"q1": "member-a"}}, True, (), "PASSIVE", "not_open_candidate"),
    ("社交感叹", "active", "笑死了", {}, {}, True, (), "PASSIVE", "H02_short_reaction"),
    ("具体短请求不按长度拒绝", "active", "求推荐个笔记本", {}, {}, True, (), "PASSIVE", "not_open_candidate"),
    ("引用对象未知不当作他人回复", "active", "这个方案怎么做？", {"reply_to_platform_message_id": "q1"}, {}, True, (), "PASSIVE", "P02_substantive_question"),
    ("开放受众但太模糊", "active", "有人吗？", {}, {}, True, (), "PASSIVE", "not_open_candidate"),
    # 开放候选分数、模式门槛、历史覆盖、预算。
    ("安静群实质问题自然档70", "natural", "Python 的连接池超时怎么处理？", {}, {}, True, (), "PROACTIVE", "P02_substantive_question"),
    ("安静群实质问题主动档70", "active", "Python 的连接池超时怎么处理？", {}, {}, True, (), "PROACTIVE", "P02_substantive_question"),
    ("全群明确求助", "natural", "有人知道 FastAPI 连接池报错怎么解决吗？", {}, {}, True, (), "PROACTIVE", "P01_group_broadcast_request"),
    ("公开问题55分边界自然档不准入", "natural", "FastAPI 连接池超时怎么弄?", {}, {}, True, (), "PASSIVE", "P02_substantive_question"),
    ("公开问题55分边界主动档准入", "active", "FastAPI 连接池超时怎么弄?", {}, {}, True, (), "PROACTIVE", "P02_substantive_question"),
    ("自然档预算耗尽", "natural", "Python 的连接池超时怎么处理？", {}, {}, False, (), "PASSIVE", "proactive_budget_unavailable"),
    ("主动档预算耗尽", "active", "Python 的连接池超时怎么处理？", {}, {}, False, (), "PASSIVE", "proactive_budget_unavailable"),
    ("历史快照不完整不准入", "active", "Python 的连接池超时怎么处理？", {}, {"complete": False}, True, (), "PASSIVE", "snapshot_incomplete"),
    ("A-B-A人际交流降低自然档分数", "natural", "Python 的连接池超时怎么处理？", {}, {"messages": (
        message("先前讨论", event_id=f"{NOW-3000}-0", sender_id="member-a", platform_message_id="a1"),
        message("接着讨论", event_id=f"{NOW-2000}-0", sender_id="member-b", platform_message_id="b1"),
    )}, True, (), "PASSIVE", "N02_weak_peer_exchange"),
    ("同一实质问题独立提问加分", "natural", "有人知道 FastAPI 连接池报错怎么解决吗？", {}, {"batch_messages": (message("有人知道 FastAPI 连接池报错怎么解决吗？", event_id=f"{NOW-1000}-0", sender_id="member-b"),)}, True, (), "PROACTIVE", "P01_group_broadcast_request"),
    ("答案已由Bot给出降分", "active", "Python 的连接池超时怎么处理？", {"platform_message_id": "q1"}, {"answered_question_ids": frozenset({"q1"})}, True, (), "PASSIVE", "N07_bot_already_answered"),
    ("先前主动回复影响自然档", "natural", "有人知道 FastAPI 连接池报错怎么解决吗？", {}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-120_000, "member-a", True, proactive=True)}}, True, (), "PASSIVE", "N04_recent_proactive_bot_reply"),
    ("八条群消息忙碌扣分仍可主动档准入", "active", "Python 的连接池超时怎么处理？", {}, {"batch_messages": tuple(message("闲聊", event_id=f"{NOW-i*1000}-0", sender_id=f"m{i}") for i in range(1, 8))}, True, (), "PROACTIVE", "N05_busy_group"),
    ("八条群消息忙碌自然档不准入", "natural", "Python 的连接池超时怎么处理？", {}, {"batch_messages": tuple(message("闲聊", event_id=f"{NOW-i*1000}-0", sender_id=f"m{i}") for i in range(1, 8))}, True, (), "PASSIVE", "N05_busy_group"),
    ("未解析@不生成开放候选", "active", "@unknown Python 超时怎么处理？", {"has_unresolved_mention": True}, {}, True, (), "PASSIVE", "not_open_candidate"),
    ("二人称实质问题不靠开放受众加分", "active", "你们知道 Python 超时怎么处理吗？", {}, {}, True, (), "PROACTIVE", "P02_substantive_question"),
    # 媒体、可信锚点与材料兜底。
    ("裸图片未解决", "natural", "", {"media_only": True, "media_kinds": ("image",), "processable_media": True}, {}, True, (), "PASSIVE", "media_unresolved"),
    ("裸文件未解决", "active", "", {"media_only": True, "media_kinds": ("file",), "processable_media": True}, {}, True, (), "PASSIVE", "media_unresolved"),
    ("不可处理图片", "active", "请看看这个", {"media_kinds": ("image",), "processable_media": None}, {}, True, (), "PASSIVE", "media_unresolved"),
    ("明示审阅可处理图片自然档", "natural", "请看看这个", {"media_kinds": ("image",), "processable_media": True}, {}, True, (), "PROACTIVE", "UNSCORED_FALLBACK_processable_media_with_explicit_request"),
    ("明示审阅图片主动档预算耗尽", "active", "请看看这个", {"media_kinds": ("image",), "processable_media": True}, {}, False, (), "PASSIVE", "UNSCORED_FALLBACK_material_budget_unavailable"),
    ("仅文件名不算审阅请求", "active", "报错截图.png", {"media_kinds": ("image",), "processable_media": True}, {}, True, (), "PASSIVE", "media_unresolved"),
    ("可信Bot索取后补图片", "quiet", "", {"media_only": True, "media_kinds": ("image",), "processable_media": True, "reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-20_000, "member-a", True)}}, True, (), "CONTINUE", "CONTINUE_verified_media_reply"),
    ("未处理媒体不能作为续接", "quiet", "", {"media_only": True, "media_kinds": ("image",), "processable_media": None, "reply_to_platform_message_id": "r1", "reply_target_is_bot": True}, {"bot_replies": {"r1": BotReplyFact("r1", NOW-20_000, "member-a", True)}}, True, (), "PASSIVE", "media_unresolved"),
    ("同人可信锚点软续接", "natural", "这个文件还是报错怎么办？", {}, {"soft_request_anchor_id": "anchor-1"}, False, (), "SOFT_CONTINUE", "SOFT_CONTINUE_verified_material_request"),
    ("安静档不做软续接", "quiet", "这个文件还是报错怎么办？", {}, {"soft_request_anchor_id": "anchor-1"}, True, (), "PASSIVE", "quiet_mode_suppresses_open_candidate"),
    ("软续接太短不触发", "active", "继续", {}, {"soft_request_anchor_id": "anchor-1"}, True, (), "PASSIVE", "not_open_candidate"),
    ("软续接@他人不触发", "active", "这个文件还是报错怎么办？", {"mentioned_other_member": True}, {"soft_request_anchor_id": "anchor-1"}, True, (), "PASSIVE", "H03_other_mention"),
]


@pytest.mark.parametrize(
    "name, mode, text, overrides, snapshot_kwargs, budget, aliases, expected_kind, expected_reason",
    SCENARIOS,
    ids=[scenario[0] for scenario in SCENARIOS],
)
def test_attention_review_matrix(
    name, mode, text, overrides, snapshot_kwargs, budget, aliases,
    expected_kind, expected_reason,
):
    current = message(text, **overrides)
    snapshot = complete_snapshot(**snapshot_kwargs)
    decision = decide_attention(
        current, snapshot, AttentionMode(mode), budget_available=budget,
        bot_aliases=aliases,
    )
    assert decision.kind is AttentionKind(expected_kind), name
    assert expected_reason in decision.reasons, (name, decision)


def test_review_matrix_contains_at_least_fifty_distinct_dialogue_scenarios():
    assert len(SCENARIOS) >= 50
    assert len({scenario[0] for scenario in SCENARIOS}) == len(SCENARIOS)
