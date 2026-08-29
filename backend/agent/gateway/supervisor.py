"""兼容旧入口：网关管理进程已统一使用 ``agent.gateway.gateway``。"""
from __future__ import annotations

from .gateway import main


if __name__ == "__main__":
    main()
