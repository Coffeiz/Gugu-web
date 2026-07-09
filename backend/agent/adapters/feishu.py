"""飞书网关：WebSocket 长连接收消息 → 规范化 → 入队 im:inbound（BYO 每用户自带 app）。

不需要公网 URL（lark-oapi WebSocket 长连）。与 QQ 同 BYO 模型：每个用户在「个人设置 →
接入咕咕 → 飞书」用 device flow 扫码创建自己的飞书 app（存 user_bots 表），supervisor 为每个
启用的 user_bot 起一条本网关子进程，凭据走**环境变量注入**。bot 收到的消息天然归属其 owner，
入队 payload 带 owner_user_id，worker 无需再做绑定。

lark 的 `ws.Client.start()` 同步阻塞、事件 handler 同步，故用 `produce_sync` 入队。
lark 无 stop()，单连接断不掉 → 一个 bot 一个子进程，由 supervisor 起停（kill）。

启动（由 supervisor 拉起，注入 FEISHU_* 环境变量）：
    FEISHU_BOT_ID=.. FEISHU_APP_ID=.. FEISHU_APP_SECRET=.. FEISHU_OWNER=.. \
      .venv/bin/python -m agent.adapters.feishu
"""
from __future__ import annotations

from collections import OrderedDict

import asyncio
import json
import os
import re
import time
import uuid

import httpx
import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

from app.core import redis as R

STREAM = R.IM_INBOUND_STREAM

_FEISHU_PROCESSED_IDS_MAX = 1000
_FEISHU_STALE_MSG_THRESHOLD_MS = 20_000


# 能被咕咕「读内容」的文本类扩展名（与 chat_attach 同口径）
_TEXT_EXTS = {"md", "txt", "json", "csv", "yaml", "yml", "log", "py", "js", "ts", "tsx",
              "jsx", "vue", "html", "css", "scss", "java", "go", "rs", "c", "cpp", "h",
              "hpp", "sh", "sql", "xml", "toml", "ini", "conf", "env"}


def _download_and_stage(client, message_id: str, owner: str, key: str, rtype: str,
                        fname: str, is_voice: bool) -> tuple[str, str]:
    """下载单个飞书资源（图片/文件/视频共用）→ 转码（语音）→ 暂存。
    返回 (fallback 文本, attach_id)；成功时 fallback 为空串，失败时 attach_id 为空串。"""
    from lark_oapi.api.im.v1 import GetMessageResourceRequest
    from app.core import chat_attach
    if not key:
        noun = "语音" if is_voice else "文件"
        return (f"[用户发来一个{noun}，但没取到资源]", "")
    try:
        req = GetMessageResourceRequest.builder().message_id(message_id).file_key(key).type(rtype).build()
        resp = client.im.v1.message_resource.get(req)
        data = resp.file.read() if (resp.success() and resp.file) else b""
    except Exception as e:
        print(f"[feishu] 下载资源出错: {type(e).__name__}: {e}", flush=True)
        data = b""
    if not data:
        return (f"[用户发来文件《{fname}》，但下载失败]", "")
    name = fname.rsplit(".", 1)[0] if "." in fname else fname
    ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
    duration = None
    if is_voice:
        # opus（mimo 不收）→ ffmpeg 转 mp3；缺 ffmpeg 则原样、退文字提示（resolve 兜底）
        from app.core import media_transcode
        conv = media_transcode.to_mimo_mp3(data, ext or "opus", "audio/ogg")
        if conv is not None:
            data, ext, name = conv, "mp3", "语音"
        duration = media_transcode.probe_duration(data, ext)
    try:
        if is_voice:
            aid = chat_attach.stage_voice_sync(
                owner, name, ext, "audio/mpeg" if ext == "mp3" else None, data,
                duration=duration, platform="feishu").get("attach_id", "")
        else:
            aid = chat_attach.stage_sync(owner, name, ext, None, data, platform="feishu").get("attach_id", "")
    except Exception as e:
        print(f"[feishu] 暂存失败: {type(e).__name__}: {e}", flush=True)
        aid = ""
    if aid:
        return ("", aid)   # 文件卡/语音条/视频条内容由 resolve_for_message 据 attach_id 注入
    if is_voice:
        return ("[用户发来一条语音，但处理失败]", "")
    # 暂存失败兜底：文本类至少把内容塞进文本，让咕咕能读
    if ext in _TEXT_EXTS:
        return (f"[用户发来文件《{fname}》内容：]\n```\n{data.decode('utf-8', 'replace')[:30000]}\n```", "")
    return (f"[用户发来文件《{fname}》，但暂存失败]", "")


def _ingest_media(client, msg, owner: str) -> tuple[str, list]:
    """下载用户发来的图片/文件/语音/视频（单附件消息）→ 暂存 → 返回 (干净 caption, [attach_id])。

    内容/卡片由 run_collect 的 resolve_for_message 据 attach_id 统一处理（和网页上传同一套），
    所以这里 caption 留空、只回 attach_id。暂存失败才退回把内容塞进文本。
    """
    mt = msg.message_type
    try:
        c = json.loads(msg.content) if msg.content else {}
    except Exception:
        c = {}
    if mt == "image":
        key, rtype, fname = c.get("image_key", ""), "image", "图片.jpg"
    elif mt == "audio":
        # 飞书语音是 opus（资源按 file 下）；当「语音消息」处理 → 转 mp3 喂 mimo + 语音条 + 30 天存储
        key, rtype, fname = c.get("file_key", ""), "file", "语音.opus"
    elif mt == "media":
        # 飞书视频消息：file_key 是视频本体，image_key 是封面缩略图（暂不单独取封面）
        key, rtype, fname = c.get("file_key", ""), "file", "视频.mp4"
    else:
        key, rtype, fname = c.get("file_key", ""), "file", (c.get("file_name") or "文件")
    fallback, aid = _download_and_stage(client, msg.message_id, owner, key, rtype, fname, is_voice=(mt == "audio"))
    if aid:
        return ("", [aid])
    return (fallback, [])


