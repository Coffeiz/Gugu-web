"""按会话的「生成流」通道：让 web 生成脱离 HTTP 请求，刷新后可续看。

问题：原 web 生成跑在请求的 StreamingResponse 生成器里，浏览器一刷新就断连 →
生成器被取消 → 咕咕停止生成、回复也没持久化。

方案：生成改成**后台任务**，把事件(token/tool_call/...)发到 Redis 频道
`genstream:{session_id}`，并把「当前进度」存成**状态快照**(已生成文字 / 当前工具 /
是否完成)。
- 原标签：`/chat` 转发频道，照常实时看。
- 刷新后：先读快照(已生成的部分) → 再订阅频道看后续。
- 生成完：后台任务持久化回复并 `end()`，之后正常从 DB 读。

快照中的 `tools` 保留真实工具调用 ID、参数及 run/round 身份，供刷新后的
前端恢复同一工具气泡；没有正文或工具调用时，前端续接会继续显示思考状态。

与 `app/core/events.py`（资源变更通知）不同：这是**按会话的流式输出**通道。
IM 流式（飞书卡片）将来也复用这条频道。
"""
from __future__ import annotations

import json
from uuid import uuid4

from app.core.redis import get_redis

TTL = 300   # 活跃标志/快照存活秒数；生成中每次 publish/touch 刷新，卡死/崩溃后自动过期
LEASE_TTL = 300  # 后台任务租约；必须覆盖压缩/工具调用等长于普通请求的阶段
DONE_GRACE_TTL = 60  # 终态快照短暂保留，覆盖 done 广播与下一次续看之间的竞态
BEAT_TTL = 90  # 进程存活心跳；run loop 心跳约 15s 续一次，崩溃后 ≤90s 即可判定僵尸快照


def _ch(session_id) -> str:
    return f"genstream:{session_id}"


def _state_key(session_id) -> str:
    return f"genstream:state:{session_id}"


def _beat_key(session_id) -> str:
    return f"genstream:beat:{session_id}"


def _cancel_key(session_id) -> str:
    return f"genstream:cancel:{session_id}"


def _lease_key(session_id) -> str:
    return f"genstream:lease:{session_id}"


def new_run_id() -> str:
    """生成 Web 生成流的归属 ID，与 provider round ID 保持不同。"""
    return f"run-{uuid4().hex[:16]}"


def _owner_key(session_id) -> str:
    return f"genstream:owner:{session_id}"


_END_SCRIPT = """
local owner = redis.call('GET', KEYS[4])
local requested = ARGV[1]
-- 新实现必须校验 owner；没有 owner key 的旧快照只允许兼容性清理。
if owner and owner ~= '' and owner ~= requested then
    return 0
end
local lease_owner = redis.call('GET', KEYS[3])
if (not owner or owner == '') and lease_owner and lease_owner ~= '' and lease_owner ~= requested then
    return 0
end

local state_raw = redis.call('GET', KEYS[1])
local done = false
if state_raw then
    local ok, state = pcall(cjson.decode, state_raw)
    if ok and state and state['done'] then
        done = true
    end
end
if state_raw and done then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
else
    redis.call('DEL', KEYS[1])
end
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
return 1
"""


async def begin(session_id, owner_run_id: str | None = None) -> None:
    """开始一轮生成：初始化空快照 + 标记活跃。"""
    owner_run_id = str(owner_run_id or "")
    state = {
        "text": "", "files": [], "done": False, "error": None,
        "run_id": "", "round_id": "", "tools": [], "timeline": [],
        "owner_run_id": owner_run_id,
    }
    try:
        r = get_redis()
        # owner 先于 state 写入，旧任务的延迟 finally 在整个切换窗口内
        # 都会因 owner 不匹配而拒绝清理新一轮状态。
        await r.set(_owner_key(session_id), owner_run_id, ex=LEASE_TTL)
        await r.delete(_cancel_key(session_id))
        await r.delete(_lease_key(session_id))
        await r.set(_beat_key(session_id), "1", ex=BEAT_TTL)
        await r.set(_state_key(session_id), json.dumps(state, ensure_ascii=False), ex=TTL)
    except Exception:
        pass


async def request_cancel(session_id) -> None:
    """请求停止后台生成，由生成 loop 在安全边界消费。"""
    try:
        await get_redis().set(_cancel_key(session_id), "1", ex=TTL)
    except Exception:
        pass


async def is_cancelled(session_id) -> bool:
    """读取 Web/跨请求生成取消标记；Redis 暂时不可用时保持 fail-open。"""
    try:
        return bool(await get_redis().get(_cancel_key(session_id)))
    except Exception:
        return False


