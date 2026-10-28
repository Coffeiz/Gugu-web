"""保护 provider 在回复选择前后分别只收到正确的工具集合。"""
from types import SimpleNamespace

from agent.im.auto_reply import ReplyChoice, ReplyGate
from agent.loop.round_runtime import ProviderRoundRuntime


class CapabilityContext:
    metadata_only = False
    fixed_adapter = False

    def select_for_messages(self, _messages):
        return SimpleNamespace(tool_names=("read_file", "group_reply_decision"))


class Driver:
    def __init__(self):
        self.tool_names = []

    def update_tools(self, _context, names, *, tool_snapshot):
        self.tool_names = list(names)


def test_provider_schema_opens_business_tools_only_after_reply_selection():
    gate = ReplyGate()
    driver = Driver()
    runner = SimpleNamespace(
        group_reply_gate=gate,
        capability_context=CapabilityContext(),
        tool_names=["read_file", "group_reply_decision"],
        _provider_tool_names=lambda names: list(names),
    )
    runtime = ProviderRoundRuntime(
        runner=runner,
        driver=driver,
        client=None,
        context=object(),
        ai=None,
        messages=None,
        system_text=None,
        tool_snapshot=object(),
        tool_names=["read_file", "group_reply_decision"],
        stream_round=None,
    )

    runtime._refresh_tools()
    assert driver.tool_names == ["group_reply_decision"]

    gate.choose(True)
    runtime._refresh_tools()
    assert driver.tool_names == ["read_file"]
    assert gate.choice is ReplyChoice.REPLY
