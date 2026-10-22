"""QQ C2C/群消息、流式回复、Keyboard 与文件发送。"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from contextlib import suppress
from typing import Any, Dict

from app.core import redis as R
from app.core.redaction import diag_log, redact
from .text import complete_qq_lines, prepare_qq_text, prepare_qq_link_buttons
from agent.im.message_format import message_type as _message_type
from .client import (
    QQAPIError,
    QQStreamFinalizationError,
    QQStreamDeliveryError,
    _qq_error_summary,
    _qq_is_transient,
    _qq_request,
    _send_tokens,
)

_log = logging.getLogger("agent.gateway.qq")

_stream_seq_fallback = 0

async def _next_seq(msg_id: str | None) -> int:
    if not msg_id:
        return 1
    try:
        k = f"qqseq:{msg_id}"
        n = await R.get_redis().incr(k)
        if n == 1:
            await R.get_redis().expire(k, 600)   # 比 5min 被动窗口稍长
        return n
    except Exception:
        import time as _t
        return int(_t.time() * 1000) % 1_000_000   # Redis 挂了退回时间戳尾数

async def _next_stream_seq(channel_id: str) -> int:
    """为每个 QQ 官方流会话生成新的 msg_seq，避免跨回复撞序列。"""
    global _stream_seq_fallback
    try:
        redis = R.get_redis()
        key = f"qqstreamseq:{channel_id}"
        value = await redis.incr(key)
        if value == 1:
            await redis.expire(key, 600)
        return int(value)
    except Exception:
        _stream_seq_fallback = max(_stream_seq_fallback + 1, int(time.time() * 1000))
        return _stream_seq_fallback

class QQPrivateTextStream:
    """QQ C2C `stream_messages` 的全文替换发送器。

    push() 只累计文本并安排节流刷新；HTTP 请求在一个串行链中执行，后续帧在
    真正出队时读取首帧返回的 stream_msg_id，避免并发请求缺少关联 ID。
    """

    def __init__(self, channel_id: str, openid: str, *, message_id: str | None):
        self.channel_id = channel_id
        self.openid = openid
        self.message_id = message_id
        # C2C 流式消息只用于 Markdown 私聊模式。
        self.content_type = "markdown"
        self.msg_seq: int | None = None
        self.full_text = ""
        self.last_sent_text = ""
        self.last_sent_content = ""
        self.stream_msg_id: str | None = None
        self.frame_index = 0
        self.sent_frame_count = 0
        self.finished = False
        self.error: Exception | None = None
        self._flush_interval = 0.5
        self._timer: asyncio.Task | None = None
        self._chain: asyncio.Task | None = None

    def push(self, delta: str) -> None:
        if not delta or self.finished or self.error:
            return
        self.full_text += delta
        # Mermaid fence 前可能先到换行/空格；空白不能单独启动流消息，
        # 否则它会在图表前被切段，且无法发送可见的 DONE 帧。
        if not self.full_text.strip():
            return
        if self._timer is None:
            self._timer = asyncio.create_task(self._delayed_flush())

    async def _delayed_flush(self) -> None:
        try:
            await asyncio.sleep(self._flush_interval)
            # finish() 会取消这个节流任务，但不能连带取消已经开始的 HTTP
            # 刷新链；否则收尾时的 DONE 帧可能永远发不出去，客户端会一直显示生成中。
            await asyncio.shield(self._flush())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.error = exc
        finally:
            self._timer = None

    async def _flush(self, input_state: int = 1, *, content_override: str | None = None) -> None:
        if self.error is not None:
            raise self.error
        if not self.full_text or (input_state != 10 and self.full_text == self.last_sent_text):
            return
        previous = self._chain

        async def send_one() -> None:
            if previous is not None:
                await previous
            frame = self._prepare_frame_text(input_state, content_override)
            if frame is None:
                return
            sent_text, content = frame
            if self.msg_seq is None:
                # QQ 在流式与普通消息接口间共同按 msg_id + msg_seq 去重。
                # 关联入站消息时共享文字/图片计数；同一条流的后续帧仍复用该序号。
                if self.message_id:
                    self.msg_seq = await _next_seq(self.message_id)
                else:
                    self.msg_seq = await _next_stream_seq(self.channel_id)
            body = {
                "input_mode": "replace",
                "input_state": input_state,
                "content_type": self.content_type,
                "content_raw": content,
                "msg_seq": self.msg_seq,
                "index": self.frame_index,
            }
            if self.message_id:
                body.update({"msg_id": self.message_id, "event_id": self.message_id})
            if self.stream_msg_id:
                body["stream_msg_id"] = self.stream_msg_id
            retries = 0
            while True:
                try:
                    result = await _qq_request(
                        self.channel_id,
                        "POST",
                        f"/v2/users/{self.openid}/stream_messages",
                        json_body=body,
                    )
                    self._record_sent_frame(result, sent_text, body, original_content=content_override is None)
                    # 只有收到 QQ 对该分片的成功响应后才推进序号。失败重试和后续
                    # DONE 都复用这个序号，避免未确认的帧造成 index 跳号。
                    self.frame_index += 1
                    return
                except Exception as exc:
                    error_code = None
                    if isinstance(exc, QQAPIError) and isinstance(exc.body, dict):
                        error_code = str(exc.body.get("code") or exc.body.get("err_code") or "")
                    rate_limited = (
                        error_code == "50002"
                        or isinstance(exc, QQAPIError) and exc.status == 429
                    )
                    # 首帧超时是结果不确定：服务端可能已创建流，但响应里的
                    # stream_msg_id 丢失。此时重发可能再开一条流，不能盲目重试。
                    # 已拿到 stream_msg_id 后，才对网络/5xx 瞬时错误重放同一分片。
                    transport_retryable = (
                        self.stream_msg_id is not None and _qq_is_transient(exc)
                    )
                    retryable = (
                        rate_limited
                        or error_code == "50001"
                        or transport_retryable
                    )
                    if not retryable or retries >= 3:
                        raise
                    if rate_limited:
                        # 官方建议降低频率；本条请求退避后，也放慢后续增量刷新。
                        self._flush_interval = min(max(self._flush_interval, 1.0), 2.0)
                        delay = min(1.0 * (2 ** retries), 4.0)
                    else:
                        delay = min(0.5 * (2 ** retries), 2.0)
                    await asyncio.sleep(delay)
                    retries += 1

        task = asyncio.create_task(send_one())
        self._chain = task
        try:
            await task
        except Exception as exc:
            self.error = exc
            raise

    def _prepare_frame_text(self, input_state: int, override: str | None) -> tuple[str, str] | None:
        """只生成稳定的追加正文；读取排队后的最新状态，不提前确认缓冲尾行。"""
        raw = self.full_text if self.finished or input_state == 10 else complete_qq_lines(self.full_text)
        content = override if override is not None else prepare_qq_text(raw)
        if not content.strip() or (input_state != 10 and content == self.last_sent_content):
            return None
        if not content.startswith(self.last_sent_content):
            raise ValueError("QQ 流式正文改写已发送前缀，已阻止出站")
        return raw, content

    async def finish(self, final_text: str) -> None:
        self.finished = True
        if self._timer is not None:
            self._timer.cancel()
            with suppress(asyncio.CancelledError):
                await self._timer
            self._timer = None
        # Mermaid 分段结束会去掉尾部留白；已发出的换行属于不可修改前缀，收尾保留原样。
        final_text = final_text or self.full_text
        if self.full_text.startswith(final_text) and not self.full_text[len(final_text):].strip():
            final_text = self.full_text
        self.full_text = final_text
        if not self.full_text.strip():
            return
        try:
            await self._flush(1)
            if self._chain is not None:
                await self._chain
        except Exception as exc:
            if not self.stream_msg_id:
                raise
            # 已创建的流即使中间刷新失败，也要尝试用完整正文发送 DONE。
            # 失败的串行任务不能继续挂在链头，否则关闭帧还未请求就会再次抛错。
            diag_log("agent.gateway.qq.stream_update_before_finish", exc)
            self.error = None
            self._chain = None
        try:
            await self._flush(10)
        except Exception as exc:
            await self._close_rejected_content(exc)
        if self._chain is not None:
            await self._chain

    def _record_sent_frame(self, result: Any, text: str, body: dict, *, original_content: bool) -> None:
        """分开记录原始分片与实际送达正文；关闭受拒内容不能冒充原文已送达。"""
        self.sent_frame_count += 1
        if not self.stream_msg_id and isinstance(result, dict):
            candidate = result.get("stream_msg_id") or result.get("id")
            if isinstance(candidate, str) and candidate:
                self.stream_msg_id = candidate
        if original_content:
            self.last_sent_text = text
        self.last_sent_content = body["content_raw"]

    async def _close_rejected_content(self, error: Exception) -> None:
        """内容被拒后只关闭已送达正文，失败状态始终交给调用方处理。"""
        body = error.body if isinstance(error, QQAPIError) else None
        rejected = isinstance(body, dict) and str(body.get("code") or body.get("err_code")) == "40034028"
        if not rejected or not self.stream_msg_id or not self.last_sent_content:
            raise QQStreamFinalizationError("QQ 流式消息关闭未获确认") from error
        delivered_content = self.last_sent_content
        self.error = None
        self._chain = None
        try:
            await self._flush(10, content_override=delivered_content)
        except Exception as close_error:
            diag_log("agent.gateway.qq.stream_rejected_content", error)
            raise QQStreamFinalizationError("QQ 流式消息关闭未获确认") from close_error
        raise QQStreamDeliveryError("QQ 部分正文被拒绝，已关闭最后送达的内容") from error

    def has_sent(self) -> bool:
        return self.sent_frame_count > 0

def create_private_text_stream(openid: str, *, channel_id: str, message_id: str | None = None) -> QQPrivateTextStream:
    return QQPrivateTextStream(
        channel_id,
        openid,
        message_id=message_id,
    )

def _markdown_blocked(exc: Exception) -> bool:
    """该 bot 没开通原生 markdown 权限的报错（回退纯文本）。优先从结构化 body 判定；
    非 QQAPIError（如连接层异常）没有 body，退回旧的字符串启发式兼容。"""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        code = body.get("code")
        msg = str(body.get("message") or "")
        if code in (50056, 40034012) or "不允许发送原生 markdown" in msg:
            return True
        return False
    s = str(body) if body is not None else str(exc)
    return ("50056" in s or "40034012" in s or "不允许发送原生 markdown" in s)

def _qq_msg_id_invalid(exc: Exception) -> bool:
    """QQ 被动回复窗口过期或 msg_id 越权时，允许降级为主动消息。"""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        expired_codes = (40034005, 40034024, 40034031)
        if body.get("code") in expired_codes or body.get("err_code") in expired_codes:
            return True
        message = str(body.get("message") or "")
        return (
            "回复消息msg_id已过期" in message
            or "msg_id无效或越权" in message
            or "msgid已经过期" in message
        )
    text = str(body) if body is not None else str(exc)
    return (
        "40034005" in text
        or "40034024" in text
        or "40034031" in text
        or "回复消息msg_id已过期" in text
        or "msg_id无效或越权" in text
        or "msgid已经过期" in text
    )

def _qq_passive_reply_limited(exc: Exception) -> bool:
    """QQ 被动回复时间或次数耗尽时，允许降级为主动消息。"""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        if body.get("code") == 40034128 or body.get("err_code") == 40034128:
            return True
        return "被动回复时间或者次数超过限制" in str(body.get("message") or "")
    text = str(body) if body is not None else str(exc)
    return "40034128" in text or "被动回复时间或者次数超过限制" in text

def _format_group_mention(text: str, user_id: str | None,
                          known_member_ids: frozenset[str] | set[str] = frozenset()) -> str:
    """把模型输出的当前群成员 ``@平台ID`` 转成 QQ 最新 mention 格式。

    模型明确输出的旧式 mention 全部升级；普通 ``@ID`` 只转换可信成员——当前消息
    发言人，或该群 members.json 里登记过的成员（``known_member_ids``），避免普通
    ``@文本`` 或猜测其他成员 ID 误触发平台 mention。QQ 官方当前格式是
    ``<qqbot-at-user id="..." />``；旧 ``<@ID>`` / ``<@!ID>`` 也统一升级。
    """
    source = text or ""

    def replace_legacy(match: re.Match[str]) -> str:
        target_id = match.group(1).strip()
        if not target_id or any(char in target_id for char in '<>"\''):
            return match.group(0)
        return f'<qqbot-at-user id="{target_id}" />'

    # 模型明确输出的旧式 mention 已经表达了目标，不再猜测其对应成员，统一升级
    # 为官方新格式，以支持“@上面的人”等一次提及多个群成员的请求。
    source = re.sub(r"<@!?([^>\s]+)>", replace_legacy, source)

    user_id = str(user_id or "").strip()
    trusted = set(known_member_ids or ())
    if user_id and not any(char in user_id for char in '<>"\''):
        trusted.add(user_id)
    if not trusted:
        return source
    for member_id in trusted:
        escaped_id = re.escape(member_id)
        source = re.sub(
            rf"(?<![<@\w])[@＠]{escaped_id}(?!\w)",
            f'<qqbot-at-user id="{member_id}" />',
            source,
        )
    return source

def _has_qq_group_mention(text: str) -> bool:
    """判断正文是否含 QQ 群 mention 标签，供兼容模式选择可解析的消息类型。"""
    return bool(re.search(r"<qqbot-at-user\s+id=\"[^\"]+\"\s*/>", text or ""))

def _split_qq_group_mention(text: str, user_id: str | None,
                            known_member_ids: frozenset[str] | set[str] = frozenset()) -> tuple[str, str]:
    """将群回复拆成独立 mention 消息和普通正文。"""
    formatted = _format_group_mention(text, user_id, known_member_ids)
    mention_re = re.compile(r"<qqbot-at-user\s+id=\"[^\"]+\"\s*/>")
    mentions = mention_re.findall(formatted)
    if not mentions:
        return "", formatted
    body = mention_re.sub("", formatted)
    body = re.sub(r"[ \t]{2,}", " ", body).strip()
    return "".join(mentions), body

async def _post(channel_id: str, openid: str, text: str, msg_id: str | None,
                message_format: str | None = None):
    """按会话格式发送 QQ 文本；Markdown 被拒时回退纯文本。"""
    path = f"/v2/users/{openid}/messages"
    text = prepare_qq_text(text)
    msg_type = _message_type(text, message_format)
    body = {"msg_type": msg_type, "msg_seq": await _next_seq(msg_id)}
    if msg_type == 2:
        body["markdown"] = {"content": text}
    else:
        body["content"] = text
    if msg_id:
        body["msg_id"] = msg_id
    try:
        await _qq_request(channel_id, "POST", path, json_body=body)
    except Exception as me:
        if msg_type != 2 or not _markdown_blocked(me):
            raise
        body = {"msg_type": 0, "content": text, "msg_seq": await _next_seq(msg_id)}
        if msg_id:
            body["msg_id"] = msg_id
        await _qq_request(channel_id, "POST", path, json_body=body)

async def _post_group(channel_id: str, group_openid: str, text: str, msg_id: str | None,
                      message_format: str | None = None,
                      mention_user_id: str | None = None,
                      known_member_ids: frozenset[str] | set[str] = frozenset()):
    """群聊版文本发送：按会话格式选择纯文本或 Markdown。"""
    path = f"/v2/groups/{group_openid}/messages"
    text = _format_group_mention(text, mention_user_id, known_member_ids)
    text = prepare_qq_text(text)
    msg_type = _message_type(text, message_format)
    # compat 默认是纯文本，但 QQ 只会在可解析的富文本消息中渲染 mention 标签。
    # 仅对明确包含 mention 的群消息升级，不改变普通兼容模式的输出约束。
    if msg_type == 0 and _has_qq_group_mention(text):
        msg_type = 2
    body = {"msg_type": msg_type, "msg_seq": await _next_seq(msg_id)}
    if msg_type == 2:
        body["markdown"] = {"content": text}
    else:
        body["content"] = text
    if msg_id:
        body["msg_id"] = msg_id
    try:
        await _qq_request(channel_id, "POST", path, json_body=body)
    except Exception as me:
        if msg_type != 2 or not _markdown_blocked(me):
            raise
        body = {"msg_type": 0, "content": text, "msg_seq": await _next_seq(msg_id)}
        if msg_id:
            body["msg_id"] = msg_id
        await _qq_request(channel_id, "POST", path, json_body=body)

KEYBOARD_ROW_BUDGET = 40

KEYBOARD_BUTTON_CHROME = 4

KEYBOARD_MAX_ROWS = 5

KEYBOARD_MAX_PER_ROW = 5

def _label_units(label: str) -> int:
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in label)

def _keyboard_wire_payload(prompt: dict[str, Any]) -> dict[str, Any]:
    """把统一交互动作转换为 QQ 官方 Inline Keyboard payload。"""
    from agent.interactions.qq import build_keyboard_payload

    actions = build_keyboard_payload(prompt)
    buttons = []
    for index, item in enumerate(actions["buttons"]):
        buttons.append({
            "id": f"gugu-{actions['prompt_id']}-{index + 1}",
            "render_data": {
                "label": item["label"][:40],
                "visited_label": "已选择",
                "style": 1,
            },
            # 单选 Prompt：点击后按钮只允许消费一次，并让 QQ 将同组按钮
            # 视为互斥选择，而不是继续显示为可多选状态。
            "group_id": f"gugu-prompt-{actions['prompt_id']}",
            "action": {
                "type": 1,
                # 交互权限由服务端 prompt/session 校验；QQ C2C 对
                # type=0 + specify_user_ids 的组合兼容性不稳定。
                "permission": {"type": 2},
                "click_limit": 1,
                "data": item["action_data"],
                "unsupport_tips": "请回复选项序号或选项文字",
            },
        })
    return {"content": {"rows": [{"buttons": row} for row in _pack_button_rows(buttons)]}}

def _pack_button_rows(buttons: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """按估算宽度贪心切行：按钮平分一行宽度时中文标签会被客户端截断；
    单条超宽标签独占一行也截不救，超出 5 行则放弃键盘走文本兜底。"""
    rows: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_units = 0
    for button in buttons:
        units = _label_units(button["render_data"]["label"]) + KEYBOARD_BUTTON_CHROME
        if current and (len(current) >= KEYBOARD_MAX_PER_ROW
                        or current_units + units > KEYBOARD_ROW_BUDGET):
            rows.append(current)
            current, current_units = [], 0
        current.append(button)
        current_units += units
    if current:
        rows.append(current)
    if len(rows) > KEYBOARD_MAX_ROWS:
        raise ValueError(
            f"按钮宽度估算超出 QQ 键盘容量（最多 {KEYBOARD_MAX_ROWS} 行），转文本兜底"
        )
    return rows

async def _post_keyboard(channel_id: str, target_id: str, text: str, msg_id: str | None,
                         *, group: bool, prompt: dict[str, Any]):
    """发送带文本说明和 Inline Keyboard 的 QQ 消息。"""
    target = "groups" if group else "users"
    path = f"/v2/{target}/{target_id}/messages"
    # QQ Inline Keyboard 使用 Markdown 消息类型；这是 QQNT/QwenPaw
    # 实际可渲染按钮的组合。普通回复仍由 _post/_post_group 按
    # message_format 选择消息类型。
    body = {
        "msg_type": 2,
        "markdown": {"content": text},
        "keyboard": _keyboard_wire_payload(prompt),
        "msg_seq": await _next_seq(msg_id),
    }
    if msg_id:
        body["msg_id"] = msg_id
    await _qq_request(channel_id, "POST", path, json_body=body)

async def send_keyboard(target_id: str, text: str, prompt: dict[str, Any], *,
                        channel_id: str, msg_id: str | None = None,
                        group: bool = False) -> bool:
    """发送 QQ Keyboard；平台拒绝时返回 False，由统一出站层发送文本兜底。"""
    for attempt in (1, 2):
        try:
            await _post_keyboard(
                channel_id,
                target_id,
                text,
                msg_id,
                group=group,
                prompt=prompt,
            )
            return True
        except Exception as exc:
            diag_log("agent.gateway.qq.send_keyboard", exc)
            _send_tokens.pop(channel_id, None)
            if attempt == 2 or not _qq_is_transient(exc):
                return False
            await asyncio.sleep(0.5)
    return False

def _link_keyboard_wire_payload(buttons: list[dict[str, Any]]) -> dict[str, Any]:
    """把已校验的链接按钮转成 QQ 官方跳转 Keyboard（action.type=0，PRD-LLM-24 §8.2）。

    跳转按钮的 ``data`` 就是目标 URL 本身，不携带 ask_user 的 opaque token，
    也不进入 interaction 事件解析；与回调按钮（type=1）协议隔离。
    """
    wire: list[dict[str, Any]] = []
    for index, button in enumerate(buttons, start=1):
        wire.append({
            "id": f"gugu-link-{index}",
            "render_data": {
                "label": button["label"][:40],
                "visited_label": button["label"][:40],
                "style": 1,
            },
            "action": {
                "type": 0,
                "permission": {"type": 2},
                "data": button["url"],
                "unsupport_tips": "当前客户端不支持打开链接",
            },
        })
    return {"content": {"rows": [{"buttons": row} for row in _pack_button_rows(wire)]}}

async def send_link_keyboard(target_id: str, text: str, buttons: list[dict[str, Any]], *,
                             channel_id: str, msg_id: str | None = None,
                             group: bool = False) -> bool:
    """发送带链接跳转 Keyboard 的 Markdown 消息；失败返回 False 由出站层文本降级。"""
    buttons, unsupported = prepare_qq_link_buttons(buttons)
    if unsupported or not buttons:
        return False
    text = prepare_qq_text(text)
    target = "groups" if group else "users"
    path = f"/v2/{target}/{target_id}/messages"
    body = {
        "msg_type": 2,
        "markdown": {"content": text},
        "keyboard": _link_keyboard_wire_payload(buttons),
        "msg_seq": await _next_seq(msg_id),
    }
    if msg_id:
        body["msg_id"] = msg_id
    for attempt in (1, 2):
        try:
            await _qq_request(channel_id, "POST", path, json_body=body)
            return True
        except Exception as exc:
            diag_log("agent.gateway.qq.send_link_keyboard", exc)
            _send_tokens.pop(channel_id, None)
            if attempt == 2 or not _qq_is_transient(exc):
                return False
            await asyncio.sleep(0.5)
    return False

async def send_c2c(openid: str, text: str, msg_id: str | None = None,
                   channel_id: str | None = None, message_format: str | None = None) -> bool:
    """给指定用户发 C2C 被动回复（带原 msg_id）。只在失败判定为瞬时（超时/连接错/5xx/429）
    时重试一次；4xx 等永久错误直接失败——发消息不是幂等操作，重试会造成重复推送，
    对不会成功的永久错误重试只有坏处没有好处（P2-b §1/§4-A 幂等前提）。"""
    print(json.dumps({
        "event": "send-c2c-start",
        "has_openid": bool(openid),
        "has_channel_id": bool(channel_id),
        "has_msg_id": bool(msg_id),
    }, ensure_ascii=False), flush=True)
    for attempt in (1, 2):
        try:
            if message_format is None:
                await _post(channel_id, openid, text, msg_id)
            else:
                await _post(channel_id, openid, text, msg_id, message_format)
            print(json.dumps({
                "event": "send-c2c-ok",
                "attempt": attempt,
            }, ensure_ascii=False), flush=True)
            return True
        except Exception as e:
            print(json.dumps({
                "event": "send-c2c-error",
                "attempt": attempt,
                "error": type(e).__name__,
                "transient": _qq_is_transient(e),
                "qq": _qq_error_summary(e),
            }, ensure_ascii=False), flush=True)
            if msg_id and (_qq_msg_id_invalid(e) or _qq_passive_reply_limited(e)):
                _log.warning("[qq] C2C 被动回复受限，降级为主动消息")
                try:
                    if message_format is None:
                        await _post(channel_id, openid, text, None)
                    else:
                        await _post(channel_id, openid, text, None, message_format)
                    return True
                except Exception as fallback_error:
                    diag_log("agent.gateway.qq.send_c2c.active_fallback", fallback_error)
                    _log.warning("[qq] C2C 主动消息发送失败: %s",
                                 redact(f"{type(fallback_error).__name__}: {fallback_error}"))
                    return False
            diag_log("agent.gateway.qq.send_c2c", e)
            _log.warning("[qq] 发送失败(第%d次): %s", attempt, redact(f"{type(e).__name__}: {e}"))
            _send_tokens.pop(channel_id, None)   # 丢弃缓存，下次重新取 token
            if attempt == 2 or not _qq_is_transient(e):
                return False
            await asyncio.sleep(0.5)
    return False

async def _known_group_member_ids(channel_id: str, group_openid: str) -> frozenset[str]:
    """读群记忆 members.json 拿已登记成员 openid，作为 @ID 升级白名单。

    只在发送路径按需读一个 JSON；读不到（新群/存储故障）返回空集，
    退回只转当前发言人的旧行为，不阻断发送。
    """
    try:
        from uuid import UUID as _UUID
        from sqlalchemy import select as _select
        import app.db.session as _ss
        from app.models import UserBot as _UserBot
        from agent.memory.scopes import MemoryScope
        from agent.memory.scoped_store import read_scope_json

        _ss.ensure_engine()
        async with _ss._SessionLocal() as db:
            row = (await db.execute(
                _select(_UserBot).where(_UserBot.id == int(channel_id))
            )).scalars().first()
            if row is None:
                return frozenset()
            scope = MemoryScope(
                owner_user_id=str(row.user_id), platform="qq",
                bot_id=str(channel_id), scope_type="group", scope_id=group_openid,
            )
        doc = await read_scope_json(scope, "members.json")
        members = doc.get("members") if isinstance(doc, dict) else {}
        if not isinstance(members, dict):
            return frozenset()
        return frozenset(str(key) for key in members.keys() if str(key).strip())
    except Exception as exc:
        diag_log("agent.gateway.qq.mention_members", exc)
        return frozenset()

async def send_group(group_openid: str, text: str, msg_id: str | None = None,
                     channel_id: str | None = None, message_format: str | None = None,
                     mention_user_id: str | None = None) -> bool:
    """给指定群发被动回复（带原 msg_id）。只在失败判定为瞬时时重试一次；
    4xx 等永久错误直接失败（同 send_c2c，发消息非幂等，不对永久错误盲重试）。"""
    print(json.dumps({
        "event": "send-group-start",
        "has_group_openid": bool(group_openid),
        "has_channel_id": bool(channel_id),
        "has_msg_id": bool(msg_id),
    }, ensure_ascii=False), flush=True)
    # 只有正文带 @ 时才值得查成员名单；其余发送零额外开销
    known_member_ids: frozenset[str] = frozenset()
    if "@" in text or "＠" in text:
        known_member_ids = await _known_group_member_ids(str(channel_id or ""), group_openid)
    mention_text, body_text = _split_qq_group_mention(text, mention_user_id, known_member_ids)
    mention_sent = False
    for attempt in (1, 2):
        try:
            if mention_text and not mention_sent:
                # mention 单独使用 Markdown，避免兼容模式把标签当普通文本展示。
                await _post_group(channel_id, group_openid, mention_text, msg_id, "markdown",
                                  known_member_ids=known_member_ids)
                mention_sent = True
            if mention_text and body_text:
                if message_format is None:
                    await _post_group(channel_id, group_openid, body_text, None,
                                      known_member_ids=known_member_ids)
                else:
                    await _post_group(channel_id, group_openid, body_text, None, message_format,
                                      known_member_ids=known_member_ids)
            elif not mention_text:
                if message_format is None:
                    await _post_group(channel_id, group_openid, text, msg_id,
                                      known_member_ids=known_member_ids)
                else:
                    await _post_group(channel_id, group_openid, text, msg_id, message_format,
                                      known_member_ids=known_member_ids)
            print(json.dumps({
                "event": "send-group-ok",
                "attempt": attempt,
            }, ensure_ascii=False), flush=True)
            return True
        except Exception as e:
            print(json.dumps({
                "event": "send-group-error",
                "attempt": attempt,
                "error": type(e).__name__,
                "transient": _qq_is_transient(e),
                "qq": _qq_error_summary(e),
            }, ensure_ascii=False), flush=True)
            if msg_id and (_qq_msg_id_invalid(e) or _qq_passive_reply_limited(e)):
                _log.warning("[qq] 群聊被动回复受限，降级为主动消息")
                try:
                    if mention_text and not mention_sent:
                        await _post_group(channel_id, group_openid, mention_text, None, "markdown",
                                          known_member_ids=known_member_ids)
                        mention_sent = True
                    if mention_text and body_text:
                        if message_format is None:
                            await _post_group(channel_id, group_openid, body_text, None,
                                              known_member_ids=known_member_ids)
                        else:
                            await _post_group(
                                channel_id, group_openid, body_text, None, message_format,
                                known_member_ids=known_member_ids,
                            )
                    elif not mention_text:
                        if message_format is None:
                            await _post_group(channel_id, group_openid, text, None,
                                              known_member_ids=known_member_ids)
                        else:
                            await _post_group(channel_id, group_openid, text, None, message_format,
                                              known_member_ids=known_member_ids)
                    return True
                except Exception as fallback_error:
                    diag_log("agent.gateway.qq.send_group.active_fallback", fallback_error)
                    _log.warning("[qq] 群聊主动消息发送失败: %s",
                                 redact(f"{type(fallback_error).__name__}: {fallback_error}"))
                    return False
            diag_log("agent.gateway.qq.send_group", e)
            _log.warning("[qq] 群发送失败(第%d次): %s", attempt, redact(f"{type(e).__name__}: {e}"))
            _send_tokens.pop(channel_id, None)
            if attempt == 2 or not _qq_is_transient(e):
                return False
            await asyncio.sleep(0.5)
    return False

_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}

async def send_file(openid: str, data: bytes | None, name: str, ext: str,
                    channel_id: str | None = None, msg_id: str | None = None,
                    group: bool = False) -> bool:
    """给 QQ 私聊或群聊发媒体；本地文件统一使用 base64 上传。"""
    import base64
    ext_l = (ext or "").lower()
    is_img = ext_l in _IMAGE_EXTS
    file_type = 1 if is_img else 4
    fname = f"{name}.{ext_l}" if ext_l else name
    if data is None:
        return False
    b64 = base64.b64encode(data).decode()
    target = "groups" if group else "users"
    # 上传 inner proxy 偶发抖动，多重试几次（每次取新 msg_seq，避免去重）
    for attempt in range(1, 5):
        try:
            # 1) 上传到 QQ 富媒体，拿 file_info。
            body = {"file_type": file_type, "srv_send_msg": False}
            body["file_data"] = b64
            if not is_img:
                body["file_name"] = fname
            media = await _qq_request(channel_id, "POST", f"/v2/{target}/{openid}/files", json_body=body)
            file_info = media.get("file_info") if isinstance(media, dict) else None
            if not file_info:
                # 只打字段名，不打整个响应体（万一 QQ 把请求里的 file_name 之类字段原样回显）
                keys = sorted(media.keys()) if isinstance(media, dict) else type(media).__name__
                print(f"[qq] 富媒体上传无 file_info: keys={keys}", flush=True)
                return False
            # 2) 发媒体消息（被动回复带 msg_id；文件用 content 让 QQ 显示文件名）
            msg_body = {"msg_type": 7, "media": {"file_info": file_info},
                       "msg_seq": await _next_seq(msg_id)}
            if msg_id:
                msg_body["msg_id"] = msg_id
            if not is_img:
                msg_body["content"] = fname
            message_path = f"/v2/{target}/{openid}/messages"
            try:
                await _qq_request(channel_id, "POST", message_path, json_body=msg_body)
            except Exception as message_error:
                # 群文件经常在模型生成期间跨过 QQ 的被动回复窗口；上传已经成功，
                # 只去掉过期的 msg_id 重发同一个 file_info，避免重复上传和丢失附件。
                if not (
                    group
                    and msg_id
                    and (_qq_msg_id_invalid(message_error) or _qq_passive_reply_limited(message_error))
                ):
                    raise
                _log.warning("[qq] 群文件被动回复受限，降级为主动消息")
                active_body = dict(msg_body)
                active_body.pop("msg_id", None)
                active_body["msg_seq"] = await _next_seq(None)
                await _qq_request(channel_id, "POST", message_path, json_body=active_body)
            return True
        except Exception as e:
            diag_log("agent.gateway.qq.send_file", e)
            _log.warning("[qq] 发文件失败(第%d次): %s", attempt, redact(f"{type(e).__name__}: {e}"))
            # token 失效才重建缓存；inner proxy 等抖动直接重试
            if isinstance(e, QQAPIError) and e.status == 401:
                _send_tokens.pop(channel_id, None)
            elif "token" in str(e).lower():
                _send_tokens.pop(channel_id, None)
            # 上传/发送都不是幂等操作（重复上传浪费、重复发送会造成重复文件消息）；
            # 只对判定为瞬时的失败继续重试，4xx 等永久错误立即放弃（P2-b §1/§4-A）。
            if attempt < 4 and _qq_is_transient(e):
                await asyncio.sleep(0.6 * attempt)
            else:
                return False
    return False