def _ingest_post(client, msg, owner: str) -> tuple[str, list]:
    """富文本图文消息（post）：拼接各段落文字，内嵌图片/视频按普通附件下载暂存。"""
    try:
        c = json.loads(msg.content) if msg.content else {}
    except Exception:
        c = {}
    title = (c.get("title") or "").strip()
    rows = c.get("content") or []
    lines: list[str] = []
    media_keys: list[tuple[str, str, str]] = []   # (key, rtype, fname)
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, list):
            continue
        parts: list[str] = []
        for el in row:
            if not isinstance(el, dict):
                continue
            tag = el.get("tag")
            if tag == "text":
                parts.append(el.get("text") or "")
            elif tag == "a":
                parts.append(el.get("text") or el.get("href") or "")
            elif tag == "at":
                parts.append(f"@{el.get('user_name') or el.get('user_id') or ''}")
            elif tag == "img" and el.get("image_key"):
                media_keys.append((el["image_key"], "image", "图片.jpg"))
            elif tag == "media" and el.get("file_key"):
                media_keys.append((el["file_key"], "file", "视频.mp4"))
        if parts:
            lines.append("".join(parts))
    text = "\n".join(lines).strip()
    if title:
        text = f"{title}\n{text}".strip()
    attachments: list = []
    for key, rtype, fname in media_keys:
        fallback, aid = _download_and_stage(client, msg.message_id, owner, key, rtype, fname, is_voice=False)
        if aid:
            attachments.append(aid)
        elif fallback:
            text = f"{text}\n{fallback}".strip()
    return (text, attachments)


def _extract_card_text(content) -> str:
    """从卡片 JSON 里递归拍平抽取可读文字（markdown/text 节点），跳过 table 等非叙述性组件。"""
    parts: list[str] = []

    def _collect(v):
        if isinstance(v, dict):
            if v.get("tag") in ("markdown", "text"):
                parts.append(v.get("content") or v.get("text") or "")
            else:
                for v2 in v.values():
                    _collect(v2)
        elif isinstance(v, list):
            for v2 in v:
                _collect(v2)

    _collect(content.get("elements") if isinstance(content, dict) else content)
    return "\n".join(p for p in parts if p).strip()


def _ingest_interactive(msg) -> str:
    """用户转发一张卡片消息过来：只提取可读文字，不下载卡片内嵌图片（组件结构太杂，暂不处理媒体）。"""
    try:
        c = json.loads(msg.content) if msg.content else {}
    except Exception:
        return "[卡片消息，解析失败]"
    return _extract_card_text(c) or "[卡片消息]"


def _fetch_quoted_text(client, parent_id: str) -> str | None:
    """按 parent_id 反查被引用的原消息文字（同步，供 _on_message 直接调用）。
    非文字类型给占位说明；查询失败返回 None，调用方静默跳过、不阻塞主消息。"""
    from lark_oapi.api.im.v1 import GetMessageRequest
    try:
        req = GetMessageRequest.builder().message_id(parent_id).build()
        resp = client.im.v1.message.get(req)
        if not resp.success() or not resp.data or not resp.data.items:
            return None
        m = resp.data.items[0]
        if m.msg_type == "text":
            try:
                c = json.loads(m.body.content) if (m.body and m.body.content) else {}
            except Exception:
                return "[解析失败]"
            return (c.get("text") or "").strip() or "[空消息]"
        if m.msg_type == "interactive":
            # 咕咕自己发的回复走卡片（见 _do_send 的 _build_card_elements），引用到的大概率是这种——
            # 从卡片 markdown 元素里把文字拼回来（table 组件跳过，不还原成文字，只取叙述性内容）。
            # GetMessage 回来的 elements 是「数组的数组」（分组/分段），不是发送时那种扁平列表，
            # 所以要递归拍平找 markdown 节点，不能只查一层；字段名也被归一化成 {"tag":"text","text":...}。
            try:
                c = json.loads(m.body.content) if (m.body and m.body.content) else {}
            except Exception:
                return "[解析失败]"
            return _extract_card_text(c) or "[空消息]"
        if m.msg_type == "post":
            return "[图文消息]"
        return {"image": "[图片消息]", "file": "[文件消息]", "audio": "[语音消息]", "media": "[视频消息]"}.get(m.msg_type, "[非文字消息]")
    except Exception as e:
        print(f"[feishu] 查引用原消息失败: {type(e).__name__}: {e}", flush=True)
        return None


# ── 接收（网关子进程，凭据/归属从 env 注入）──
def _header_value(data, name: str):
    """兼容 lark SDK 对象和测试 dict，读取事件 header 字段。"""
    header = getattr(data, "header", None)
    if isinstance(header, dict):
        return header.get(name)
    return getattr(header, name, None)


def _drop_misrouted_event(data, expected_app_id: str, channel_id: str) -> bool:
    """丢弃被 lark SDK 错投到当前子进程的其他 app 事件。"""
    event_app_id = _header_value(data, "app_id")
    if event_app_id and expected_app_id and event_app_id != expected_app_id:
        print(f"[feishu:{channel_id}] 丢弃错投事件 app_id={str(event_app_id)[-6:]}", flush=True)
        return True
    return False


