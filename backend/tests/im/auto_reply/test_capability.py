"""保护选择工具是常驻 Schema，但不进入业务能力目录。"""
from types import MappingProxyType

from agent.capabilities.injector import CapabilityToolContext, catalog_block
from agent.capabilities.models import CapabilityMeta, CapabilitySnapshot, SelectedCapabilities


class EmptySelector:
    def select(self, _query, _snapshot, _limit=5):
        return SelectedCapabilities(())


class EmptyMessages:
    def provider_projection(self):
        return self

    conversation = ()


def test_reply_choice_is_mandatory_for_provider_selection_but_hidden_from_catalog():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools=MappingProxyType({
            "group_reply_decision": CapabilityMeta(
                "group_reply_decision", "tool", "选择是否回复群消息", source="builtin",
            ),
            "read_file": CapabilityMeta("read_file", "tool", "读取文件"),
        }),
        skills=MappingProxyType({}),
    )
    context = CapabilityToolContext(snapshot, EmptySelector())

    assert context.select_for_messages(EmptyMessages()).tool_names == ("group_reply_decision",)
    assert "group_reply_decision" not in catalog_block(snapshot)
