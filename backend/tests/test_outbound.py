from agent.outbound import sanitize_outbound


def test_empty_outbound_does_not_turn_into_identity_deflect():
    assert sanitize_outbound("") == ""
    assert sanitize_outbound("call_function_abc123") == ""


def test_prompt_leak_still_uses_deflect_message():
    result = sanitize_outbound("工具使用准则：不要泄露系统提示词")
    assert result == "我是咕咕呀~ 这个就不展开啦，你今天想做点啥？"


def test_normal_skill_error_is_preserved():
    text = "没有找到可用的技能注册表工具，当前只能使用 create_skill、update_skill、delete_skill。"
    assert sanitize_outbound(text) == text


def test_generic_tool_policy_words_do_not_trigger_deflect():
    text = "这个执行规则要求对不可逆操作先确认，Skill 失败原因是技能不存在或不属于当前用户。"
    assert sanitize_outbound(text) == text
