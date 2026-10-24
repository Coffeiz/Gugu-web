"""Web Gateway resume 实现。"""
from __future__ import annotations
import json
from typing import AsyncGenerator
from agent.llm import genstream


async def resume(session_id) -> AsyncGenerator[str, None]:
    """续看：浏览器刷新后重连进行中的生成。先把已生成的内容补一次，再订阅后续。

    没有进行中的生成（或已完成）→ 立即发 idle done，前端就走正常 DB 加载。
    订阅在读取快照前建立，避免快照与频道之间出现丢终态事件的窗口；回复最终以 DB 为准。
    """
    # 必须先订阅再读快照。否则后台可能恰好在 snapshot() 返回后发布 done，
    # 续看端点既看不到终态，也收不到后续广播。
    pubsub = await genstream.open_subscription(session_id)
    try:
        snap = await genstream.snapshot(session_id)
        if not snap or snap.get("done"):
            yield f"data: {json.dumps({'type': 'done', 'idle': True})}\n\n"
            return
        timeline = snap.get("timeline") or []
        if timeline:
            # 快照按实际发布顺序保存，刷新时必须按这个顺序重放。
            # 不能先恢复累计正文、再恢复工具列表，否则运行中的多 round 会把
            # 正文气泡全部挪到顶部、工具气泡全部挪到底部，直到 run 结束才恢复。
            for item in timeline:
                if not isinstance(item, dict) or not item.get("type"):
                    continue
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        async for line in genstream.subscribe(session_id, pubsub=pubsub):
            yield line
        pubsub = None
    finally:
        if pubsub is not None:
            await genstream.close_subscription(session_id, pubsub)
