"""Agent 侧交互服务入口。

数据库生命周期由 app service 持有；这里提供稳定的 Agent import 边界，避免 core/网关
直接依赖 ORM 模型，后续加入 WAITING_INPUT/恢复状态时仍可保持调用点不变。
"""
from app.services.interactions import (
    consume_action,
    consume_text,
    create_agent_prompt,
    create_prompt,
    create_tool_confirmation,
    list_active,
)

__all__ = ["consume_action", "consume_text", "create_agent_prompt", "create_prompt", "create_tool_confirmation", "list_active"]