def _drop_stale_event(data, channel_id: str, now_ms: int | None = None) -> bool:
    """丢弃飞书 retry 推来的旧消息，避免同一用户收到迟到重复回复。"""
    create_time = _header_value(data, "create_time")
    if not create_time:
        return False
    try:
        create_ms = int(create_time)
    except (TypeError, ValueError):
        return False
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    age_ms = now - create_ms
    if age_ms > _FEISHU_STALE_MSG_THRESHOLD_MS:
        print(f"[feishu:{channel_id}] 丢弃飞书旧 retry age={age_ms / 1000:.1f}s", flush=True)
        return True
    return False


def _seen_message_id(processed: OrderedDict[str, None], message_id: str) -> bool:
    """message_id 进程内 LRU 去重；返回 True 表示已处理过。"""
    mid = (message_id or "").strip()
    if not mid:
        return False
    if mid in processed:
        return True
    processed[mid] = None
    while len(processed) > _FEISHU_PROCESSED_IDS_MAX:
        processed.popitem(last=False)
    return False


def _do_react(client, message_id: str, emoji_type: str) -> bool:
    """给某条消息加表情回应（同步，给 asyncio.to_thread 用）。失败返回 False。"""
    try:
        from lark_oapi.api.im.v1 import (
            CreateMessageReactionRequest, CreateMessageReactionRequestBody, Emoji,
        )
        req = (CreateMessageReactionRequest.builder().message_id(message_id).request_body(
            CreateMessageReactionRequestBody.builder()
            .reaction_type(Emoji.builder().emoji_type(emoji_type).build()).build()).build())
        resp = client.im.v1.message_reaction.create(req)
        if not resp.success():
            print(f"[feishu] reaction 失败: emoji={emoji_type} code={resp.code} msg={resp.msg}", flush=True)
            return False
        return True
    except Exception as e:
        print(f"[feishu] reaction 出错: {type(e).__name__}: {e}", flush=True)
        return False


async def react(channel_id: str, message_id: str, emoji_type: str) -> bool:
    """给飞书某条消息加表情回应（咕咕 react 工具用，按 channel 取凭据）。"""
    if not message_id or not emoji_type:
        return False
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] react {channel_id} 无凭据，跳过", flush=True)
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_react, _clients[channel_id], message_id, emoji_type)


# 「秒回」：网关收到即用关键词快速判一下（纯本地、零网络），赶在 LLM 之前发出短文字 + 表情。
# 每条规则 = (表情, 一组短回话术, 关键词)。按从上到下优先命中；都不中走 _DEFAULT。
# 默认表情用 OnIt(👀「在看」) 而非 THUMBSUP——配合「在看~」更连贯，也避免满屏👍。
import random as _random

_QUICK_RULES = [
    ("LAUGH",    ("哈哈", "草", "笑死了", "哈哈哈"),       ("哈哈", "23333", "笑死", "草", "lol", "hhh", "😂", "🤣")),
    ("THANKS",   ("客气啦~", "嗨这没事", "应该的~"),        ("谢谢", "多谢", "感谢", "辛苦", "thx", "thanks", "🙏")),
    ("DONE",     ("漂亮~", "棒", "搞定收工"),               ("搞定", "完成", "好了", "弄好", "done", "成了", "通过了")),
    ("WOW",      ("哇厉害", "牛啊", "可以的~"),             ("厉害", "牛", "强", "哇", "wow", "卧槽", "666", "绝了")),
    ("CRY",      ("唉别难过", "抱抱", "心疼一下"),           ("难过", "可惜", "唉", "崩溃", "麻了", "心疼", "emo", "😭", "😢")),
    ("PARTY",    ("恭喜恭喜!", "庆祝一下~", "太棒了!"),      ("恭喜", "庆祝", "上线", "发布", "纪念", "🎉")),
    ("OnIt",     ("嗨~", "在呢", "诶到~"),                  ("你好", "在吗", "在不在", "早", "晚上好", "中午好", "hi", "hello")),
    ("THINKING", ("让我想想哈~", "我看看哈", "稍等想一下"),   ("为什么", "怎么", "如何", "?", "？", "吗", "呢", "请问", "能不能", "可不可以")),
]
_DEFAULT = ("OnIt", ("在看~", "收到,马上", "看看哈~", "嗯嗯我瞧瞧"))
_MEDIA_ACK = ("收到,我看看~", "文件到了,瞅瞅", "收到啦~")


def _quick_react(text: str, has_media: bool) -> tuple[str, str]:
    """返回 (秒回短文字, 表情 emoji_type)。纯关键词，零网络，赶在 LLM 之前。"""
    if has_media:
        return _random.choice(_MEDIA_ACK), "OnIt"
    t = (text or "").lower()
    for emoji, acks, kws in _QUICK_RULES:
        if any(k in t for k in kws):
            return _random.choice(acks), emoji
    return _random.choice(_DEFAULT[1]), _DEFAULT[0]


