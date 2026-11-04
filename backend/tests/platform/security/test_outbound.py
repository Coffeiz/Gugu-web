from agent.outbound import sanitize_outbound


def test_empty_outbound_does_not_turn_into_identity_deflect():
    assert sanitize_outbound("") == ""
    assert sanitize_outbound("call_function_abc123") == ""


def test_policy_terms_in_normal_text_are_preserved():
    text = (
        "这几个口径有来源吗？请区分工具使用准则、真实性铁律、对外口径、"
        "内容政策（红线）、四种相处状态、主动思考（陪着）和高风险内容。"
    )
    assert sanitize_outbound(text) == text


def test_normal_skill_error_is_preserved():
    text = "没有找到可用的技能注册表工具，当前只能使用 create_skill、update_skill、delete_skill。"
    assert sanitize_outbound(text) == text


def test_generic_tool_policy_words_do_not_trigger_deflect():
    text = "这个执行规则要求对不可逆操作先确认，Skill 失败原因是技能不存在或不属于当前用户。"
    assert sanitize_outbound(text) == text
