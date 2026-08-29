"""飞书网关：WebSocket 长连接收消息 → 规范化 → 入队 im:inbound（BYO 每用户自带 app）。

不需要公网 URL（lark-oapi WebSocket 长连）。与 QQ 同 BYO 模型：每个用户在「个人设置 →
接入咕咕 → 飞书」用 device flow 扫码创建自己的飞书 app（存 user_bots 表），gateway 为每个
启用的 user_bot 起一条本网关子进程，凭据走**环境变量注入**。bot 收到的消息天然归属其 owner，
入队 payload 带 owner_user_id，worker 无需再做绑定。

lark 的 `ws.Client.start()` 同步阻塞、事件 handler 同步，故用 `produce_sync` 入队。
lark 无 stop()，单连接断不掉 → 一个 bot 一个子进程，由 gateway 起停（kill）。

启动（由 gateway 拉起，注入 FEISHU_* 环境变量）：
    FEISHU_BOT_ID=.. FEISHU_APP_ID=.. FEISHU_APP_SECRET=.. FEISHU_OWNER=.. \
      .venv/bin/python -m agent.gateway.feishu
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

from app.core import redis as R
from app.core.redaction import diag_log, diag_log_raw, redact

STREAM = R.IM_INBOUND_STREAM

_FEISHU_STALE_MSG_THRESHOLD_MS = 20_000


from agent.im.media_ingress_feishu import (
    download_and_stage as _download_and_stage,
    ingest_media as _ingest_media_impl,
    ingest_post as _ingest_post_impl,
)


def _ingest_media(client, msg, owner: str) -> tuple[str, list]:
    return _ingest_media_impl(client, msg, owner, _download_and_stage)


def _ingest_post(client, msg, owner: str) -> tuple[str, list]:
    return _ingest_post_impl(client, msg, owner, _download_and_stage)


def _extract_card_text(content) -> str:
    """从卡片 JSON 里递归拍平抽取可读文字（markdown/text 节点），跳过 table 等非叙述性组件。

    直接从整个 content 开始递归，不假设 elements 在哪一层——旧版非流式卡片是扁平的
    `{"elements": [...]}`，咕咕现在的流式卡片是 CardKit schema 2.0 的
    `{"schema": "2.0", "body": {"elements": [...]}}`，elements 嵌在 body 里一层。
    之前只从 `content["elements"]` 起步，流式卡片这层结构对不上，导致引用咕咕自己的
    流式回复时永远抽出空文本（[空消息]）。递归整个 content 两种结构都能兼容。
    """
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

    _collect(content)
    return "\n".join(p for p in parts if p).strip()


def _ingest_interactive(msg) -> str:
    """用户转发一张卡片消息过来：只提取可读文字，不下载卡片内嵌图片（组件结构太杂，暂不处理媒体）。"""
    try:
        c = json.loads(msg.content) if msg.content else {}
    except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
        return "[卡片消息，解析失败]"
    return _extract_card_text(c) or "[卡片消息]"


def _fetch_quoted_text(client, parent_id: str) -> str | None:
    """按 parent_id 反查被引用的原消息文字（同步，供 _on_message 直接调用）。
    非文字类型给占位说明；查询失败返回 None，调用方静默跳过、不阻塞主消息。"""
    from lark_oapi.api.im.v1 import GetMessageRequest
    try:
        # card_msg_content_type=user_card_content：不传这个参数时，飞书对 CardKit 动态卡片
        # （引用 card_id 而非内联 elements，咕咕的流式回复卡片就是这种）返回的是一段兼容性占位
        # 文案「请升级至最新版本客户端，以查看内容」，不是卡片真实内容——QwenPaw 同款反查逻辑
        # 也带了这个参数，实测确认是这个字段控制的。
        req = (GetMessageRequest.builder().message_id(parent_id)
              .card_msg_content_type("user_card_content").build())
        resp = client.im.v1.message.get(req)
        if not resp.success() or not resp.data or not resp.data.items:
            return None
        m = resp.data.items[0]
        if m.msg_type == "text":
            try:
                c = json.loads(m.body.content) if (m.body and m.body.content) else {}
            except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
                return "[解析失败]"
            return (c.get("text") or "").strip() or "[空消息]"
        if m.msg_type == "interactive":
            # 咕咕自己发的回复走卡片（见 _do_send 的 _build_card_elements），引用到的大概率是这种——
            # 从卡片 markdown 元素里把文字拼回来（table 组件跳过，不还原成文字，只取叙述性内容）。
            # GetMessage 回来的 elements 是「数组的数组」（分组/分段），不是发送时那种扁平列表，
            # 所以要递归拍平找 markdown 节点，不能只查一层；字段名也被归一化成 {"tag":"text","text":...}。
            try:
                c = json.loads(m.body.content) if (m.body and m.body.content) else {}
            except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
                return "[解析失败]"
            return _extract_card_text(c) or "[空消息]"
        if m.msg_type == "post":
            return "[图文消息]"
        return {"image": "[图片消息]", "file": "[文件消息]", "audio": "[语音消息]", "media": "[视频消息]"}.get(m.msg_type, "[非文字消息]")
    except Exception as e:
        diag_log("agent.gateway.feishu.fetch_quoted_text", e)   # 原始 → 受限诊断出口
        print(f"[feishu] 查引用原消息失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
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


async def _consume_card_action(owner: str, prompt_id: int, token: str,
                               event_id: str | None) -> dict:
    """在飞书回调协程中消费统一 Prompt Action。"""
    from uuid import UUID
    from app.db import session as db_session
    from app.services.interactions import consume_action

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        raise RuntimeError("数据库不可用")
    async with db_session._SessionLocal() as db:
        return await consume_action(
            db,
            user_id=UUID(str(owner)),
            prompt_id=prompt_id,
            token=token,
            event_id=event_id,
        )


def _handle_card_action(data, owner: str):
    """处理飞书 card.action.trigger；在 SDK 当前 event loop 调度消费任务。"""
    from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTriggerResponse
    from agent.interactions.feishu import decode_action_value, build_completed_card_payload

    event = getattr(data, "event", None)
    action = getattr(event, "action", None)
    value = getattr(action, "value", None) if action is not None else None
    completed_card = None
    try:
        prompt_id, token = decode_action_value(value)
        header = getattr(data, "header", None)
        event_id = getattr(header, "event_id", None)
        coroutine = _consume_card_action(owner, prompt_id, token, event_id)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 仅供离线测试或非 SDK 调用路径；正式 WebSocket 回调总有运行中的 loop。
            asyncio.run(coroutine)
            message = "已选择，继续处理。"
        else:
            task = loop.create_task(coroutine)

            def _report_card_action_failure(done_task) -> None:
                try:
                    done_task.result()
                except Exception as exc:
                    diag_log("agent.gateway.feishu.interaction", exc)

            task.add_done_callback(_report_card_action_failure)
            message = "已收到选择，继续处理。"
        completed_card = build_completed_card_payload(message)
    except (LookupError, ValueError):
        message = "这个选项已过期或已经处理过了。"
    except Exception as exc:
        diag_log("agent.gateway.feishu.interaction", exc)
        message = "暂时无法处理这个选项，请回复选项文字。"
    response = {"toast": {"type": "info", "content": message}}
    if completed_card is not None:
        # 飞书回调允许返回新的 raw card。用无按钮状态卡替换原卡，避免重复点击；
        # 真正的幂等性仍由服务端一次性 action token 保证。
        response["card"] = {"type": "raw", "data": completed_card}
    return P2CardActionTriggerResponse(response)


def _feishu_mentions_current_bot(message, open_id: str | None) -> bool:
    """从飞书 at 节点确认是否指向当前 bot；没有结构化节点时不猜测。"""
    if not open_id:
        return False
    mentions = getattr(message, "mentions", None) or []
    if not isinstance(mentions, list):
        return False
    for item in mentions:
        value = item.get("id") if isinstance(item, dict) else getattr(item, "id", None)
        candidate = value.get("open_id") if isinstance(value, dict) else getattr(value, "open_id", None)
        if candidate == open_id or value == open_id:
            return True
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
        diag_log("agent.gateway.feishu.reaction", e)   # 原始 → 受限诊断出口
        print(f"[feishu] reaction 出错: {redact(f'{type(e).__name__}: {e}')}", flush=True)
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


def _make_on_message(channel_id: str, owner: str, api_client, expected_app_id: str = ""):
    def _on_message(data: P2ImMessageReceiveV1) -> None:
        if _drop_misrouted_event(data, expected_app_id, channel_id):
            return
        if _drop_stale_event(data, channel_id):
            return
        ev = data.event
        msg = ev.message
        if not msg:
            return
        mt = msg.message_type
        attachments: list = []
        if mt == "text":
            try:
                text = ((json.loads(msg.content) if msg.content else {}) or {}).get("text", "").strip()
            except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
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
        from agent.runtime import trace
        tid = trace.new_trace()

        # 引用消息：用户「回复」某条历史消息时，parent_id 指向那条被引用的消息——飞书只给 id，
        # 要反查一次内容才知道引用的是什么。引用原文单独存 quoted_text，不拼进 text——
        # runner.py 只把它喂给模型当上下文，ConversationMessage.content/网页展示仍是用户
        # 自己打的话，router/秒回表情继续用原始 text 判关键词（同一份），别再把引用原文拼进
        # 正文（网页气泡纯文本渲染，拼进去会把引用的 markdown 原样摊平显示得很难看，见 devlog
        # 2026-07-10）。
        quoted_text = _fetch_quoted_text(api_client, msg.parent_id) if msg.parent_id else None

        payload = {
            "platform": "feishu",
            "channel_id": channel_id,
            "owner_user_id": owner,      # BYO：bot 即归属
            "platform_user_id": open_id,
            "chat_id": msg.chat_id,
            "chat_type": msg.chat_type,
            "message_id": msg.message_id,
            "text": text,
            "quoted_text": quoted_text,
            "attachments": attachments,
            "trace_id": tid,             # 全链路 trace：worker/工具日志同 id，grep 可串联
        }
        # 飞书 SDK 版本可能把 at 节点解析到 mentions，也可能已将其从 text 中移除。
        # 只把明确指向当前 bot 的 mention 标为 True，不根据可见 @ 文本猜测。
        payload["bot_mentioned"] = _feishu_mentions_current_bot(msg, open_id)
        # 隐私：不打印消息原文，只留结构+指纹（见 agent/logsafe.py），同 agent.traj 脱敏口径
        from agent.security import logsafe
        print(f"[feishu:{channel_id}] 收到 {open_id} @ {msg.chat_id} ({mt}): text_len={len(text)} "
              f"fp={logsafe.fingerprint(text)} att={len(attachments)} quoted={bool(msg.parent_id)} trace={tid}", flush=True)

        # 秒回表情：赶在入队/生成之前，用关键词快速判一个即时点上（完整回复随后由 worker 发）
        from agent.im.loop import choose_instant_reaction
        _, emoji = choose_instant_reaction(text, bool(attachments))
        _do_react(api_client, msg.message_id, emoji)
        # 取消是实时控制信号：必须在 Gateway 侧立刻写入 Redis；其他 shortcut 继续入队，
        # 由 worker 的 IM Loop 统一处理，避免 Gateway 再承担业务回复编排。
        if not attachments:
            from agent.im.loop import apply_im_shortcut_cancel_sync, decide_im_shortcut_sync
            dec = decide_im_shortcut_sync(
                "feishu", open_id, text,
                bot_id=channel_id,
                scope_id=msg.chat_id or open_id,
            )
            if dec["action"] == "cancel":
                apply_im_shortcut_cancel_sync(
                    "feishu", open_id, dec,
                    bot_id=channel_id,
                    scope_id=msg.chat_id or open_id,
                )
                try:
                    _do_send(api_client, msg.chat_id, dec["reply"])
                except Exception as e:
                    diag_log("agent.gateway.feishu.cancel_reply", e)
                    print(f"[feishu] 取消回复失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
                return
            if dec["action"] == "no_permission":
                # 咕咕在跑别人的 loop，当前用户无权取消：回一句提示，不入队。
                try:
                    _do_send(api_client, msg.chat_id, dec["reply"])
                except Exception as e:
                    diag_log("agent.gateway.feishu.no_permission_reply", e)
                    print(f"[feishu] 无权取消回复失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
                return
        try:
            from agent.im.models import normalize_payload
            payload = normalize_payload(payload)
            R.produce_sync(STREAM, payload)
        except Exception as e:
            diag_log("agent.gateway.feishu.enqueue", e)   # 原始 → 受限诊断出口
            print(f"[feishu] 入队失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
    return _on_message


def serve() -> None:
    app_id = os.environ.get("FEISHU_APP_ID", "")
    app_secret = os.environ.get("FEISHU_APP_SECRET", "")
    channel_id = os.environ.get("FEISHU_BOT_ID", "")
    owner = os.environ.get("FEISHU_OWNER", "")
    if not app_id or not app_secret:
        raise SystemExit("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量（应由 gateway 注入）。")
    api_client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()   # 下载收到的文件/图片用
    # 表情事件空处理器：咕咕加表情后飞书会回推 reaction.created 事件，不注册的话 lark 每条都报
    # 「processor not found」ERROR 刷屏（看着像断开，其实不是）。注册个 no-op 吞掉即可。
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(_make_on_message(channel_id, owner, api_client, app_id))
        .register_p2_card_action_trigger(lambda data: _handle_card_action(data, owner))
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


def _do_send_interaction_card(client, receive_id: str, prompt: dict) -> bool:
    """发送带按钮的 Prompt 卡片；失败由调用方退回文本选项。"""
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
    from agent.interactions.feishu import build_card_payload

    rid_type = "open_id" if str(receive_id).startswith("ou_") else "chat_id"
    content = json.dumps(build_card_payload(prompt), ensure_ascii=False)
    req = (
        CreateMessageRequest.builder()
        .receive_id_type(rid_type)
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type("interactive")
            .content(content)
            .build()
        ).build()
    )
    resp = client.im.v1.message.create(req)
    if not resp.success():
        print(f"[feishu] 交互卡片发送失败: code={resp.code} msg={resp.msg}", flush=True)
        return False
    return True


async def send_text(receive_id: str, text: str, channel_id: str | None = None) -> bool:
    """给指定收件人发文本（chat_id 或 open_id 都行，用该 bot 的凭据）。lark API 同步，丢线程跑。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] user_bot {channel_id} 无凭据，发送跳过", flush=True)
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_send, _clients[channel_id], receive_id, text)


async def send_interaction_card(receive_id: str, prompt: dict,
                                channel_id: str | None = None) -> bool:
    """发送飞书原生交互卡片。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id or not receive_id:
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    try:
        return await asyncio.to_thread(
            _do_send_interaction_card, _clients[channel_id], receive_id, prompt
        )
    except Exception as e:
        diag_log("agent.gateway.feishu.send_interaction_card", e)
        print(f"[feishu] 交互卡片发送异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False


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
        diag_log("agent.gateway.feishu.send_file", e)   # 原始 → 受限诊断出口
        print(f"[feishu] 发文件出错: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False


async def send_file(chat_id: str, data: bytes, name: str, ext: str, channel_id: str | None = None) -> bool:
    """把文件字节上传到飞书并发到会话（图片走 image、其余走 file）。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_send_file, _clients[channel_id], chat_id, data, name, ext)


if __name__ == "__main__":
    from app.core.logging import setup_process_output
    setup_process_output()
    serve()
