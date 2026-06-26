"""按会话的「生成流」通道：让 web 生成脱离 HTTP 请求，刷新后可续看。

问题：原 web 生成跑在请求的 StreamingResponse 生成器里，浏览器一刷新就断连 →
生成器被取消 → 咕咕停止生成、回复也没持久化。

方案：生成改成**后台任务**，把事件(token/tool_call/...)发到 Redis 频道
`genstream:{session_id}`，并把「当前进度」存成**状态快照**(已生成文字 / 当前工具 /
是否完成)。
- 原标签：`/chat` 转发频道，照常实时看。
- 刷新后：先读快照(已生成的部分) → 再订阅频道看后续。
- 生成完：后台任务持久化回复并 `end()`，之后正常从 DB 读。

与 `app/core/events.py`（资源变更通知）不同：这是**按会话的流式输出**通道。
IM 流式（飞书卡片）将来也复用这条频道。
"""
from __future__ import annotations

import json

from app.core.redis import get_redis

TTL = 180   # 活跃标志/快照存活秒数；生成中每次 publish 刷新，卡死/崩溃后自动过期


def _ch(session_id) -> str:
    return f"genstream:{session_id}"


def _state_key(session_id) -> str:
    return f"genstream:state:{session_id}"


async def begin(session_id) -> None:
    """开始一轮生成：初始化空快照 + 标记活跃。"""
    state = {"text": "", "tool": "", "files": [], "done": False, "error": None}
    try:
        await get_redis().set(_state_key(session_id), json.dumps(state, ensure_ascii=False), ex=TTL)
    except Exception:
        pass


async def publish(session_id, event: dict) -> None:
    """发一个生成事件给订阅者，并据其更新状态快照（best-effort）。"""
    r = get_redis()
    try:
        await r.publish(_ch(session_id), json.dumps(event, ensure_ascii=False))
    except Exception:
        return
    # 更新快照（供刷新后重建已生成内容）
    try:
        raw = await r.get(_state_key(session_id))
        st = json.loads(raw) if raw else {"text": "", "tool": "", "files": [], "done": False, "error": None}
        et = event.get("type")
        if et == "token":
            st["text"] += event.get("content", "")
        elif et == "tool_call":
            st["tool"] = event.get("label") or event.get("name") or ""
        elif et == "tool_done":
            st["tool"] = ""
        elif et == "file" and event.get("file"):
            st["files"].append(event["file"])
        elif et == "done":
            st["done"] = True
            st["tool"] = ""
        elif et == "error":
            st["done"] = True
            st["tool"] = ""
            st["error"] = event.get("message") or event.get("detail")
        await r.set(_state_key(session_id), json.dumps(st, ensure_ascii=False), ex=TTL)
    except Exception:
        pass


async def end(session_id) -> None:
    """生成结束：清掉活跃快照（回复此时已持久化，之后从 DB 读）。"""
    try:
        await get_redis().delete(_state_key(session_id))
    except Exception:
        pass


async def snapshot(session_id) -> dict | None:
    """取当前生成快照；无则 None（没有进行中的生成）。"""
    try:
        raw = await get_redis().get(_state_key(session_id))
        return json.loads(raw) if raw else None
    except Exception:
        return None


async def is_active(session_id) -> bool:
    snap = await snapshot(session_id)
    return bool(snap) and not snap.get("done")


async def open_subscription(session_id):
    """先建立订阅（attach 到频道）并返回 pubsub，让调用方能在『启动生成之前』就订上。
    pub/sub 发完即弃，只送达当时已订阅者；先订阅后，频道消息会进连接缓冲、不丢——
    这是首条消息『空气泡』（生成头几个 token 抢在订阅前 publish 掉了）的根治点。"""
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(_ch(session_id))
    return pubsub


async def subscribe(session_id, pubsub=None):
    """订阅某会话的生成频道，逐条 yield SSE 行。无消息时定期 keepalive。
    可传入 open_subscription() 预先订好的 pubsub（避免订阅前丢消息）。"""
    ch = _ch(session_id)
    if pubsub is None:
        pubsub = get_redis().pubsub()
        await pubsub.subscribe(ch)
    try:
        while True:
            try:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=20.0)
            except Exception:
                yield ": retry\n\n"
                continue
            if msg is None:
                yield ": ping\n\n"
                continue
            data = msg.get("data")
            if data:
                yield f"data: {data}\n\n"
                try:
                    if json.loads(data).get("type") in ("done", "error"):
                        return
                except Exception:
                    pass
    finally:
        try:
            await pubsub.unsubscribe(ch)
            await pubsub.aclose()
        except Exception:
            pass
