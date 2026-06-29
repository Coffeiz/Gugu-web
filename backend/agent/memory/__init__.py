"""咕咕记忆系统（Phase 2 · 伙伴化）。

- store      读写用户私有 .agent/ markdown 档案（经 StorageBackend，单库）
- reflection 对话后提炼"新了解"，增量写入 facts/daily（fire-and-forget）
"""
from agent.memory import store, reflection

__all__ = ["store", "reflection"]
