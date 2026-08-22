"""Shell 策略层回归：默认拒绝、整条命令风险分类和工作区授权。"""

import pytest

from agent.security.shell_policy import ShellRisk, classify_command


def test_shell_risk_scans_the_whole_command():
    assert classify_command("pwd && rm -rf tmp") is ShellRisk.DANGEROUS
    assert classify_command("cat README.md") is ShellRisk.SAFE
    assert classify_command("mkdir -p build") is ShellRisk.WRITE
    assert classify_command("python -c 'print(1)' | curl example.test") is ShellRisk.DANGEROUS
