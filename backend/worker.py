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
import re
import signal
import socket

from app.core import redis as R
from agent.models import AgentRequest
from agent.runner import run_collect

# 模型偶尔把加粗写成「** 文字**」（** 后带空格），这种松散写法不是标准 markdown。网页端
# marked.js 已有同款修复（GuguChat.vue fixLooseBold），但只在网页生效；IM 各渠道自己的
# markdown 渲染器（QQ 官方 msg_type=2、飞书卡片 markdown 元素）比 marked.js 严格，解析不了
# 就原样显示 **文字**——QQ 电脑端容忍度更高看不出来，手机端会露出星号。这里补给所有 IM
# 渠道共用的出口，发送前统一清理一遍，跳过代码块/行内代码不动（里面的 ** 可能是真实内容）。
_CODE_SPLIT_RE = re.compile(r'(```[\s\S]*?```|`[^`\n]*`)')
_BOLD_LEAD_WS_RE = re.compile(r'\*\*[ \t]+([^*\n]+?)\*\*')
_BOLD_TRAIL_WS_RE = re.compile(r'\*\*([^*\n]+?)[ \t]+\*\*')


def _fix_loose_bold(text: str) -> str:
    parts = _CODE_SPLIT_RE.split(text)
    for i in range(0, len(parts), 2):   # 偶数下标是非代码段，奇数下标是代码块/行内代码，原样保留
        parts[i] = _BOLD_LEAD_WS_RE.sub(r'**\1**', parts[i])
        parts[i] = _BOLD_TRAIL_WS_RE.sub(r'**\1**', parts[i])
    return ''.join(parts)

STREAM = R.IM_INBOUND_STREAM
GROUP = "agent-workers"
# 稳定 consumer 名：重启不换名（原来带 pid，每次重启留个死 consumer 累积，见地基 B）。
# 多 worker 时给每实例设 GUGU_WORKER_SLOT=0/1/2 区分。
_slot = os.getenv("GUGU_WORKER_SLOT", "").strip()
CONSUMER = socket.gethostname() + (f"-{_slot}" if _slot else "")

_stop = asyncio.Event()

# ── P1-① 有界并发（worker 基本在等 LLM，IO 密集，串行白白浪费事件循环）──────────
# 并发上限由 Admin 配置 agent.worker_concurrency 控制，worker 每 30s（reconcile 时）热读、无需重启。
# 实测单 MiniMax key 安全上限≈16（带工具 sem=20 全 429）；要更大吞吐 = 多备 key，不是调大此数。
_max_concurrency = 16                          # 当前生效值（_refresh_concurrency 热更新；run_once 据此留空闲槽）
_user_locks: dict[str, asyncio.Lock] = {}      # user_gate：同用户串行保序、不同用户并发
_inflight: set = set()                         # 在跑任务集：背压计数 + 优雅 drain

# ── 输入防抖：QQ 等平台「一张图一条消息」，连发的图 + 后面的指令本是一次表达。
#    不立即处理，攒进缓冲；同一用户每来一条就把「截止时刻」推后；静默到期才把缓冲里所有消息
#    合并成「一轮」处理、只回一次。**非对称窗口**：带文字的消息 = 用户说完了 → 短窗口快速回；
#    纯附件（图/文件没配文字）= 多半还在补图 / 正手打指令 → 给更长窗口等后面的指令（先发图、隔
#    几秒再打「存一下」也能并进同一轮，否则指令那轮手上没图、咕咕反问「存什么」）。
DEBOUNCE_SEC = 1.0          # 带文字：用户说完了，快速处理
DEBOUNCE_ATT_SEC = 1.0     # 纯附件：与文字同 1s（reset 仍能攒连发的图；快，但发完图停顿>1s 再打指令会拆轮）
_user_buffers: dict[str, list] = {}            # puid -> [(msg_id, payload)] 待处理缓冲
_user_deadline: dict[str, float] = {}          # puid -> 防抖截止时刻（loop.time()），每条新消息推后
_user_flush: dict[str, asyncio.Task] = {}      # puid -> 正在跑的 flush loop（每用户至多一个）
_flush_tasks: set = set()                       # 所有 flush loop：供优雅 drain 等它们跑完
_run_sem = asyncio.Semaphore(_max_concurrency)  # flush 阶段真正跑 agent 的全局并发上限


