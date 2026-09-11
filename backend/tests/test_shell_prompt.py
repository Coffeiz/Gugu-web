from agent.context.session_system import append_shell_prompt


def test_shell_prompt_only_appends_for_registered_shell_tool():
    base = "基础系统提示"

    without_shell = append_shell_prompt(base, enabled=False)
    with_shell = append_shell_prompt(base, enabled=True)

    assert without_shell == base
    assert "# Shell 安全协议" not in without_shell
    assert "# Shell 安全协议" in with_shell
    assert "模型不能通过拆分命令、改写命令、换工具" in with_shell
    assert "Python 3.11" in with_shell
    assert "Matplotlib" in with_shell
    assert "`/personal`：当前用户文件库的个人文件空间" in with_shell
    assert "`/project`：当前用户文件库的项目空间" in with_shell
    assert "Workspace 只决定默认目录" in with_shell
    # 绑定/授权只约束 Shell，文件工具不受位置写权限拦截（2026-09-11 产品定案）
    assert "不限制文件库工具" in with_shell
    assert "绑定只决定它们省略目标时的默认落点" in with_shell


def test_shell_prompt_is_idempotent():
    base = append_shell_prompt("基础系统提示", enabled=True)

    assert append_shell_prompt(base, enabled=True) == base