async def publish(session_id, event: dict) -> None:
    """更新生成快照并发事件；终止状态必须先写入再广播。"""
    r = get_redis()
    # 先更新快照，再广播事件。否则前端收到 done 后立即发起下一轮时，
    # is_active() 可能仍读到上一轮的 active 状态，误订阅上一轮的频道。
    try:
        raw = await r.get(_state_key(session_id))
        st = json.loads(raw) if raw else {
            "text": "", "files": [], "done": False, "error": None,
            "run_id": "", "round_id": "", "tools": [], "timeline": [],
            "owner_run_id": "",
        }
        st.setdefault("timeline", [])
        et = event.get("type")
        if event.get("run_id"):
            st["run_id"] = event["run_id"]
        if event.get("round_id"):
            st["round_id"] = event["round_id"]
        if et == "token":
            st["text"] += event.get("content", "")
            timeline = st["timeline"]
            event_run_id = event.get("run_id") or st.get("run_id") or ""
            event_round_id = event.get("round_id") or st.get("round_id") or ""
            if (timeline and timeline[-1].get("type") == "token"
                    and timeline[-1].get("run_id") == event_run_id
                    and timeline[-1].get("round_id") == event_round_id):
                timeline[-1]["content"] += event.get("content", "")
            else:
                timeline.append({
                    "type": "token", "content": event.get("content", ""),
                    "run_id": event_run_id,
                    "round_id": event_round_id,
                })
        elif et in ("round_start", "_new_round"):
            st["timeline"].append({
                key: event.get(key) or st.get(key) or ""
                for key in ("type", "run_id", "round_id")
            })
        elif et == "tool_call":
            # 保存完整调用，而不是只保存展示标签；刷新恢复必须能重建真实工具气泡。
            tool_call = {
                "run_id": event.get("run_id") or st.get("run_id") or "",
                "round_id": event.get("round_id") or st.get("round_id") or "",
                "tool_call_id": event.get("tool_call_id") or "",
                "name": event.get("name") or "",
                "label": event.get("label") or event.get("name") or "",
                "input": event.get("input"),
                "status": event.get("status") or "running",
            }
            st.setdefault("tools", []).append(tool_call)
            st["timeline"].append({"type": "tool_call", **tool_call})
        elif et == "tool_done":
            call_id = str(event.get("tool_call_id") or "")
            for tool_call in reversed(st.setdefault("tools", [])):
                if call_id and str(tool_call.get("tool_call_id") or "") == call_id:
                    tool_call["status"] = event.get("status") or "success"
                    if "result" in event:
                        tool_call["result"] = event["result"]
                    break
            for timeline_item in reversed(st["timeline"]):
                if (timeline_item.get("type") == "tool_call"
                        and call_id
                        and str(timeline_item.get("tool_call_id") or "") == call_id):
                    timeline_item["status"] = event.get("status") or "success"
                    if "result" in event:
                        timeline_item["result"] = event["result"]
                    break
        elif et == "file" and event.get("file"):
            st["files"].append(event["file"])
            st["timeline"].append({"type": "file", "file": event["file"]})
        elif et == "done":
            st["done"] = True
        elif et == "error":
            st["done"] = True
            st["error"] = event.get("message") or event.get("detail")
        await r.set(_state_key(session_id), json.dumps(st, ensure_ascii=False), ex=TTL)
    except Exception:
        pass
    try:
        await r.expire(_beat_key(session_id), BEAT_TTL)
        await r.publish(_ch(session_id), json.dumps(event, ensure_ascii=False))
    except Exception:
        return


async def end(session_id, owner_run_id: str | None = None) -> None:
    """生成结束：释放租约，短暂保留终态快照供迟到的订阅者确认完成。"""
    try:
        r = get_redis()
        requested_owner = str(owner_run_id or "")
        await r.eval(
            _END_SCRIPT,
            5,
            _state_key(session_id),
            _cancel_key(session_id),
            _lease_key(session_id),
            _owner_key(session_id),
            _beat_key(session_id),
            requested_owner,
            DONE_GRACE_TTL,
        )
    except AttributeError:
        # 兼容测试替身及旧 Redis 客户端；真实 Redis 使用上面的原子脚本。
        try:
            r = get_redis()
            current_owner = await r.get(_owner_key(session_id))
            current_lease = await r.get(_lease_key(session_id))
            if current_owner and str(current_owner) != requested_owner:
                return
            if not current_owner and current_lease and str(current_lease) != requested_owner:
                return
            raw = await r.get(_state_key(session_id))
            state = json.loads(raw) if raw else None
            if state and state.get("done"):
                await r.expire(_state_key(session_id), DONE_GRACE_TTL)
            else:
                await r.delete(_state_key(session_id))
            await r.delete(_cancel_key(session_id), _lease_key(session_id),
                           _owner_key(session_id), _beat_key(session_id))
        except Exception:
            pass
    except Exception:
        # Redis 脚本执行失败时宁可保留状态，也不能退回非原子清理，避免再次
        # 让旧任务误删新任务的快照。
        pass


