"""保护选择工具是常驻 Schema，但不进入业务能力目录。"""
from types import MappingProxyType

from agent.capabilities.injector import CapabilityToolContext, catalog_block
from agent.im.auto_reply import GROUP_NO_REPLY_TOOL
from agent.capabilities.models import CapabilityMeta, CapabilitySnapshot, SelectedCapabilities


class EmptySelector:
    def select(self, _query, _snapshot, _limit=5):
        return SelectedCapabilities(())


class EmptyMessages:
    def provider_projection(self):
        return self

    conversation = ()


def test_reply_control_is_hidden_from_capability_catalog():
    snapshot = CapabilitySnapshot(
        generation=1,
        tools=MappingProxyType({
            GROUP_NO_REPLY_TOOL: CapabilityMeta(
                GROUP_NO_REPLY_TOOL, "tool", "选择是否回复群消息", source="builtin",
            ),
            "read_file": CapabilityMeta("read_file", "tool", "读取文件"),
        }),
        skills=MappingProxyType({}),
    )
    context = CapabilityToolContext(snapshot, EmptySelector())

    assert GROUP_NO_REPLY_TOOL not in catalog_block(snapshot)
