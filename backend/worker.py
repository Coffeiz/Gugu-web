"""IM 消息 worker：独立进程，消费队列 → 跑非流式 agent →（暂打印）→ ack。

独立于 web 进程运行（避免多 uvicorn worker 各自重复消费长连接/队列）。
启动（从 backend/ 跑，加载 .env）：
    .venv/bin/python -m worker      # 或 python worker.py

消息体（由网关 produce，step 6 补平台用户→咕咕用户映射）：
    {platform, platform_user_id, user_id, user_name, text, session_id?}

step 3 阶段只打印回复、不发平台；发送在 step 5 接平台时补。
"""
from __future__ import annotations

import asyncio
import os
import signal
import socket

from app.core import redis as R
from agent.models import AgentRequest
from agent.runner import run_collect

STREAM = R.IM_INBOUND_STREAM
GROUP = "agent-workers"
CONSUMER = f"{socket.gethostname()}-{os.getpid()}"

_stop = asyncio.Event()


_DEFAULT_HINT = "你好，我是咕咕 🐦\n这个机器人还没和咕咕账号关联好，去咕咕「个人设置 → 接入咕咕」重新扫码连接一下吧。"


async def _resolve_user(payload: dict):
    """平台用户 → 咕咕 user_id。飞书/QQ 都是 BYO：bot 即归属，payload 自带
    owner_user_id，直接用（查昵称即可）。返回 (user_id, display_name)；认不出 (None, "")。"""
    owner = payload.get("owner_user_id")
    if not owner:
        return None, ""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import User
    async with _sess._SessionLocal() as db:
        u = await db.get(User, owner)
    return (owner, (u.display_name or "")) if u else (None, "")


async def _send(payload: dict, text: str):
    """按平台把文本发回。"""
    platform = payload.get("platform")
    if platform == "feishu" and (payload.get("chat_id") or payload.get("platform_user_id")):
        from agent.adapters import feishu
        # chat_id（消息学到的会话）优先，否则用 open_id（连接时存的 owner 地址）
        rid = payload.get("chat_id") or payload.get("platform_user_id")
        await feishu.send_text(rid, text, payload.get("channel_id"))
    elif platform == "qqbot" and payload.get("platform_user_id"):
        from agent.adapters import qq
        await qq.send_c2c(payload["platform_user_id"], text,
                          payload.get("message_id"), payload.get("channel_id"))
    else:
        print(f"[worker] (无发送通道) {platform}: {text!r}", flush=True)


# 飞书上传上限：图片 10MB、文件 30MB（超限飞书返回非 JSON 错误页，SDK 会 JSONDecodeError）
_FEISHU_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_FEISHU_IMAGE_MAX = 10 * 1024 * 1024
_FEISHU_FILE_MAX = 30 * 1024 * 1024


async def _send_files(payload: dict, files: list):
    """咕咕 send_file 工具产出的文件，按平台发回。
    飞书：图片/文件都能发（≤10/30MB）；QQ：⚠️ 官方只开放发图片，文档发不了 → 兜底提示。"""
    if not files:
        return
    platform = payload.get("platform")
    if platform not in ("feishu", "qqbot"):
        print(f"[worker] {platform} 暂不支持发文件（{len(files)} 个）", flush=True)
        return
    import app.db.session as _S
    from app.models import File
    from app.services.storage import get_storage
    if _S._engine is None:
        _S._build_engine()
    for f in files:
        fid = f.get("file_id")
        if not fid:
            continue
        try:
            async with _S._SessionLocal() as db:
                rec = await db.get(File, fid)
            if not rec:
                continue
            fname = f"{rec.display_name}.{rec.ext}"
            if platform == "feishu":
                data = await get_storage().get(rec.storage_key)
                await _send_file_feishu(payload, rec, data, fname)
            else:
                await _send_file_qq(payload, rec, fname)   # OSS 用 URL 模式时不必读字节
        except Exception as e:
            print(f"[worker] 发文件出错 {fid}: {type(e).__name__}: {e}", flush=True)


