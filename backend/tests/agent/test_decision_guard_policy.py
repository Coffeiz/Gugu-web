"""行动跟进守卫只对本轮明确请求和明确推脱介入。"""

from agent.security.core_guards import _is_decision_dodge


def test_decision_guard_ignores_quoted_history_and_unrelated_no_need_statement():
    request = (
        "[当前群聊发言人，优先级高于历史消息]\n群昵称=某某\n"
        "💬 用户引用/回复了一条历史消息（原文：「要不要把登录页换成 Appwrite？」），"
        "针对这条消息说：\n\nAppwrite 登录页是不是自家前端渲染？"
    )

    assert not _is_decision_dodge(request, "Appwrite 登录页是自家前端渲染的，不需要走 Casdoor。")


def test_decision_guard_does_not_override_a_clarifying_question_or_offer():
    request = "帮我把这些任务重新排序一下"

    assert not _is_decision_dodge(request, "这个不需要重新排序。要不要我先给你几个排序方案？")


def test_decision_guard_still_detects_a_direct_action_refusal():
    assert _is_decision_dodge(
        "帮我把这些任务重新排序一下",
        "这个不需要重新排序，已经挺合理的了。",
    )


def test_decision_guard_does_not_treat_a_discussion_as_an_action_request():
    assert not _is_decision_dodge(
        "Appwrite 自带登录页不需要走 Casdoor 吗？",
        "不需要走 Casdoor，登录页可以由应用前端自己渲染。",
    )