def _make_on_message(channel_id: str, owner: str, api_client, expected_app_id: str = ""):
    processed_message_ids: OrderedDict[str, None] = OrderedDict()

    def _on_message(data: P2ImMessageReceiveV1) -> None:
        if _drop_misrouted_event(data, expected_app_id, channel_id):
            return
        if _drop_stale_event(data, channel_id):
            return
        ev = data.event
        msg = ev.message
        if not msg:
            return
        if _seen_message_id(processed_message_ids, msg.message_id):
            print(f"[feishu:{channel_id}] 丢弃重复消息 message_id={str(msg.message_id)[-8:]}", flush=True)
            return
        mt = msg.message_type
        attachments: list = []
        if mt == "text":
            try:
                text = ((json.loads(msg.content) if msg.content else {}) or {}).get("text", "").strip()
            except Exception:
                text = ""
        elif mt in ("image", "file", "audio", "media"):
            text, attachments = _ingest_media(api_client, msg, owner)
        elif mt == "post":
            text, attachments = _ingest_post(api_client, msg, owner)
        elif mt == "interactive":
            text = _ingest_interactive(msg)
        else:
            return  # 表情/位置/合并转发等暂不处理
        if not text and not attachments:
            return
        open_id = ev.sender.sender_id.open_id if (ev.sender and ev.sender.sender_id) else None
        from agent import trace
        tid = trace.new_trace()

        # 引用消息：用户「回复」某条历史消息时，parent_id 指向那条被引用的消息——飞书只给 id，
        # 要反查一次内容才知道引用的是什么。只包装入队用的文本（llm_text），router/秒回表情继续
        # 用原始 text 判关键词，包一层反而会破坏「算了/还在吗」这类短句匹配。
        llm_text = text
        if msg.parent_id:
            quoted = _fetch_quoted_text(api_client, msg.parent_id)
            if quoted:
                llm_text = f"💬 用户引用/回复了一条历史消息（原文：「{quoted}」），针对这条消息说：\n\n{text}"

        payload = {
            "platform": "feishu",
            "channel_id": channel_id,
            "owner_user_id": owner,      # BYO：bot 即归属
            "platform_user_id": open_id,
            "chat_id": msg.chat_id,
            "chat_type": msg.chat_type,
            "message_id": msg.message_id,
            "text": llm_text,
            "attachments": attachments,
            "trace_id": tid,             # 全链路 trace：worker/工具日志同 id，grep 可串联
        }
        # 隐私：不打印消息原文，只留结构+指纹（见 agent/logsafe.py），同 agent.traj 脱敏口径
        from agent import logsafe
        print(f"[feishu:{channel_id}] 收到 {open_id} @ {msg.chat_id} ({mt}): text_len={len(llm_text)} "
              f"fp={logsafe.fingerprint(llm_text)} att={len(attachments)} quoted={bool(msg.parent_id)} trace={tid}", flush=True)

        # Intent Router：纯文本消息先据当前状态判一手——任务进行中的「还在吗/算了/嗯」由网关
        # 直接处理，不入队（IM 单 worker 顺序消费，忙时它根本看不到队列后面的消息）。带附件一律进主模型。
        if not attachments:
            from agent import router, runtime_state as rtstate
            dec = router.decide(text, rtstate.get_state_sync("feishu", open_id),
                                rtstate.is_awaiting_sync("feishu", open_id))
            if dec["action"] == "drop":
                return
            if dec["action"] in ("reply", "cancel"):
                if dec["action"] == "cancel":
                    rtstate.request_cancel_sync("feishu", open_id)
                try:
                    _do_send(api_client, msg.chat_id, dec["reply"])
                except Exception as e:
                    print(f"[feishu] 短路回复失败: {type(e).__name__}: {e}", flush=True)
                return

        # 秒回表情：赶在入队/生成之前，用关键词快速判一个即时点上（完整回复随后由 worker 发）
        _, emoji = _quick_react(text, bool(attachments))
        _do_react(api_client, msg.message_id, emoji)
        try:
            R.produce_sync(STREAM, payload)
        except Exception as e:
            print(f"[feishu] 入队失败: {type(e).__name__}: {e}", flush=True)
    return _on_message


def serve() -> None:
    app_id = os.environ.get("FEISHU_APP_ID", "")
    app_secret = os.environ.get("FEISHU_APP_SECRET", "")
    channel_id = os.environ.get("FEISHU_BOT_ID", "")
    owner = os.environ.get("FEISHU_OWNER", "")
    if not app_id or not app_secret:
        raise SystemExit("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量（应由 supervisor 注入）。")
    api_client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()   # 下载收到的文件/图片用
    # 表情事件空处理器：咕咕加表情后飞书会回推 reaction.created 事件，不注册的话 lark 每条都报
    # 「processor not found」ERROR 刷屏（看着像断开，其实不是）。注册个 no-op 吞掉即可。
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(_make_on_message(channel_id, owner, api_client, app_id))
        .register_p2_im_message_reaction_created_v1(lambda data: None)
        .register_p2_im_message_reaction_deleted_v1(lambda data: None)
        .build()
    )
    ws_client = lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.INFO)
    print(f"[feishu:{channel_id}] 网关启动（owner={owner}），WebSocket 长连接中…", flush=True)
    ws_client.start()  # 同步阻塞，SDK 自带断线重连


# ── 发送（worker 用，按 bot id 现查 DB 取凭据，缓存 lark.Client）──
_clients: dict = {}


async def _creds_by_id(bot_id: str) -> tuple[str, str]:
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        return (b.app_id, b.app_secret) if b else ("", "")


# ── markdown → 飞书卡片元素 ──────────────────────────────────────────────────
# 飞书卡片的 markdown 元素**不支持 GFM 表格**（| a | b | 会当原文显示），
# 故把表格段解析成飞书**原生 table 组件**，其余文本走 markdown 元素，混排成一张卡。
_TABLE_LINE = re.compile(r"^\s*\|")
_SEP_LINE = re.compile(r"^\s*\|[\s\-:|]+\|\s*$")   # 表格分隔行 |---|:--:|
_EMPH = re.compile(r"[*_]{1,2}(.+?)[*_]{1,2}")     # 去单元格里的 **粗体** 标记
_HEADING = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)


def _md_to_bold(text: str) -> str:
    """飞书 markdown 元素对 # 标题支持不稳，转成粗体。"""
    return _HEADING.sub(r"**\1**", text)