async def _send_file_feishu(payload, rec, data: bytes, fname: str):
    from agent.adapters import feishu
    # 超限直接拦下，别让飞书返回错误页把 SDK 撞成 JSONDecodeError；改发一句说明
    is_img = (rec.ext or "").lower() in _FEISHU_IMAGE_EXTS
    limit = _FEISHU_IMAGE_MAX if is_img else _FEISHU_FILE_MAX
    if len(data) > limit:
        mb, lim_mb = len(data) / 1048576, limit // 1048576
        print(f"[worker] feishu 发文件 {fname}: 跳过（{mb:.1f}MB > {lim_mb}MB 上限）", flush=True)
        await _send(payload, f"《{fname}》有 {mb:.0f}MB，超过飞书 {lim_mb}MB 上限发不了 😅 你去网页对话或文件库里下载吧。")
        return
    ok = await feishu.send_file(payload.get("chat_id"), data, rec.display_name, rec.ext, payload.get("channel_id"))
    print(f"[worker] feishu 发文件 {fname}: {'ok' if ok else '失败'}", flush=True)
    if not ok:
        await _send(payload, f"《{fname}》没发出去（飞书那边拒了），你去网页对话或文件库里下载吧。")


# QQ C2C 富媒体走 base64 上传，请求体膨胀 33%；实测约 10MB 为界（9.5MB 过、10.8MB 挂
# 「call inner proxy error」）。本地存储没公网 URL，没法换 URL 模式，只能卡这个上限。
_QQ_FILE_MAX = 10 * 1024 * 1024


async def _send_file_qq(payload, rec, fname: str):
    from agent.adapters import qq
    from app.services.storage import get_storage
    openid = payload.get("platform_user_id")
    storage = get_storage()
    url = storage.fetch_url(rec.storage_key)   # OSS→签名 URL（无体积限制）；本地→None
    if url:
        ok = await qq.send_file(openid, None, rec.display_name, rec.ext,
                                payload.get("channel_id"), payload.get("message_id"), url=url)
    else:
        # 本地存储没公网 URL，只能 base64 上传，受 ~10MB 限制
        data = await storage.get(rec.storage_key)
        if len(data) > _QQ_FILE_MAX:
            await _send(payload, f"《{fname}》有 {len(data)/1048576:.0f}MB，超过 QQ 上限（本地存储约 10MB）发不了，去网页/文件库下载吧。")
            return
        ok = await qq.send_file(openid, data, rec.display_name, rec.ext,
                                payload.get("channel_id"), payload.get("message_id"))
    print(f"[worker] qq 发文件 {fname}: {'ok' if ok else '失败'}{'（URL模式）' if url else ''}", flush=True)
    if not ok:
        await _send(payload, f"《{fname}》没发出去（QQ 那边拒了），你去网页对话或文件库里下载吧。")


# IM 会话映射：按 (platform, 平台用户) 记一个稳定 session_id，续聊不断。
# 滑动 TTL：每条消息刷新，空闲超 IM_SESSION_TTL 自动起新会话。
IM_SESSION_TTL = 12 * 3600  # 12 小时


def _im_sess_key(platform: str, puid: str) -> str:
    return f"imsession:{platform}:{puid}"


async def _im_session_get(platform: str, puid: str):
    if not platform or not puid:
        return None
    raw = await R.get_redis().get(_im_sess_key(platform, puid))
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


async def _im_session_set(platform: str, puid: str, session_id):
    if platform and puid and session_id:
        await R.get_redis().set(_im_sess_key(platform, puid), str(session_id), ex=IM_SESSION_TTL)


async def handle(msg_id: str, payload: dict):
    """处理一条：解析用户 → 未绑定回提示 / 已绑定跑 agent（带会话历史）→ 发回平台。"""
    user_id, user_name = await _resolve_user(payload)
    if not user_id:
        # 认不出（bot 没 owner，理论上不该发生）：回提示，不跑大脑
        await _send(payload, _DEFAULT_HINT)
        print(f"[worker] 未绑定用户 {payload.get('platform_user_id')}，已回提示", flush=True)
        return None

    platform = payload.get("platform", "worker")
    puid = payload.get("platform_user_id")
    sid = payload.get("session_id") or await _im_session_get(platform, puid)

    req = AgentRequest(
        message=payload.get("text", ""),
        user_id=user_id, user_name=user_name,
        session_id=sid,
        source=platform,
        attachments=payload.get("attachments") or [],
    )
    # 把 IM 上下文透传给工具层（react 工具据此给用户这条消息加表情；State Manager 据此打细粒度状态）
    from agent import imctx
    imctx.set_im(platform, payload.get("message_id"), payload.get("channel_id"), payload.get("chat_id"), puid)
    # 记一份「可触达地址」：定时任务/主动推送时按 user_id 反查这里发 IM
    try:
        from app import scheduled_tasks as schedtasks
        await schedtasks.save_imreach(user_id, platform, payload.get("channel_id"), payload.get("chat_id"), puid)
    except Exception:
        pass
    # State Manager：标记「忙」——网关据此短路「还在吗 / 算了」（IM 单 worker 顺序消费，忙时它看不到后续消息）
    from agent import runtime_state as rtstate
    await rtstate.set_state(platform, puid, rtstate.THINKING)
    try:
        resp = await run_collect(req)
    finally:
        await rtstate.clear_state(platform, puid)
        await rtstate.clear_cancel(platform, puid)
    await _im_session_set(platform, puid, resp.session_id)   # 续上同一会话
    if resp.cancelled:
        # 用户中途「算了」：网关已回「先不继续啦」，这里不再补发任何内容
        print(f"[worker] {platform} 任务被用户取消，跳过回复", flush=True)
        return resp
    # 表情回应已由网关「秒回」（_on_message 收到即发），这里不再补
    # QQ 的「思考中」占位只认文本/markdown 被动回复，不认媒体消息（文件/图片）。
    # 咕咕光发文件、没配文字时补一句短文本，让被动回复成立、思考态能正常消解。
    reply_text = resp.text
    if not (reply_text or "").strip():
        # 模型没出文本：有文件配一句「给你～」，纯空则给个兜底——别发空
        #（空内容发 QQ 会报「无效 markdown content」，用户啥也收不到）
        reply_text = "给你～" if resp.files else "嗯~在的，你说～"
    if reply_text.strip():
        await _send(payload, reply_text)
    await _send_files(payload, resp.files)   # 咕咕 send_file 的文件发回平台
    print(f"[worker] {platform} 回复(session={resp.session_id}) → {resp.text!r}", flush=True)
    return resp


