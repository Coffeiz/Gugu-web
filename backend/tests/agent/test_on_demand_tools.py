"""常驻工具与按需工具边界回归。"""

from agent.capabilities.defaults import all_system_tool_names
from agent.capabilities.injector import (
    FIXED_ADAPTER_TOOL_NAMES,
    ON_DEMAND_TOOL_NAMES,
    build_fixed_adapter_context,
)


def test_send_link_buttons_is_not_a_resident_tool():
    assert "send_link_buttons" not in all_system_tool_names()
    assert "send_link_buttons" not in FIXED_ADAPTER_TOOL_NAMES
    assert "send_link_buttons" in ON_DEMAND_TOOL_NAMES


def test_send_link_buttons_remains_available_to_on_demand_schema_lookup():
    context = build_fixed_adapter_context(all_system_tool_names())

    assert context.snapshot.tools.get("send_link_buttons") is not None
    assert "send_link_buttons" not in context.select_for_messages([]).tool_names