async def touch(session_id) -> None:
    """续期活跃快照；交互等待期间没有普通事件，也不能让 Run 变成离线。"""
    try:
        r = get_redis()
        await r.expire(_state_key(session_id), TTL)
        await r.expire(_beat_key(session_id), BEAT_TTL)
        await r.expire(_owner_key(session_id), LEASE_TTL)
    except Exception:
        pass


async def beat_alive(session_id) -> bool:
    """run 进程心跳是否仍在；快照非 done 但心跳已断 = crash 留下的僵尸快照。

    Redis 不可用时保持 fail-open（视为存活），避免把正常生成误判成僵尸。
    """
    try:
        return bool(await get_redis().exists(_beat_key(session_id)))
    except Exception:
        return True


async def reap(session_id) -> None:
    """无条件清掉该会话的全部生成流状态，供孤儿回收使用。

    与 ``end()`` 不同：不做 owner 归属校验，只在已确认 run 进程死亡
    （心跳断且无终态事件）时调用，见 ``probe(stale)`` 与
    ``compress_conv.recover_orphaned_session``。
    """
    try:
        r = get_redis()
        await r.delete(
            _state_key(session_id), _cancel_key(session_id),
            _lease_key(session_id), _owner_key(session_id), _beat_key(session_id),
        )
    except Exception:
        pass


async def snapshot(session_id) -> dict | None:
    """取当前生成快照；无则 None（没有进行中的生成）。"""
    try:
        raw = await get_redis().get(_state_key(session_id))
        return json.loads(raw) if raw else None
    except Exception:
        return None


async def probe(session_id) -> dict:
    """检查生成状态，区分 Redis 故障和确实没有生成状态。

    ``snapshot()`` 为了兼容现有调用方会把 Redis 异常折叠成 ``None``，但孤儿
    run 回收不能使用这个语义：Redis 暂时不可用时，不能把数据库里的正常
    ``running`` 会话清成 ``idle``。这里同时检查快照、任务 owner 和 lease，
    只有三者都不存在时才报告确实没有活跃生成。
    """
    try:
        redis = get_redis()
        raw = await redis.get(_state_key(session_id))
        state = json.loads(raw) if raw else None
        has_owner = bool(await redis.exists(_owner_key(session_id)))
        has_lease = bool(await redis.exists(_lease_key(session_id)))
        has_beat = bool(await redis.exists(_beat_key(session_id)))
    except Exception:
        return {"redis_ok": False, "active": None, "state": None}

    # done 快照仍可能处于 end() 的终态保留窗口；owner/lease 存在时不要在
    # 收口竞态中抢先回收。state 缺失且三类 Redis 状态都没有，才是进程退出
    # 后 finally 未执行留下的孤儿 run。
    active = bool((state and not state.get("done")) or has_owner or has_lease)
    # 僵尸快照：非 done 的 state / 归属键还在，但 run 进程心跳已断——
    # crash 后 TTL 内残留的状态，任何等待它的事件都是无限卡死。
    stale = active and not has_beat
    return {
        "redis_ok": True,
        "active": active,
        "stale": stale,
        "state": state,
        "has_owner": has_owner,
        "has_lease": has_lease,
        "has_beat": has_beat,
    }


async def claim_lease(session_id, run_id: str) -> None:
    """把会话生成归属到已取得 session gate 的后台任务。"""
    try:
        await get_redis().set(_lease_key(session_id), str(run_id), ex=LEASE_TTL)
    except Exception:
        pass


async def renew_lease(session_id, run_id: str) -> bool:
    """仅续期仍属于本 run 的租约，避免旧任务续活新任务。"""
    try:
        r = get_redis()
        key = _lease_key(session_id)
        owner = await r.get(key)
        if str(owner or "") != str(run_id):
            return False
        await r.expire(key, LEASE_TTL)
        await r.expire(_owner_key(session_id), LEASE_TTL)
        return True
    except Exception:
        return False