async def run_once(block_ms: int = 5000) -> int:
    """消费一批并处理。返回处理条数。先回收崩溃 worker 的遗留，再收新消息。"""
    handled = 0
    # 回收待处理超 60s 的（崩溃 worker 遗留），与新消息一并处理
    stale = await R.claim_stale(STREAM, GROUP, CONSUMER, min_idle_ms=60000, count=10)
    msgs = stale + await R.consume(STREAM, GROUP, CONSUMER, count=10, block_ms=block_ms)
    for msg_id, payload in msgs:
        try:
            await handle(msg_id, payload)
        except Exception as e:
            print(f"[worker] handle 出错（已 ack 丢弃，避免毒消息循环）: {type(e).__name__}: {e}", flush=True)
        finally:
            await R.ack(STREAM, GROUP, msg_id)
            handled += 1
    return handled


async def _heartbeat():
    from app.core import health
    from app.core import scheduler as sched
    while not _stop.is_set():
        jobs = [{
            "id": j.id, "name": j.name,
            "next": j.next_run_time.strftime("%Y-%m-%d %H:%M") if j.next_run_time else None,
        } for j in sched.jobs()]
        await health.beat("worker", {"consumer": CONSUMER, "jobs": jobs})
        for _ in range(health.INTERVAL):
            if _stop.is_set():
                break
            await asyncio.sleep(1)


async def serve():
    await R.ensure_group(STREAM, GROUP)
    print(f"[worker] started · consumer={CONSUMER} · stream={STREAM}", flush=True)
    hb = asyncio.create_task(_heartbeat())
    # 定时任务引擎：worker 是单实例进程，唯一 owner（web 多 worker 不会重复跑）
    from app.core import scheduler as sched
    from app import scheduled_tasks as schedtasks
    sched.start()
    try:
        await schedtasks.reconcile()             # 立即从 DB 加载一遍
    except Exception as e:
        print(f"[worker] 定时任务初始化出错: {type(e).__name__}: {e}", flush=True)
    sched_task = asyncio.create_task(_reconcile_loop())
    while not _stop.is_set():
        try:
            await run_once()
        except Exception as e:
            print(f"[worker] loop 出错，2s 后重试: {type(e).__name__}: {e}", flush=True)
            await asyncio.sleep(2)
    hb.cancel()
    sched_task.cancel()
    sched.shutdown()
    await R.reset()
    print("[worker] stopped", flush=True)


async def _reconcile_loop():
    """每 30s 从 DB 对账定时任务（增/删/改/开关即时生效，无需重启）。"""
    from app import scheduled_tasks as schedtasks
    while not _stop.is_set():
        for _ in range(30):
            if _stop.is_set():
                return
            await asyncio.sleep(1)
        try:
            await schedtasks.reconcile()
        except Exception as e:
            print(f"[worker] 定时任务 reconcile 出错: {type(e).__name__}: {e}", flush=True)


def _install_signals(loop):
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop.set)
        except NotImplementedError:
            pass  # 某些平台不支持


def main():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _install_signals(loop)
    try:
        loop.run_until_complete(serve())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