def _refresh_concurrency():
    """从 config.override.json 直接热读并发上限（隔离读，不动全局 settings 缓存）。"""
    global _max_concurrency
    val = 16
    try:
        import json as _json
        from app.core.config import OVERRIDE_FILE
        if OVERRIDE_FILE.exists():
            ov = _json.loads(OVERRIDE_FILE.read_text(encoding="utf-8"))
            v = (ov.get("agent") or {}).get("worker_concurrency")
            if v is not None:
                val = int(v)
    except Exception:
        pass
    new = max(1, min(64, val))
    if new != _max_concurrency:
        print(f"[worker] 并发上限 {_max_concurrency} → {new}", flush=True)
    _max_concurrency = new


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
    elif platform == "qqbot" and (payload.get("chat_id") or payload.get("platform_user_id")):
        from agent.adapters import qq
        if payload.get("chat_type") == "group":
            # 群聊回复要发到群（chat_id=group_openid），不能发到发言人的 C2C 私聊
            await qq.send_group(payload["chat_id"], text,
                                payload.get("message_id"), payload.get("channel_id"))
        else:
            await qq.send_c2c(payload["platform_user_id"], text,
                              payload.get("message_id"), payload.get("channel_id"))
    elif platform == "wechat" and payload.get("platform_user_id"):
        from agent.adapters import wechat
        # iLink 回复必须带入站消息的 context_token（worker 透传）
        await wechat.send_text(payload["platform_user_id"], text,
                               payload.get("channel_id"), payload.get("context_token", ""))
    else:
        from agent import logsafe
        print(f"[worker] (无发送通道) {platform}: len={len(text)} fp={logsafe.fingerprint(text)}", flush=True)


# 飞书上传上限：图片 10MB、文件 30MB（超限飞书返回非 JSON 错误页，SDK 会 JSONDecodeError）
_FEISHU_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_FEISHU_IMAGE_MAX = 10 * 1024 * 1024
_FEISHU_FILE_MAX = 30 * 1024 * 1024


async def _send_files(payload: dict, files: list):
    """咕咕 send_file 工具产出的文件，按平台发回。两种来源：① 文件库文件（_artifact 带 file_id）；
    ② 网络图片/暂存附件（_artifact 带 attach_id，如 image_search 配 send_file(url=...) 下载暂存的图）。
    飞书：图片/文件都能发（≤10/30MB）；QQ：⚠️ 官方只开放发图片，文档发不了 → 兜底提示。
    微信：图片走 `send_image`（item.type=2），其他文件走 `send_file`（item.type=4），均经 CDN 上传。"""
    if not files:
        return
    platform = payload.get("platform")
    if platform not in ("feishu", "qqbot", "wechat"):
        print(f"[worker] {platform} 暂不支持发文件（{len(files)} 个）", flush=True)
        return
    if platform == "qqbot" and payload.get("chat_type") == "group":
        # QQ 群聊图片/文件发送走另一套受限接口（暂未接），先兜底提示，别悄悄丢文件
        await _send(payload, f"（群里暂不支持发图片/文件，私聊我看 {len(files)} 个文件吧～）")
        return
    import app.db.session as _S
    from app.models import File
    from app.services.storage import get_storage
    if _S._engine is None:
        _S._build_engine()
    for f in files:
        fid = f.get("file_id")
        attach_id = f.get("attach_id")
        try:
            if fid:
                async with _S._SessionLocal() as db:
                    rec = await db.get(File, fid)
                if not rec:
                    continue
                display_name, ext, storage_key = rec.display_name, rec.ext, rec.storage_key
            elif attach_id:
                from app.core import chat_attach
                owner = payload.get("owner_user_id")
                meta = await chat_attach.get_meta(owner, attach_id) if owner else None
                if not meta:
                    continue
                display_name = f.get("name") or meta.get("name") or "图片"
                ext, storage_key = meta.get("ext", ""), meta["storage_key"]
            else:
                continue
            fname = f"{display_name}.{ext}"
            if platform == "feishu":
                data = await get_storage().get(storage_key)
                await _send_file_feishu(payload, ext, data, fname)
            elif platform == "qqbot":
                await _send_file_qq(payload, storage_key, ext, display_name, fname)   # OSS 用 URL 模式时不必读字节
            else:  # wechat
                await _send_file_wechat(payload, storage_key, ext, fname)
        except Exception as e:
            print(f"[worker] 发文件出错 {fid or attach_id}: {type(e).__name__}: {e}", flush=True)


