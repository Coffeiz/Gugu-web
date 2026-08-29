"""确认门兼容入口。

确认交互的协议入口已整理到 ``agent.interactions.confirmations``。保留这个模块是
为了兼容现有工具和检查脚本的导入路径；安全域的调用方无需一次性迁移。
"""

from agent.interactions.confirmations import is_block, is_confirmed, needs_confirmation

__all__ = ["is_block", "is_confirmed", "needs_confirmation"]