def _split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _parse_md_table(block: list[str]) -> dict | None:
    """GFM 表格行 → 飞书原生 table 组件；不是合法表格返回 None。"""
    lines = [ln for ln in block if ln.strip()]
    if len(lines) < 2:
        return None
    sep_idx = next((i for i, ln in enumerate(lines) if _SEP_LINE.match(ln)), None)
    if not sep_idx:   # None 或 0（表头不能是分隔行）
        return None
    headers = _split_row(lines[0])
    if not headers:
        return None
    keys = [f"col{i}" for i in range(len(headers))]
    aligns = []
    for cell in _split_row(lines[sep_idx]):
        c = cell.strip()
        aligns.append("center" if c.startswith(":") and c.endswith(":")
                      else "right" if c.endswith(":") else "left")
    columns = [{"name": keys[i], "display_name": headers[i], "width": "auto",
                "horizontal_align": aligns[i] if i < len(aligns) else "left"}
               for i in range(len(headers))]
    rows = []
    for ln in lines[sep_idx + 1:]:
        cells = _split_row(ln)
        rows.append({keys[i]: _EMPH.sub(r"\1", cells[i] if i < len(cells) else "")
                     for i in range(len(keys))})
    if not rows:
        return None
    return {"tag": "table", "page_size": min(max(len(rows), 10), 50),
            "columns": columns, "rows": rows}


def _build_card_elements(text: str) -> list[dict]:
    """拆成卡片元素：连续 |…| 段试解析为 table 组件，其余转 markdown 元素。

    第一个 markdown 元素固定挂 `element_id="markdown_1"`，方便后续 element 级 streaming update
    （PUT /open-apis/cardkit/v1/cards/:card_id/elements/markdown_1/content）按 id 增量更新纯文本。
    card 内部 element_id 必须全局唯一（spec 300301），所以只给第一个 markdown 挂。
    """
    lines = text.split("\n")
    elements: list[dict] = []
    md_assigned = False
    i = 0
    while i < len(lines):
        if _TABLE_LINE.match(lines[i]):
            block = []
            while i < len(lines) and _TABLE_LINE.match(lines[i]):
                block.append(lines[i])
                i += 1
            tbl = _parse_md_table(block)
            if tbl:
                elements.append(tbl)
            else:
                md = {"tag": "markdown", "content": _md_to_bold("\n".join(block))}
                if not md_assigned:
                    md["element_id"] = "markdown_1"
                    md_assigned = True
                elements.append(md)
        else:
            block = []
            while i < len(lines) and not _TABLE_LINE.match(lines[i]):
                block.append(lines[i])
                i += 1
            content = "\n".join(block).strip()
            if content:
                md = {"tag": "markdown", "content": _md_to_bold(content)}
                if not md_assigned:
                    md["element_id"] = "markdown_1"
                    md_assigned = True
                elements.append(md)
    if not elements:
        elements = [{"tag": "markdown", "content": _md_to_bold(text), "element_id": "markdown_1"}]
    return elements


def _do_send(client, receive_id: str, text: str) -> bool:
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

    # 按前缀判断收件人类型：ou_=open_id（连接时存的 owner 地址）、oc_=chat_id（消息学到的会话）
    rid_type = "open_id" if str(receive_id).startswith("ou_") else "chat_id"

    def _create(msg_type: str, content: str) -> bool:
        req = (
            CreateMessageRequest.builder()
            .receive_id_type(rid_type)
            .request_body(
                CreateMessageRequestBody.builder()
                .receive_id(receive_id).msg_type(msg_type)
                .content(content)
                .build()
            ).build()
        )
        resp = client.im.v1.message.create(req)
        if not resp.success():
            print(f"[feishu] 发送失败({msg_type}): code={resp.code} msg={resp.msg}", flush=True)
            return False
        return True

    # 优先发交互卡片（markdown 元素渲染粗体/列表/代码，表格走原生 table 组件）；失败回退纯文本
    card = json.dumps({"elements": _build_card_elements(text)}, ensure_ascii=False)
    if _create("interactive", card):
        return True
    return _create("text", json.dumps({"text": text}, ensure_ascii=False))


async def send_text(receive_id: str, text: str, channel_id: str | None = None) -> bool:
    """给指定收件人发文本（chat_id 或 open_id 都行，用该 bot 的凭据）。lark API 同步，丢线程跑。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] user_bot {channel_id} 无凭据，发送跳过", flush=True)
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_send, _clients[channel_id], receive_id, text)


# ── 发送文件/图片（咕咕 send_file 工具 → IM）──────────────────────────────────
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}


def _feishu_file_type(ext: str) -> str:
    if ext in ("pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"):
        return {"docx": "doc", "xlsx": "xls", "pptx": "ppt"}.get(ext, ext)
    if ext in ("ogg", "opus"):
        return "opus"
    if ext == "mp4":
        return "mp4"
    return "stream"


def _do_send_file(client, chat_id: str, data: bytes, name: str, ext: str) -> bool:
    import io
    from lark_oapi.api.im.v1 import (
        CreateImageRequest, CreateImageRequestBody,
        CreateFileRequest, CreateFileRequestBody,
        CreateMessageRequest, CreateMessageRequestBody,
    )
    ext_l = (ext or "").lower()
    fname = f"{name}.{ext_l}" if ext_l else name
    try:
        if ext_l in _IMAGE_EXTS:
            up = client.im.v1.image.create(CreateImageRequest.builder().request_body(
                CreateImageRequestBody.builder().image_type("message").image(io.BytesIO(data)).build()).build())
            if not up.success():
                print(f"[feishu] 图片上传失败: code={up.code} msg={up.msg}", flush=True)
                return False
            msg_type, content = "image", json.dumps({"image_key": up.data.image_key})
        else:
            up = client.im.v1.file.create(CreateFileRequest.builder().request_body(
                CreateFileRequestBody.builder().file_type(_feishu_file_type(ext_l)).file_name(fname)
                .file(io.BytesIO(data)).build()).build())
            if not up.success():
                print(f"[feishu] 文件上传失败: code={up.code} msg={up.msg}", flush=True)
                return False
            msg_type, content = "file", json.dumps({"file_key": up.data.file_key})
        req = (CreateMessageRequest.builder().receive_id_type("chat_id").request_body(
            CreateMessageRequestBody.builder().receive_id(chat_id).msg_type(msg_type).content(content).build()).build())
        resp = client.im.v1.message.create(req)
        if not resp.success():
            print(f"[feishu] 发文件消息失败: code={resp.code} msg={resp.msg}", flush=True)
            return False
        return True
    except Exception as e:
        print(f"[feishu] 发文件出错: {type(e).__name__}: {e}", flush=True)
        return False


async def send_file(chat_id: str, data: bytes, name: str, ext: str, channel_id: str | None = None) -> bool:
    """把文件字节上传到飞书并发到会话（图片走 image、其余走 file）。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_send_file, _clients[channel_id], chat_id, data, name, ext)