async def release_lease(session_id, run_id: str) -> None:
    """只删除当前 run 持有的租约。"""
    try:
        r = get_redis()
        key = _lease_key(session_id)
        owner = await r.get(key)
        if str(owner or "") == str(run_id):
            await r.delete(key)
    except Exception:
        pass


async def has_live_lease(session_id) -> bool:
    try:
        return bool(await get_redis().exists(_lease_key(session_id)))
    except Exception:
        # Redis 不可用时保持原有 fail-open，避免把正常生成误判成孤儿。
        return True


async def close_subscription(session_id, pubsub) -> None:
    """关闭预先建立的 Redis 订阅，供续看在快照判定后提前退出时复用。"""
    try:
        await pubsub.unsubscribe(_ch(session_id))
        await pubsub.aclose()
    except Exception:
        pass


async def is_active(session_id) -> bool:
    snap = await snapshot(session_id)
    # 生成状态以快照终态为准；lease 只表示后台任务的进程所有权，不能作为
    # 前端续看或取消的业务事实，否则任务刚启动时会出现 false inactive。
    return bool(snap) and not snap.get("done")


async def open_subscription(session_id):
    """先建立订阅（attach 到频道）并返回 pubsub，让调用方能在『启动生成之前』就订上。
    pub/sub 发完即弃，只送达当时已订阅者；先订阅后，频道消息会进连接缓冲、不丢——
    这是首条消息『空气泡』（生成头几个 token 抢在订阅前 publish 掉了）的根治点。"""
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(_ch(session_id))
    return pubsub


async def typed_stream(text: str, delay: float = 0.045):
    """把一段文字按 SSE `token` 事件**逐字**吐出 → 复用前端对 token 流的现成渲染，
    做出「咕咕逐字打字」的 SSE 动画效果。用于系统侧主动让咕咕说一句话（如配额硬拦提示），
    全局可复用：`async for line in genstream.typed_stream(msg): yield line`。"""
    import asyncio
    for ch in text:
        yield f"data: {json.dumps({'type': 'token', 'content': ch}, ensure_ascii=False)}\n\n"
        await asyncio.sleep(delay)


async def immediate_stream(text: str):
    """一次性发送一条文本 SSE，不触发前端逐字动画。

    用于确定性命令等已经完整生成的短回复；普通模型回复仍使用真实 token 流，
    系统硬拦提示也保留原有打字反馈。
    """
    yield f"data: {json.dumps({'type': 'token', 'content': text}, ensure_ascii=False)}\n\n"


async def subscribe(session_id, pubsub=None):
    """订阅某会话的生成频道，逐条 yield SSE 行。无消息时定期 keepalive。
    可传入 open_subscription() 预先订好的 pubsub（避免订阅前丢消息）。"""
    ch = _ch(session_id)
    r = get_redis()
    if pubsub is None:
        pubsub = r.pubsub()
        await pubsub.subscribe(ch)
    try:
        while True:
            try:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=20.0)
            except Exception:
                yield ": retry\n\n"
                continue
            if msg is None:
                # 后台任务和 HTTP/SSE 转发解耦；快照只用于确认业务终态，
                # lease 只负责并发归属，不能作为流状态或失败依据。
                try:
                    raw_state = await r.get(_state_key(session_id))
                    state = json.loads(raw_state) if raw_state else None
                except Exception:
                    # Redis 短暂不可用时不要误判业务终态，继续等待下一次心跳。
                    state = {"done": False}
                if state and state.get("done"):
                    # 终态事件可能已经错过，但快照仍是权威结果；补发 done
                    # 让前端正常结束当前流，不制造中断气泡。
                    yield "data: " + json.dumps({"type": "done", "replayed": True}) + "\n\n"
                    return
                if not state:
                    # 没有快照只说明这条传输没有可续接的生成；不能把连接状态
                    # 推断成业务失败。实际失败必须由后台任务发布 error 事件。
                    yield "data: " + json.dumps({"type": "done", "idle": True}) + "\n\n"
                    return
                if not await beat_alive(session_id):
                    # 快照非 done 但 run 进程心跳已断：crash 留下的僵尸快照，
                    # 永远等不到后续事件。回收残留并让前端走正常 DB 加载，
                    # 否则这条流会一直空转（重启后「会话卡死」的根源）。
                    await reap(session_id)
                    yield "data: " + json.dumps({"type": "done", "idle": True}) + "\n\n"
                    return
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
        await close_subscription(session_id, pubsub)