# 微信 CDN 上传对图片/文件大小没硬上限，但大文件 AES 加密 + CDN POST 慢且占内存；
# 设个软上限防意外（飞书图片 10MB / 文件 30MB；QQ 10MB；这里用飞书的限作通用上限，避免 worker 内存炸）
_WECHAT_FILE_MAX = 30 * 1024 * 1024   # 30 MB，跟飞书文件上限对齐


async def _send_file_wechat(payload, storage_key: str, ext: str, fname: str):
    """微信发图/文件：图片走 wechat.send_image，其他走 wechat.send_file。
    两者底层都是 iLink CDN + AES-128-ECB 上传（见 wechat.py / wechat_media_crypto.py）。"""
    from agent.adapters import wechat as _wechat
    from app.services.storage import get_storage
    openid = payload.get("platform_user_id")
    if not openid:
        return
    context_token = payload.get("context_token", "")
    storage = get_storage()
    data = await storage.get(storage_key)
    if len(data) > _WECHAT_FILE_MAX:
        mb = len(data) / 1048576
        await _send(payload, f"《{fname}》有 {mb:.0f}MB，超过微信 {int(_WECHAT_FILE_MAX/1048576)}MB 上限发不了 😅")
        return
    is_img = (ext or "").lower() in {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
    if is_img:
        ok = await _wechat.send_image(openid, data, context_token, payload.get("channel_id"))
        label = "图片"
    else:
        ok = await _wechat.send_file(openid, data, fname, context_token, payload.get("channel_id"))
        label = "文件"
    print(f"[worker] wechat 发{label} {fname}: {'ok' if ok else '失败'}（{len(data)} bytes）", flush=True)
    if not ok:
        await _send(payload, f"《{fname}》没发出去（微信那边拒了），你去网页对话或文件库里下载吧。")


async def _send_file_feishu(payload, ext: str, data: bytes, fname: str):
    from agent.adapters import feishu
    # 超限直接拦下，别让飞书返回错误页把 SDK 撞成 JSONDecodeError；改发一句说明
    is_img = (ext or "").lower() in _FEISHU_IMAGE_EXTS
    limit = _FEISHU_IMAGE_MAX if is_img else _FEISHU_FILE_MAX
    if len(data) > limit:
        mb, lim_mb = len(data) / 1048576, limit // 1048576
        print(f"[worker] feishu 发文件 {fname}: 跳过（{mb:.1f}MB > {lim_mb}MB 上限）", flush=True)
        await _send(payload, f"《{fname}》有 {mb:.0f}MB，超过飞书 {lim_mb}MB 上限发不了 😅 你去网页对话或文件库里下载吧。")
        return
    display_name = fname.rsplit(".", 1)[0] if "." in fname else fname
    ok = await feishu.send_file(payload.get("chat_id"), data, display_name, ext, payload.get("channel_id"))
    print(f"[worker] feishu 发文件 {fname}: {'ok' if ok else '失败'}", flush=True)
    if not ok:
        await _send(payload, f"《{fname}》没发出去（飞书那边拒了），你去网页对话或文件库里下载吧。")


# QQ C2C 富媒体走 base64 上传，请求体膨胀 33%；实测约 10MB 为界（9.5MB 过、10.8MB 挂
# 「call inner proxy error」）。本地存储没公网 URL，没法换 URL 模式，只能卡这个上限。
_QQ_FILE_MAX = 10 * 1024 * 1024


async def _send_file_qq(payload, storage_key: str, ext: str, display_name: str, fname: str):
    from agent.adapters import qq
    from app.services.storage import get_storage
    openid = payload.get("platform_user_id")
    storage = get_storage()
    url = storage.fetch_url(storage_key)   # OSS→签名 URL（无体积限制）；本地→None
    if url:
        ok = await qq.send_file(openid, None, display_name, ext,
                                payload.get("channel_id"), payload.get("message_id"), url=url)
    else:
        # 本地存储没公网 URL，只能 base64 上传，受 ~10MB 限制
        data = await storage.get(storage_key)
        if len(data) > _QQ_FILE_MAX:
            await _send(payload, f"《{fname}》有 {len(data)/1048576:.0f}MB，超过 QQ 上限（本地存储约 10MB）发不了，去网页/文件库下载吧。")
            return
        ok = await qq.send_file(openid, data, display_name, ext,
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

    # 恢复全链路 trace（网关生成、payload 接力；防抖合并取最后一条的）——此后本任务内
    # 的工具轨迹/回复日志自动带同一 trace，可与网关「收到」行 grep 串联
    from agent import trace
    _tid = trace.set_trace(payload.get("trace_id"))

    req = AgentRequest(
        message=payload.get("text", ""),
        user_id=user_id, user_name=user_name,
        session_id=sid,
        source=platform,
        attachments=payload.get("attachments") or [],
        quoted_text=payload.get("quoted_text"),
    )
    # 记忆控制命令（/memory /forget，中文别名 /记忆 /忘记）：确定性短路，零 LLM、不计精力、
    # 不反思、不进会话历史——与 web 路（adapters/web.py）同一处理，IM 用户同享隐私控制权（P0-5）
    from agent import commands as _commands
    cmd_reply = await _commands.handle(user_id, req.message)
    if cmd_reply is not None:
        await _send(payload, cmd_reply)
        print(f"[worker] {platform} 记忆命令(trace={_tid}) → 已短路回复", flush=True)
        return None

    # 把 IM 上下文透传给工具层（react 工具据此给用户这条消息加表情；State Manager 据此打细粒度状态；
    # chat_type/context_token 供慢工具进度声明主动推送时直接拼 worker._send() 的 payload 用）
    from agent import imctx
    imctx.set_im(platform, payload.get("message_id"), payload.get("channel_id"), payload.get("chat_id"), puid,
                payload.get("chat_type"), payload.get("context_token", ""))
    # 记一份「可触达地址」：定时任务/主动推送时按 user_id 反查这里发 IM
    try:
        from app import scheduled_tasks as schedtasks
        await schedtasks.save_imreach(user_id, platform, payload.get("channel_id"), payload.get("chat_id"), puid,
                                       payload.get("context_token", ""))
    except Exception:
        pass
    # State Manager：标记「忙」——网关据此短路「还在吗 / 算了」（IM 单 worker 顺序消费，忙时它看不到后续消息）
    from agent import runtime_state as rtstate
    await rtstate.set_state(platform, puid, rtstate.THINKING)
    # 微信 typing indicator：处理期间给对方微信显示「正在输入」，处理完自动关（仅 wechat 平台、其他平台退化）
    from agent.adapters import wechat as _wechat
    _typing_ind = await _wechat.start_typing(payload)
    stream_sent = False
    try:
        # 飞书流式回复（2026-07-09 接入）：feishu 平台走 run_stream → feishu.send_text_stream，
        # 把 token 实时 patch 到飞书卡片（IM 端模拟 SSE 体感）；其他平台继续走 run_collect 非流式。
        if platform == "feishu":
            from agent.runner import run_stream
            from agent.adapters import feishu as _feishu
            token_iter = run_stream(req)
            rid = payload.get("chat_id") or payload.get("platform_user_id")
            # send_text_stream 消费完整个 token_iter（包括 final 事件），返回 (ok, final_resp)
            _ok, resp = await _feishu.send_text_stream(rid, token_iter, payload.get("channel_id"))
            stream_sent = bool(_ok)
            if resp is None:
                # run_stream 没 yield final（极端情况，比如一 token 没生成就崩了）
                resp = AgentResponse(text="", session_id=None, tokens_in=0, tokens_out=0)
        else:
            resp = await run_collect(req)
    finally:
        await rtstate.clear_state(platform, puid)
        await rtstate.clear_cancel(platform, puid)
        await _wechat.stop_typing(_typing_ind)   # 无论成败都关 typing
    await _im_session_set(platform, puid, resp.session_id)   # 续上同一会话
    if resp.cancelled:
        # 用户中途「算了」：网关已回「先不继续啦」，这里不再补发任何内容
        await rtstate.set_awaiting(platform, puid, False)   # 没有悬而未决的提问了
        print(f"[worker] {platform} 任务被用户取消，跳过回复", flush=True)
        return resp
    # 表情回应已由网关「秒回」（_on_message 收到即发），这里不再补
    # QQ 的「思考中」占位只认文本/markdown 被动回复，不认媒体消息（文件/图片）。
    # 咕咕光发文件、没配文字时补一句短文本，让被动回复成立、思考态能正常消解。
    reply_text = _fix_loose_bold(resp.text or "")
    if not (reply_text or "").strip():
        # 模型没出文本：有文件配一句「给你～」，纯空则给个兜底——别发空
        #（空内容发 QQ 会报「无效 markdown content」，用户啥也收不到）
        reply_text = "给你～" if resp.files else "嗯~在的，你说～"
    # 飞书流式回复成功时，最终文本已在 feishu.send_text_stream 内 patch 到卡片；失败则回落普通文本发送。
    if not (platform == "feishu" and stream_sent) and reply_text.strip():
        await _send(payload, reply_text)
    await _send_files(payload, resp.files)   # 咕咕 send_file 的文件发回平台
    # 这条以提问/确认收尾 → 置「等回话」标志，网关下条「嗯/好/算了」就放行进 agent（别当闲聊吞了）
    from agent import router as _router
    await rtstate.set_awaiting(platform, puid, _router.reply_awaits_answer(reply_text))
    # 隐私：不打印回复原文（此前全文不截断，比收到那侧还暴露），只留结构+指纹（见 agent/logsafe.py）
    from agent import logsafe
    print(f"[worker] {platform} 回复(session={resp.session_id} trace={_tid}) len={len(reply_text)} "
          f"fp={logsafe.fingerprint(reply_text)}", flush=True)
    return resp


def _merge_payloads(payloads: list) -> dict:
    """把同一用户连发的多条消息合并成一条：拼接非空文字、合并所有附件；路由字段（message_id /
    channel_id 等）取**最后一条**——被动回复 / 表情挂在最近那条上。"""
    base = dict(payloads[-1])
    texts, atts = [], []
    for p in payloads:
        t = (p.get("text") or "").strip()
        if t:
            texts.append(t)
        atts.extend(p.get("attachments") or [])
    base["text"] = "\n".join(texts)
    base["attachments"] = atts
    return base


async def _flush_loop(puid: str):
    """等该用户「静默满 DEBOUNCE_SEC」→ 把缓冲里所有消息合并成一轮处理、只回一次。
    处理期间新到的消息进新缓冲，本 loop 跑完会再攒再处理，直到缓冲空才退出。
    用「截止时刻不断被推后」轮询、不 cancel——cancel 会打断正在跑的 run_collect。"""
    loop = asyncio.get_event_loop()
    try:
        while True:
            # 等防抖：截止时刻被新消息不断推后，就一直等到它不再往后挪
            while True:
                now = loop.time()
                dl = _user_deadline.get(puid, now)
                if now >= dl:
                    break
                await asyncio.sleep(dl - now)
            lock = _user_locks.setdefault(puid, asyncio.Lock())
            async with lock:
                batch = _user_buffers.pop(puid, [])
                if not batch:
                    _user_deadline.pop(puid, None)
                    _user_flush.pop(puid, None)
                    return
                merged = _merge_payloads([p for _, p in batch])
                rep_msg_id = batch[-1][0]
                async with _run_sem:     # 多用户同时活跃时，跑 agent 的全局并发上限
                    try:
                        await handle(rep_msg_id, merged)
                    except Exception as e:
                        print(f"[worker] flush handle 出错（已 ack 丢弃，避免毒消息循环）: {type(e).__name__}: {e}", flush=True)
                    finally:
                        for mid, _ in batch:
                            await R.ack(STREAM, GROUP, mid)
    finally:
        _user_flush.pop(puid, None)


async def _dispatch(msg_id: str, payload: dict):
    """幂等去重 → 投入「防抖缓冲」（不立即处理）。同一用户 1s 内连发的消息攒成一轮、只回一次。"""
    # 幂等：同一 stream 条目被 claim_stale（60s）重投时跳过，防重复（在投缓冲前就丢）
    try:
        fresh = await R.get_redis().set(f"imseen:{msg_id}", "1", ex=3600, nx=True)
    except Exception:
        fresh = True
    if not fresh:
        await R.ack(STREAM, GROUP, msg_id)
        return
    puid = payload.get("platform_user_id") or msg_id
    # 投缓冲 + 把截止时刻推后；**不在这里 ack**，留到 flush（崩了未 ack → claim_stale 60s 重投兜底）
    _user_buffers.setdefault(puid, []).append((msg_id, payload))
    has_text = bool((payload.get("text") or "").strip())   # 这条带文字 = 短窗口；纯附件 = 长窗口等指令
    window = DEBOUNCE_SEC if has_text else DEBOUNCE_ATT_SEC
    _user_deadline[puid] = asyncio.get_event_loop().time() + window
    t = _user_flush.get(puid)
    if t is None or t.done():
        nt = asyncio.create_task(_flush_loop(puid))
        _user_flush[puid] = nt
        _flush_tasks.add(nt)
        nt.add_done_callback(_flush_tasks.discard)


async def run_once(block_ms: int = 5000) -> int:
    """消费一批并发派发（不阻塞等处理）。按在跑数留空闲槽，防任务无界堆积。返回派发条数。"""
    free = _max_concurrency - len(_inflight)
    if free <= 0:
        await asyncio.sleep(0.1)
        return 0
    # 先回收崩溃 worker 的遗留（>60s 未 ack），再收新消息，合计不超过空闲槽
    msgs = list(await R.claim_stale(STREAM, GROUP, CONSUMER, min_idle_ms=60000, count=free))
    need = free - len(msgs)
    if need > 0:
        msgs += await R.consume(STREAM, GROUP, CONSUMER, count=need, block_ms=block_ms)
    for msg_id, payload in msgs:
        t = asyncio.create_task(_dispatch(msg_id, payload))
        _inflight.add(t)
        t.add_done_callback(_inflight.discard)
    handled = len(msgs)
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
    _refresh_concurrency()
    try:
        n = await R.cleanup_dead_consumers(STREAM, GROUP, CONSUMER)
        if n:
            print(f"[worker] 清理死 consumer {n} 个", flush=True)
    except Exception:
        pass
    print(f"[worker] started · consumer={CONSUMER} · stream={STREAM} · 并发={_max_concurrency}", flush=True)
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
    # 优雅 drain：收到 SIGTERM 停收新消息后，等在跑的处理完再退（并发后必须，别截断回复）
    #   含防抖 flush loop——停收新消息后它们各自把缓冲清空就退出，别截断正在生成的回复。
    pending = list(_inflight) + list(_flush_tasks)
    if pending:
        print(f"[worker] drain：等 {len(_inflight)} 条派发 + {len(_flush_tasks)} 个缓冲收尾…", flush=True)
        await asyncio.gather(*pending, return_exceptions=True)
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
        _refresh_concurrency()                   # 顺带热读并发上限（Admin 改了 ≤30s 生效）
        try:
            from app.core.config import get_settings
            get_settings.cache_clear()           # 清缓存 → worker 也热读 Admin 配置（模型策略/分流/行为等，≤30s 生效）
        except Exception:
            pass
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