# ── 流式回复（飞书 cardkit v1 create/update card，2026-07-09 接入）───────────────
# 流程：
#   1) send_text_stream 收到 token_iter（来自 agent.runner.run_stream）
#   2) 先发一张「咕咕正在想…」占位卡片 → 拿到 card_id
#   3) 每个 token 累加到 accumulated_text；每 ≥200ms 或 ≥30 字 增量 patch 一次
#   4) token_iter 结束 → 用最终 accumulated 调 finish_card（覆盖占位文本为完整回复）
#   5) 任何环节失败 → fallback 普通 send_text，行为退化到非流式体验
#
# 权限：飞书后台要给应用加 cardkit:card:write，否则 create_card 返回非 0；
# 没权限时 fallback 不挡用户主流程，log 一次提示管理员加权限。

# 节流参数（实测值：飞书 cardkit update 接口有 QPS 限制 ~20/s，留余量）
_STREAM_PATCH_INTERVAL_S = 0.2
_STREAM_PATCH_MIN_CHARS = 30


def _make_card_payload(text: str, title: str = "咕咕思考中", color: str = "blue") -> str:
    """构造 CardKit 卡片 2.0 的 data 字段（JSON 字符串）。

    OpenAPI 要求 schema 2.0 的内嵌 card JSON 必须有 schema + header + body 结构：
        {"schema": "2.0", "header": {...}, "body": {"elements": [...]}}
    顶层直接放 elements 会触发 99992402（field validation failed），
    而不带 body 包络时串化整个对象做 form 又会让飞书网关解析成 body is nil。

    config.streaming_mode=true 让服务端启用 typewriter 渲染（飞书 7.20+ 支持，spec
    streaming-updates-openapi-overview）；先开是默认行为，后续流式完了可以关。
    """
    return json.dumps({
        "schema": "2.0",
        "update_multi": True,   # CardKit 流式更新要求 update_multi=true（官方 spec 300302）
        "config": {
            "streaming_mode": True,
            "streaming_config": {
                "print_frequency_ms": {"default": 70, "android": 70, "ios": 70, "pc": 70},
                "print_step": {"default": 1, "android": 1, "ios": 1, "pc": 1},
                "print_strategy": "fast",
            },
            "summary": {"content": ""},   # 占位卡片不显示 summary 旧文
        },
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": color,
        },
        "body": {
            "elements": _build_card_elements(text),
        },
    }, ensure_ascii=False)


# ── 飞书 API 直接走 httpx（绕开 lark SDK Transport 同步/异步两条路径都有 body 丢失 bug）──
# 现象：worker 日志一直报 code=200610 msg=ErrMsg: body is nil；同样的 body 直接 HTTP 调能成功
# （实测 card_id 7660280254204284101）。SDK 的 create()/acreate() 都坏——lark SDK 2.x 的 Transport
# 在 cardkit v1 端点上 body 序列化有 bug。所以 raw httpx 直调 + 自己管 token。

# tenant_access_token 缓存：飞书 token 默认 2h 过期。app_id 维度缓存，提前 60s 过期避免边界问题。
_tenant_token_cache: dict[str, tuple[str, float]] = {}   # app_id -> (token, expire_ts)


async def _get_tenant_token(app_id: str, app_secret: str) -> str:
    now = time.time()
    cached = _tenant_token_cache.get(app_id)
    if cached and cached[1] > now + 60:
        return cached[0]
    async with httpx.AsyncClient(timeout=10.0) as cli:
        resp = await cli.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        )
        data = resp.json()
    token = data.get("tenant_access_token", "")
    if not token or data.get("code", -1) != 0:
        raise RuntimeError(f"飞书 tenant_access_token 获取失败: {data}")
    expire = int(data.get("expire", 7200))
    _tenant_token_cache[app_id] = (token, now + expire)
    return token


