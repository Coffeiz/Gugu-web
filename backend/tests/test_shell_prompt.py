from agent.context.session_system import append_shell_prompt


def test_shell_prompt_only_appends_for_registered_shell_tool():
    base = "基础系统提示"

    without_shell = append_shell_prompt(base, enabled=False)
    with_shell = append_shell_prompt(base, enabled=True)

    assert without_shell == base
    assert "# Shell 安全协议" not in without_shell
    assert "# Shell 安全协议" in with_shell
    assert "模型不能通过拆分命令、改写命令、换工具" in with_shell


def test_shell_prompt_is_idempotent():
    base = append_shell_prompt("基础系统提示", enabled=True)

    assert append_shell_prompt(base, enabled=True) == base