async def _do_create_card(app_id: str, app_secret: str, text: str) -> str | None:
    """raw httpx 版 create_card：返回 card_id 或 None。

    已知坑：
      - lark SDK 的 Transport.execute 把 dict body 用 `requests.request(data=...)`（form-encoded）
        发出去，飞书 CardKit 服务端校验 schema 失败返 99992402；包络结构 + data 是 JSON string 又会
        被网关注解成「body is nil」(200610)。SDK 的 create()/acreate()/update() 都不能用。
      - httpx 的 `json=` 自动设 Content-Type 为 application/json（不带 charset），服务端 spec 强制
        `application/json; charset=utf-8`，实测也会触发 200610。必须用 `content=` + 手动设带 charset。
      - 内嵌 card JSON 必须是 schema 2.0 完整结构（schema + header + body.elements），否则
        field validation 失败。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        print(f"[feishu] tenant_token 拿失败: {type(e).__name__}: {e}", flush=True)
        return None
    body = {"type": "card_json", "data": _make_card_payload(text)}
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.post(
                "https://open.feishu.cn/open-apis/cardkit/v1/cards",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        print(f"[feishu] create_card 异常: {type(e).__name__}: {e}", flush=True)
        return None
    if data.get("code") != 0:
        print(f"[feishu] create_card 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return None
    return data.get("data", {}).get("card_id")


async def _do_send_card_message(app_id: str, app_secret: str, receive_id: str,
                                card_id: str) -> bool:
    """把 CardKit card entity 当一条 interactive 消息发出去——这是用户能看到卡片的「桥」步骤。

    仅 create_card 不发，user 端永远看不到；必须 POST /open-apis/im/v1/messages，
    content 是 {"type":"card","data":{"card_id":<card_id>}} 的 JSON-string。

    ⚠ 关键：这里 type 是 "card" 不是 "template"！
    - type="card" + data.card_id = CardKit card entity（我用的，流式更新专用）
    - type="template" + data.template_id = Card Builder GUI 创建的模板（与 API 路线不同）
    之前这里误写成 template 卡 ID 被飞书当 template_id 找，返 200380 "template does not exist"。

    card entity 只能 send 一次（官方 spec "A card entity can only be sent once"），后续靠
    _do_update_card（或 element 级别 streaming update endpoint）改内容。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        print(f"[feishu] tenant_token 拿失败: {type(e).__name__}: {e}", flush=True)
        return False
    rid_type = "open_id" if str(receive_id).startswith("ou_") else "chat_id"
    body = {
        "receive_id": receive_id,
        "msg_type": "interactive",
        "content": json.dumps({"type": "card", "data": {"card_id": card_id}}, ensure_ascii=False),
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.post(
                f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={rid_type}",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        print(f"[feishu] send_card_message 异常: {type(e).__name__}: {e}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] send_card_message 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True


_card_seq: dict[str, int] = {}   # card_id -> 当前最大 sequence（同进程内防乱序；跨进程由各 worker 自管）


# Element 级 streaming text update 用的固定 element_id（_build_card_elements 给第一个 markdown 元素挂的）
_STREAM_TARGET_ELEMENT_ID = "markdown_1"


async def _do_streaming_update_text(app_id: str, app_secret: str, card_id: str,
                                     content: str, sequence: int, uuid: str) -> bool:
    """element 级别流式更新（PUT /open-apis/cardkit/v1/cards/{cid}/elements/{eid}/content）。

    这是飞书官方的「Streaming Update Text」接口，比整卡 PUT 更轻——服务端自动增量渲染
    typewriter 效果（spec streaming-updates-openapi-overview / 300310 等；要求 card config 中
    streaming_mode=true + element_id 存在 + sequence 单调递增 + uuid 唯一避免冲突）。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        print(f"[feishu] tenant_token 拿失败: {type(e).__name__}: {e}", flush=True)
        return False
    body = {"content": content, "sequence": sequence, "uuid": uuid}
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.request(
                "PUT",
                f"https://open.feishu.cn/open-apis/cardkit/v1/cards/{card_id}/elements/{_STREAM_TARGET_ELEMENT_ID}/content",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        print(f"[feishu] streaming_update_text 异常: {type(e).__name__}: {e}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] streaming_update_text 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True


async def _do_finalize_streaming_card(app_id: str, app_secret: str, card_id: str,
                                      summary_text: str, sequence: int, uuid: str) -> bool:
    """关闭 CardKit streaming_mode，并设置会话列表 summary。

    这是纯收尾动作：失败不影响用户已经看到的最终卡片正文。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        print(f"[feishu] tenant_token 拿失败: {type(e).__name__}: {e}", flush=True)
        return False
    preview = (summary_text or "").strip()
    if len(preview) > 80:
        preview = preview[:77] + "..."
    if not preview:
        preview = "✅"
    settings = {
        "config": {
            "streaming_mode": False,
            "summary": {"content": preview},
        },
    }
    body = {
        "settings": json.dumps(settings, ensure_ascii=False),
        "sequence": sequence,
        "uuid": uuid,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.request(
                "PATCH",
                f"https://open.feishu.cn/open-apis/cardkit/v1/cards/{card_id}/settings",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        print(f"[feishu] finalize_streaming_card 异常: {type(e).__name__}: {e}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] finalize_streaming_card 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True


async def _do_update_card(app_id: str, app_secret: str, card_id: str, text: str) -> bool:
    """raw httpx 版 update_card：节流策略由 caller 控制（每 ≥200ms 或 ≥30 字调一次）。

    HTTP method 是 **PUT**——SDK update() 签名的也是 PUT（cardkit/v1/model/update_card_request
    源码：update_card_request.http_method = HttpMethod.PUT）。
    sequence 必须严格递增（int 类型，从 1 开始）——之前踩坑：timestamp 形式被服务端判为
    非法参数类型返 9499。同进程用模块级 dict 跨调用递增，多 worker 进程各自从 1 计起互不冲突
    （飞书服务端按 card_id 维度判 sequence 单调，不要求跨进程全局连续）。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        print(f"[feishu] tenant_token 拿失败: {type(e).__name__}: {e}", flush=True)
        return False
    _card_seq[card_id] = _card_seq.get(card_id, 0) + 1
    body = {
        "card": {
            "type": "card_json",
            "data": _make_card_payload(text),
        },
        "sequence": _card_seq[card_id],
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.request(
                "PUT",
                f"https://open.feishu.cn/open-apis/cardkit/v1/cards/{card_id}",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        print(f"[feishu] update_card 异常: {type(e).__name__}: {e}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] update_card 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True


async def send_text_stream(receive_id: str, token_iter, channel_id: str | None = None,
                          placeholder: str = "咕咕正在想…") -> tuple[bool, "AgentResponse | None"]:
    """飞书流式回复（IM 端模拟 SSE）。

    Args:
        receive_id: chat_id（oc_xxx）或 open_id（ou_xxx）
        token_iter: async iterator，yield ("token", str) / ("final", AgentResponse)（agent.runner.run_stream）
        channel_id: user_bot.id
        placeholder: 占位卡片首屏文案

    Returns: (ok, final_response)——ok 表示流式/fallback 是否成功；final_response 是 run_stream
    yield 的 AgentResponse（含 session_id），消费端需要它来续写 Redis 会话映射。如果 token_iter
    没 yield final（异常退出等），final_response 为 None。
    """
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] user_bot {channel_id} 无凭据，流式回复跳过", flush=True)
        return (False, None)
    # 之前的 lark.Client 缓存不再使用——card API 直走 httpx（绕 SDK bug）。
    # _clients 仍保留供 send_text / react / send_file 等其他路径继续用 SDK。

    # 1) 创建占位卡片
    card_id = await _do_create_card(app_id, app_secret, placeholder)
    if not card_id:
        # 权限不够 / 接口失败 → fallback 普通 send_text（攒完 token 后一次性发）
        print(f"[feishu] 流式 fallback：create_card 失败，改走普通 send_text", flush=True)
        accumulated = ""
        final_resp = None
        async for kind, payload in token_iter:
            if kind == "token":
                accumulated += payload
            elif kind == "final":
                final_resp = payload
                final_text = (payload.text or accumulated).strip()
                if final_text:
                    ok = await send_text(receive_id, final_text, channel_id)
                    return (ok, final_resp)
                return (False, final_resp)
        return (False, final_resp)

    # 2) 把 card_id 当一条 interactive 消息发出去——不 send，user 端永远看不到。
    # card entity 官方约束：只能 send 一次（spec 200305），所以后续靠 update_card 改内容。
    if not await _do_send_card_message(app_id, app_secret, receive_id, card_id):
        print(f"[feishu] 流式 fallback：send_card_message 失败，退到普通 send_text", flush=True)
        accumulated = ""
        final_resp = None
        async for kind, payload in token_iter:
            if kind == "token":
                accumulated += payload
            elif kind == "final":
                final_resp = payload
                final_text = (payload.text or accumulated).strip()
                if final_text:
                    ok = await send_text(receive_id, final_text, channel_id)
                    return (ok, final_resp)
                return (False, final_resp)
        return (False, final_resp)

    # 3) 初始化 element 级流式更新的 sequence（sequence 从 1 开始严格递增）
    stream_seq = 0

    _stream_seq_key = f"{card_id}:stream"

    async def _patch(text: str) -> bool:
        """element 级别 streaming update 本地计数器 + 调用。

        uuid 是幂等键——飞书 spec 200770 同 UUID 只生效一次，所以每次 patch 都需要新 UUID。
        """
        _card_seq[_stream_seq_key] = _card_seq.get(_stream_seq_key, 0) + 1
        try:
            return await _do_streaming_update_text(app_id, app_secret, card_id, text,
                                                   sequence=_card_seq[_stream_seq_key],
                                                   uuid=uuid.uuid4().hex)
        except Exception as e:
            print(f"[feishu] streaming_update_text 异常: {type(e).__name__}: {e}", flush=True)
            return False

    # 4) 流式消费 token + 节流 patch（element 级接口，服务端自动增量渲染）
    accumulated = ""
    last_patch_ts = time.monotonic()
    last_patched_len = 0
    pending_final_text: str | None = None
    final_resp = None
    stream_ok = True
    try:
        async for kind, payload in token_iter:
            if kind == "token":
                accumulated += payload
                now = time.monotonic()
                # 节流：时间 OR 长度任一满足就 patch（保证短响应也能及时显示）
                if (now - last_patch_ts >= _STREAM_PATCH_INTERVAL_S
                        or len(accumulated) - last_patched_len >= _STREAM_PATCH_MIN_CHARS):
                    if stream_ok:
                        stream_ok = await _patch(accumulated)
                    last_patch_ts = now
                    last_patched_len = len(accumulated)
            elif kind == "final":
                # final AgentResponse：text 可能比 accumulated 多（出口兜底 sanitize_outbound/strip_disallowed_emoji
                # 在 runner 末尾做过清洗，最终版更准）；如果不同就以 final.text 为准再 patch 一次
                final_resp = payload
                if payload.cancelled:
                    # 用户中途取消 → 卡片保留 partial 内容（不清空，避免给用户错觉"什么都没了"）
                    break
                pending_final_text = (payload.text or accumulated).strip()
                break
    except Exception as e:
        print(f"[feishu] 流式消费异常: {type(e).__name__}: {e}", flush=True)

    # 5) 收尾：把最终版（final.text 优先；如果 final 没拿到就用 accumulated）patch 进卡片
    final_text = pending_final_text or accumulated
    if stream_ok and final_text and final_text != accumulated:
        stream_ok = await _patch(final_text)
    elif stream_ok and final_text:
        # 已 patch 过同文本 → 不用再 patch，但仍显式结束一下（飞书端 streaming update 幂等）
        stream_ok = await _patch(final_text)
    if stream_ok:
        _card_seq[_stream_seq_key] = _card_seq.get(_stream_seq_key, 0) + 1
        finalized = await _do_finalize_streaming_card(
            app_id, app_secret, card_id, final_text,
            sequence=_card_seq[_stream_seq_key], uuid=uuid.uuid4().hex)
        if not finalized:
            print(f"[feishu] finalize_streaming_card 失败但保留已更新卡片: card_id={card_id}", flush=True)
    return (stream_ok, final_resp)


if __name__ == "__main__":
    serve()
