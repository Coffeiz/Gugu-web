"""IM 出站回复映射。

这里把平台无关的 ``PlatformReply`` 转成 Gateway 的发送调用，是"该调哪个平台
发送接口"这个判断的唯一位置——文本、流式和文件回复都经这里分发，不再各自
维护一份 if/elif。文件的元数据解析、大小限制和 DB/存储读取仍属于
``agent.im.files`` 的职责，只是最终"调哪个 Gateway 函数发送"收到这里来。
"""
from __future__ import annotations

import json
import re
import secrets
import time
from collections.abc import Set
from typing import AsyncIterator, Tuple

from agent.im.models import PlatformReply
from agent.interactions.events import ROUND_END
from agent.models import AgentResponse

_CODE_SPLIT_RE = re.compile(r'(```[\s\S]*?```|`[^`\n]*`)')
_MERMAID_SOURCE_FENCE_RE = re.compile(
    r"```mermaid[ \t]*\r?\n[\s\S]*?```", re.IGNORECASE,
)
_BOLD_LEAD_WS_RE = re.compile(r'\*\*[ \t]+([^*\n]+?)\*\*')
_BOLD_TRAIL_WS_RE = re.compile(r'\*\*([^*\n]+?)[ \t]+\*\*')

_FEISHU_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_FEISHU_IMAGE_MAX = 10 * 1024 * 1024
_FEISHU_FILE_MAX = 30 * 1024 * 1024
_WECHAT_FILE_MAX = 30 * 1024 * 1024
_QQ_FILE_MAX = 10 * 1024 * 1024
_QQ_PASSIVE_REPLY_COUNT = "_qq_passive_reply_count"
_QQ_PASSIVE_REPLY_LIMIT = 5
_TELEGRAM_DRAFT_MIN_INTERVAL = 1.0


def _qq_passive_reply_count(payload: dict) -> int:
    return int(payload.get(_QQ_PASSIVE_REPLY_COUNT) or 0)


def _qq_reply_budget_exhausted(payload: dict) -> bool:
    return (
        payload.get("platform") == "qq"
        and bool(payload.get("message_id"))
        and _qq_passive_reply_count(payload) >= _QQ_PASSIVE_REPLY_LIMIT
    )


def _qq_reply_message_id(payload: dict, reply: PlatformReply) -> str | None:
    """在 QQ 被动回复额度内关联原始入站消息。"""
    if payload.get("platform") != "qq" or _qq_reply_budget_exhausted(payload):
        return None
    return reply.reply_to_message_id


def _mark_qq_passive_reply_used(payload: dict, message_id: str | None) -> None:
    """记录一次已成功发送的 QQ 被动回复。"""
    if payload.get("platform") == "qq" and message_id:
        payload[_QQ_PASSIVE_REPLY_COUNT] = min(
            _qq_passive_reply_count(payload) + 1, _QQ_PASSIVE_REPLY_LIMIT
        )


async def _close_async_iterator(iterator) -> None:
    """确保流式 agent 生成器退出，从而释放其内部 AsyncSession。"""
    close = getattr(iterator, "aclose", None)
    if close is None:
        return
    try:
        await close()
    except Exception:
        # 发送链路的原始异常不能被清理动作覆盖；诊断由调用方记录。
        pass


class _QQMermaidRound:
    """管理 QQ 私聊的 Mermaid 流式占位、round 收尾和图片回退。"""

    def __init__(self, payload: dict, *, show_intermediate_replies: bool) -> None:
        from agent.gateway import qq

        self.payload = payload
        # 保留参数兼容调用方，但流式传输由 QQ 私聊流开关决定。
        self.stream_kwargs = {
            "channel_id": payload.get("channel_id") or "",
            "message_id": payload.get("message_id"),
        }
        self._qq = qq
        self.stream_failed = False
        self.stream = self._new_stream()
        self._stream_counted = False
        self.stream_sent = False
        self.last_text = ""
        self.round_text = ""
        self.segment_text = ""
        self.pending_whitespace = ""
        self.round_has_image = False
        self.trim_leading_segment = False
        self.stream_message_id: str | None = None

    def _new_stream(self):
        self._stream_counted = False
        # 每个文本段都是独立气泡，但仍可在 QQ 被动回复额度内关联同一条入站消息。
        # stream_messages 没有入站 message_id 时无法开启新流；额度耗尽后退回普通主动文本。
        if not self.payload.get("message_id") or _qq_reply_budget_exhausted(self.payload):
            self.stream_message_id = None
            self.stream_failed = True
            return None
        self.stream_message_id = self.payload.get("message_id")
        kwargs = {**self.stream_kwargs, "message_id": self.stream_message_id}
        return self._qq.create_private_text_stream(
            self.payload.get("platform_user_id") or "", **kwargs
        )

    async def push_token(self, token: str) -> None:
        if token:
            from agent.im.mermaid import ReplyPart
            await self._emit_parts([ReplyPart(text=token)])

    async def push_image(self, payload) -> None:
        _diagram_index, _image_number, source, png = payload
        from agent.im.mermaid import ReplyPart
        await self._emit_parts([ReplyPart(png=png, source=source)])

    async def finish_round(self, final_text: str = "", *, start_next: bool = True) -> None:
        final_text = _fix_loose_bold(final_text or "")
        if not self.round_text.strip() and final_text.strip() and not self.round_has_image:
            self.segment_text = final_text.strip()
            self.round_text = self.segment_text
            if self.stream is not None:
                self.stream.push(self.segment_text)
        self.pending_whitespace = ""
        await self._finish_text_segment()
        self.last_text = final_text.strip() or self.round_text.strip() or self.last_text
        self._reset_round()
        if start_next:
            self.stream = self._new_stream()

    async def finish_response(self, final_text: str) -> tuple[bool, str]:
        has_pending_output = bool(
            self.round_text.strip()
            or self.segment_text.strip()
            or self.round_has_image
        )
        if has_pending_output:
            if not self.round_text.strip() and final_text.strip() and not self.round_has_image:
                # 防御没有 token 事件但带有 final 正文的迭代器；仍走相同的 Mermaid 解析。
                from agent.im.mermaid import render_reply
                parts = await render_reply(
                    final_text,
                    theme_preferences=self.payload.get("mermaid_theme_preferences"),
                )
                await self._emit_parts(parts)
                await self._finish_text_segment(trim_end=any(part.png for part in parts))
                self.last_text = final_text.strip()
            else:
                await self.finish_round(final_text, start_next=False)
        elif not self.last_text and final_text.strip() and not self.stream_sent:
            # 仅当流中完全没有交付内容时，才用完整响应补偿缺失的 token/ROUND_END。
            # final_text 可能经过终态清洗而与已发送轮次略有差异；不能因此重播整轮，
            # 否则 Mermaid 前已经发出的说明文字和图片会再次出现。
            from agent.im.mermaid import render_reply
            parts = await render_reply(
                final_text,
                theme_preferences=self.payload.get("mermaid_theme_preferences"),
            )
            await self._emit_parts(parts)
            await self._finish_text_segment(trim_end=any(part.png for part in parts))
            self.last_text = final_text.strip()
        if self.stream is not None:
            self.stream_sent = self.stream_sent or self.stream.has_sent()
        return self.stream_sent, self.last_text

    def _record_stream_delivery(self) -> bool:
        if self.stream is not None and self.stream.has_sent():
            self.stream_sent = True
            self._count_stream_reply()
        return self.stream_sent

    def _fail_stream(self) -> None:
        self._record_stream_delivery()
        self.stream_failed = True
        self.stream = None

    async def recover_after_stream_error(self) -> bool:
        """切换到普通文字发送，继续排空已生成内容，避免重发已发出的图片。"""
        self._fail_stream()
        await self._finish_text_segment()
        return self.stream_sent

    def _count_stream_reply(self) -> None:
        if (
            self.stream is not None
            and self.stream.has_sent()
            and self.stream_message_id
            and not self._stream_counted
        ):
            _mark_qq_passive_reply_used(self.payload, self.stream_message_id)
            self._stream_counted = True

    async def _finish_text_segment(self, *, trim_end: bool = False) -> None:
        if trim_end:
            # 只丢弃尚未推送的尾部空白。流式 replace 不允许回改已经展示的前缀，
            # 直接 rstrip(segment_text) 会让 QQ 拒绝收尾帧并把气泡留在生成中。
            self.pending_whitespace = ""
        if not self.segment_text.strip():
            self.segment_text = ""
            return
        if self.stream is None:
            if self.stream_failed:
                text = self.segment_text
                self.segment_text = ""
                try:
                    if await send_text(self.payload, text):
                        self.stream_sent = True
                except Exception as exc:
                    from app.core.redaction import diag_log
                    diag_log("agent.im.qq_stream_text_recovery", exc)
            return
        stream = self.stream
        text = self.segment_text
        try:
            await stream.finish(text)
        except Exception:
            # finish() 可能在内容帧已成功、仅结束帧失败时抛错。只保留尚未
            # 确认送达的尾部给普通消息回退，不能把完整流文本再发一遍。
            delivered = str(getattr(stream, "last_sent_text", "") or "")
            if stream.has_sent():
                self.stream_sent = True
                # 即使 DONE 帧失败，已发送的流正文也已占用一次 QQ 被动回复额度。
                # 后续 Mermaid 后的文本会开启新流，不能再次关联同一条入站消息。
                self._count_stream_reply()
                self.segment_text = (
                    text[len(delivered):]
                    if delivered and text.startswith(delivered)
                    else ""
                )
            raise
        self.stream_sent = self.stream_sent or self.stream.has_sent()
        self._count_stream_reply()
        self.segment_text = ""

    async def _emit_parts(self, parts) -> None:
        for part in parts:
            if part.png is not None:
                self.round_has_image = True
                try:
                    await self._finish_text_segment(trim_end=True)
                except Exception as exc:
                    from app.core.redaction import diag_log
                    diag_log("agent.im.qq_stream_transport", exc)
                    self._fail_stream()
                    await self._finish_text_segment(trim_end=True)
                image_sent = await _try_send_png_image(self.payload, part.png)
                if image_sent:
                    self.stream_sent = True
                elif part.source:
                    if not await _send_qq_mermaid_text(self.payload, part.source):
                        raise RuntimeError("QQ Mermaid 图片和文本回退均发送失败")
                    self.stream_sent = True
                self.trim_leading_segment = True
                self.stream = self._new_stream()
            elif part.placeholder_emitted:
                self.round_has_image = True
                await self._finish_text_segment(trim_end=True)
                self.trim_leading_segment = True
            elif part.text:
                text = part.text
                if self.trim_leading_segment:
                    text = text.lstrip()
                    # Mermaid 后可能先出现一个单独的空白分片；继续等待首段正文，
                    # 否则下一分片的换行仍会被带进 QQ 消息。
                    if text.strip():
                        self.trim_leading_segment = False
                if not text:
                    continue
                self.round_text += text
                buffered = self.pending_whitespace + text
                visible = buffered.rstrip()
                self.pending_whitespace = buffered[len(visible):]
                if visible:
                    self.segment_text += visible
                    if self.stream is not None:
                        self.stream.push(visible)

    def _reset_round(self) -> None:
        self.round_text = ""
        self.round_has_image = False
        self.segment_text = ""
        self.pending_whitespace = ""


async def send_qq_stream_by_round(
    payload: dict, token_iter: AsyncIterator[tuple[str, object]], *,
    show_intermediate_replies: bool = True,
) -> Tuple[bool, AgentResponse, str]:
    """QQ 私聊按 round 流式发送；Mermaid 源码暂存，图表以图片消息补发。"""
    sender = _QQMermaidRound(
        payload, show_intermediate_replies=show_intermediate_replies
    )
    # QQ 私聊格式为 Markdown 时逐步推送；“显示中间回复”只影响兼容模式的轮次展示，
    # 不能再让它关闭已经启用的私聊流。Mermaid 在 token 边界统一过滤并背压。
    from agent.im.mermaid import ProgressiveMermaidTokenFilter
    token_iter = ProgressiveMermaidTokenFilter(
        theme_preferences=payload.get("mermaid_theme_preferences"),
    ).events(token_iter)
    response: AgentResponse | None = None
    last_text = ""
    transport_error: Exception | None = None

    async for kind, value in token_iter:
        if kind == "final" and isinstance(value, AgentResponse):
            response = value
            continue
        try:
            if kind == "token":
                await sender.push_token(str(value or ""))
            elif kind == "mermaid_image":
                await sender.push_image(value)
            elif kind == ROUND_END:
                await sender.finish_round(str(value or ""))
        except Exception as exc:
            if transport_error is None:
                transport_error = exc
            sender._fail_stream()

    response = response or AgentResponse()
    last_text = _fix_loose_bold(response.text or "")
    if not last_text.strip():
        last_text = "给你～" if response.files else "嗯~在的，你说～"
    if transport_error is not None:
        from app.core.redaction import diag_log
        diag_log("agent.im.qq_stream_transport", transport_error)
    try:
        stream_sent, last_text = await sender.finish_response(last_text)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.im.qq_stream_transport", exc)
        return await sender.recover_after_stream_error(), response, last_text
    return stream_sent, response, last_text


class _TelegramDraftRound:
    """管理 Telegram live draft，并在 Mermaid 图片边界切分正式消息。"""

    def __init__(self, payload: dict, *, show_intermediate_replies: bool) -> None:
        self.payload = payload
        self.show_intermediate_replies = show_intermediate_replies
        self.round_text = ""
        self.draft_id = secrets.randbits(63) or 1
        self.last_update_at = 0.0
        self.draft_enabled = True
        self.round_index = 0
        self.sent_rounds: set[int] = set()
        self.parts = []
        self.round_has_image = False
        self.trim_leading_segment = False
        self.mermaid_streaming = False
        self.deferred_rounds: list[tuple[int, list]] = []

    async def push_token(self, token: str) -> None:
        if self.trim_leading_segment:
            token = token.lstrip()
            if token.strip():
                self.trim_leading_segment = False
            if not token:
                return
        self.round_text += token
        if token:
            from agent.im.mermaid import ReplyPart
            if self.parts and self.parts[-1].text:
                previous = self.parts[-1]
                self.parts[-1] = ReplyPart(text=previous.text + token)
            else:
                self.parts.append(ReplyPart(text=token))
        await self._update_draft()

    async def push_image(self, payload) -> None:
        _diagram_index, _image_number, source, png = payload
        from agent.im.mermaid import ReplyPart

        self.round_has_image = True
        if not self.mermaid_streaming:
            # 第一次遇到图时，先冲刷之前被偏好设置暂存的轮次，再进入与 QQ
            # 一致的分段流式模式，保证正文、图片和后续正文按生成顺序落消息。
            self.mermaid_streaming = True
            deferred, self.deferred_rounds = self.deferred_rounds, []
            for round_index, parts in deferred:
                if await self._flush_parts(parts):
                    self.sent_rounds.add(round_index)
                else:
                    self.deferred_rounds.append((round_index, parts))

        # 围栏边界的换行不属于前后两段正文，避免图片前后的气泡留空行。
        if self.parts and self.parts[-1].text:
            previous = self.parts[-1]
            trimmed = previous.text.rstrip()
            if trimmed:
                self.parts[-1] = ReplyPart(text=trimmed)
            else:
                self.parts.pop()
            self.round_text = self.round_text.rstrip()
        self.parts.append(ReplyPart(png=png, source=source))

        # Telegram 草稿只是临时预览。图片到达时，按文本 -> 图片顺序正式落消息，
        # 随后换 draft_id，让图片后的正文开始一条新的流式预览。
        sent = await self._flush_parts()
        if sent:
            self.parts = []
            self.round_text = ""
        else:
            # 保留尚未成功交付的 part，round 收尾时还能再尝试一次。
            self.draft_enabled = False
        self.draft_id = secrets.randbits(63) or 1
        self.last_update_at = 0.0
        self.trim_leading_segment = True

    async def finish_round(self, text: str) -> None:
        round_has_content = bool(text.strip() or self.parts or self.round_has_image)
        if (self.show_intermediate_replies or self.mermaid_streaming) and round_has_content:
            try:
                if await self._flush_parts():
                    self.sent_rounds.add(self.round_index)
            except Exception as exc:
                from app.core.redaction import diag_log
                diag_log("agent.im.telegram_stream_round", exc)
        elif round_has_content:
            self.deferred_rounds.append((self.round_index, self.parts))
        if round_has_content:
            self.round_index += 1
        if self.show_intermediate_replies or self.mermaid_streaming:
            self.draft_id = secrets.randbits(63) or 1
        self.round_has_image = False
        self.trim_leading_segment = False
        self.last_update_at = 0.0
        self.round_text = ""
        self.parts = []

    async def _flush_parts(self, parts=None) -> bool:
        """按序发送当前文字/图片段，只移除已确认送达的 part。"""
        pending = self.parts if parts is None else parts
        while pending:
            part = pending[0]
            if part.png is not None:
                sent = await _try_send_png_image(self.payload, part.png)
                if not sent and part.source:
                    sent = await send_text(self.payload, part.source)
            elif part.text.strip():
                sent = await send_completed_round(self.payload, part.text)
            else:
                sent = True
            if not sent:
                return False
            pending.pop(0)
        return True

    async def _update_draft(self) -> None:
        if not self.draft_enabled or not self.round_text.strip():
            return
        elapsed = time.monotonic() - self.last_update_at
        if self.last_update_at and elapsed < _TELEGRAM_DRAFT_MIN_INTERVAL:
            return
        from agent.gateway import telegram

        sent = await telegram.send_message_draft(
            str(self.payload.get("chat_id") or self.payload.get("platform_user_id") or ""),
            self.round_text,
            channel_id=str(self.payload.get("channel_id") or ""),
            draft_id=self.draft_id,
        )
        if sent:
            self.last_update_at = time.monotonic()
        else:
            # 草稿 API 不可用时继续消费本轮 Agent 流，末尾仍发送正式回复。
            self.draft_enabled = False


async def send_telegram_stream_by_round(
    payload: dict,
    token_iter: AsyncIterator[tuple[str, object]],
    *,
    show_intermediate_replies: bool,
) -> tuple[AgentResponse, set[int]]:
    """私聊用 Telegram 临时草稿预览生成过程，正式文本仍走统一回复出口。"""
    sender = _TelegramDraftRound(
        payload, show_intermediate_replies=show_intermediate_replies,
    )
    from agent.im.mermaid import ProgressiveMermaidTokenFilter
    token_iter = ProgressiveMermaidTokenFilter(
        theme_preferences=payload.get("mermaid_theme_preferences"),
    ).events(token_iter)
    response: AgentResponse | None = None
    async for kind, value in token_iter:
        if kind == "final" and isinstance(value, AgentResponse):
            response = value
        elif kind == "token":
            await sender.push_token(str(value or ""))
        elif kind == "mermaid_image":
            await sender.push_image(value)
        elif kind == ROUND_END:
            await sender.finish_round(str(value or ""))
    response = response or AgentResponse()
    if not show_intermediate_replies and sender.mermaid_streaming and not response.errored:
        expected_rounds = len(response.round_texts or [])
        if expected_rounds == 0 and (response.text or "").strip():
            expected_rounds = 1
        if expected_rounds and set(range(expected_rounds)).issubset(sender.sent_rounds):
            # 隐藏中间回复模式的最终出口只有一个聚合文本索引 0。
            sender.sent_rounds = {0}
        else:
            # 部分分段发送失败时，让最终聚合回复补齐内容。
            sender.sent_rounds.clear()
    return response, sender.sent_rounds


async def send_text(payload: dict, text: str) -> bool:
    """构造并发送一条平台无关的文本回复。"""
    return await send_reply(payload, PlatformReply.from_text(payload, text))


async def _send_qq_mermaid_text(payload: dict, text: str) -> bool:
    """QQ 被动回复额度耗尽后，Mermaid 文本与降级内容改用主动消息发送。"""
    if _qq_reply_budget_exhausted(payload):
        payload = {**payload, "message_id": None}
    return await send_text(payload, text)


def _link_buttons_text(message: str, buttons: list[dict]) -> str:
    """链接按钮的文本降级：保留可复制可点击的完整 URL（PRD-LLM-24 §8.4）。"""
    lines = [message.strip()] if message.strip() else []
    lines.extend(f"· {button['label']}：{button['url']}" for button in buttons)
    return "\n".join(lines)


def _link_buttons_result(status: str, platform: str, delivery: str, buttons: list[dict]) -> dict:
    return {
        "status": status,
        "platform": platform or "web",
        "delivery": delivery,
        "button_count": len(buttons),
    }


async def send_link_button_message(payload: dict, message: str, buttons: list[dict]) -> dict:
    """统一发送链接按钮：原生优先，失败降级文本 URL（PRD-LLM-24 §8/§11）。

    输入必须已通过 ``agent.im.link_buttons`` 校验；这里只负责"当前平台用哪种
    渲染、失败怎么降级"，不重新解释按钮语义，也不创建任何待答交互。
    """
    from agent.im.link_buttons import validate_link_button_url
    from agent.security import logsafe

    platform = str(payload.get("platform") or "")
    # 第二道校验边界（PRD-LLM-24 §12）：出站层不信任上游传入的原始链接。
    # 工具入口已校验一次；这里重验以覆盖未来绕过工具层的新调用方。
    for button in buttons:
        url_error = validate_link_button_url(str(button.get("url") or ""))
        if url_error:
            from agent.security import logsafe as _ls
            print(f"[im] 链接按钮出站前校验失败 fp={_ls.fingerprint(str(button.get('id')))}", flush=True)
            return _link_buttons_result("failed", platform, "none", buttons)

    fallback_text = _link_buttons_text(message, buttons)

    def _fp(text: str) -> str:
        return logsafe.fingerprint(text)

    if platform == "qq":
        is_group = payload.get("chat_type") == "group"
        target_id = payload.get("chat_id") if is_group else payload.get("platform_user_id")
        if not target_id:
            print(f"[im] qq 链接按钮无出站目标 fp={_fp(fallback_text)}", flush=True)
            return _link_buttons_result("unsupported", platform, "none", buttons)
        from agent.gateway import qq
        # 链接按钮不绑定被动回复窗口（同交互键盘：主动消息，避免 40034128）。
        if await qq.send_link_keyboard(
            target_id, message, buttons,
            channel_id=payload.get("channel_id") or "",
            msg_id=None,
            group=is_group,
        ):
            return _link_buttons_result("sent", platform, "native", buttons)
        if await send_text({**payload, "message_id": None}, fallback_text):
            return _link_buttons_result("sent_with_fallback", platform, "text", buttons)
        print(f"[im] qq 链接按钮原生与文本降级均失败 fp={_fp(fallback_text)}", flush=True)
        return _link_buttons_result("failed", platform, "none", buttons)

    if platform == "feishu":
        target_id = payload.get("chat_id") or payload.get("platform_user_id")
        if not target_id:
            print(f"[im] feishu 链接按钮无出站目标 fp={_fp(fallback_text)}", flush=True)
            return _link_buttons_result("unsupported", platform, "none", buttons)
        from agent.gateway import feishu
        if await feishu.send_link_card(target_id, message, buttons, payload.get("channel_id")):
            return _link_buttons_result("sent", platform, "native", buttons)
        if await send_text(payload, fallback_text):
            return _link_buttons_result("sent_with_fallback", platform, "text", buttons)
        print(f"[im] feishu 链接按钮原生与文本降级均失败 fp={_fp(fallback_text)}", flush=True)
        return _link_buttons_result("failed", platform, "none", buttons)

    if platform == "wechat":
        # 微信没有原生 Keyboard：直接文本 URL，结果如实标记 fallback（§5.4）。
        if payload.get("platform_user_id"):
            if await send_text(payload, fallback_text):
                return _link_buttons_result("sent_with_fallback", platform, "text", buttons)
        return _link_buttons_result("failed", platform, "none", buttons)

    # web 或未知渠道：由调用方（工具层）走结构化 artifact 出口，不经 IM 网关。
    print(f"[im] 链接按钮渠道 {platform or 'web'} 无 IM 出站通道 fp={_fp(fallback_text)}", flush=True)
    return _link_buttons_result("unsupported", platform, "none", buttons)


async def send_interaction(payload: dict, prompt: dict) -> bool:
    """统一发送交互提示。

    QQ 使用 Keyboard，飞书使用交互卡片；两者失败后都复用同一份文本降级。
    """
    from agent.interactions.qq import format_text_fallback

    platform = payload.get("platform")
    if prompt.get("secret_fields") and payload.get("chat_type") == "group":
        prompt = {**prompt, "group_secret_blocked": True}
    if platform == "feishu" and prompt.get("options"):
        from agent.gateway import feishu

        target_id = payload.get("chat_id") or payload.get("platform_user_id")
        if target_id and await feishu.send_interaction_card(
            target_id, prompt, channel_id=payload.get("channel_id")
        ):
            return True
        return await send_text(payload, format_text_fallback(prompt, platform="feishu"))
    if platform != "qq":
        return await send_text(payload, format_text_fallback(prompt, platform=platform))

    # 交互提示可能在多轮工具调用后才产生，此时 QQ 的被动回复窗口或次数经常已经
    # 用尽。交互本身不需要绑定原消息，改发主动消息，避免 40034128/40034031
    # 让 Web 有提示但群聊看不到，也避免模型 run 长时间等待不可见的选择。
    interaction_payload = {**payload, "message_id": None}
    text = format_text_fallback(prompt, platform="qq")
    if prompt.get("options"):
        from agent.gateway import qq

        target_id = payload.get("chat_id") if payload.get("chat_type") == "group" else payload.get("platform_user_id")
        keyboard_prompt = {
            **prompt,
            "platform_user_id": payload.get("platform_user_id"),
            "native_keyboard": True,
        }
        # 键盘发送失败时复用同一份 QQ 降级文案，明确告诉用户可以回复序号；
        # 不能退回平台无关的“请在网页点击”，否则 QQ 端没有可用恢复路径。
        text = format_text_fallback(keyboard_prompt, platform="qq")
        if target_id and await qq.send_keyboard(
            target_id,
            format_text_fallback(keyboard_prompt, platform="qq"),
            keyboard_prompt,
            channel_id=payload.get("channel_id") or "",
            msg_id=None,
            group=payload.get("chat_type") == "group",
        ):
            return True
    return await send_text(interaction_payload, text)


def _tool_code_block(value: object, *, language: str = "json", limit: int = 1600) -> str:
    """把工具输入/输出放入有限长度的代码块，避免结构化内容破坏消息排版。"""
    if isinstance(value, str):
        text = value
        language = "text"
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            text = str(value)
    if len(text) > limit:
        text = text[:limit - 1] + "…"
    return f"```{language}\n{text}\n```"


def format_tool_event(
    event: dict,
    *,
    markdown: bool = True,
) -> str:
    """把工具事件转换成统一语义块，再按平台能力渲染。"""
    label = str(event.get("label") or event.get("name") or "工具").strip()
    event_type = str(event.get("type") or "")
    status = str(event.get("status") or "")
    if not markdown:
        if event_type == "tool_call":
            return ""
        if status in {"success", "ok"}:
            return f"✅ {label}完成"
        if status == "waiting":
            return f"⏸️ {label}：任务已暂停，等待确认"
        return f"⚠️ {label}未完成"

    title = f"### 🔧 {label}"
    if event_type == "tool_call":
        body = [title, "**状态**：执行中"]
        if "input" in event:
            body.extend(("**输入**", _tool_code_block(event.get("input"))))
        return "\n\n".join(body)
    if status == "waiting":
        return f"{title}\n\n**状态**：任务已暂停，等待确认"
    status_text = "已完成" if status in {"success", "ok"} else "未完成"
    body = [title, f"**状态**：{status_text}"]
    if event.get("result") is not None:
        body.extend(("**输出**", _tool_code_block(event.get("result"))))
    return "\n\n".join(body)


async def send_tool_event(payload: dict, event: dict) -> bool:
    """独立发送一条工具状态消息；显示策略由 IM Loop 在调用前决定。"""
    from agent.outbound import sanitize_outbound
    is_qq_plain = (
        payload.get("platform") == "qq"
        and payload.get("message_format") != "markdown"
    )
    is_status_only = is_qq_plain or payload.get("platform") in {"telegram", "wechat"}
    text = format_tool_event(event, markdown=not is_status_only)
    if not text:
        return True
    # 工具状态是过程消息，不应消耗入站消息唯一的 QQ 被动回复机会。
    event_payload = (
        {**payload, "message_id": None}
        if payload.get("platform") == "qq"
        else payload
    )
    return await send_text(event_payload, sanitize_outbound(text))


async def send_reply(payload: dict, reply: PlatformReply) -> bool:
    """将统一回复交给对应 Gateway。"""
    platform = payload.get("platform")
    from agent.outbound import sanitize_im_links
    text = sanitize_im_links(reply.text) if platform in {"qq", "feishu", "wechat", "telegram"} else reply.text
    unsupported = reply.unsupported_capabilities(platform or "")
    if unsupported and platform in {"qq", "feishu", "wechat", "telegram"}:
        from agent.security import logsafe
        print(
            f"[im] {platform} 不支持回复能力: {','.join(unsupported)} "
            f"fp={logsafe.fingerprint(reply.text)}",
            flush=True,
        )
        return False
    if platform == "feishu" and reply.target.id:
        from agent.gateway import feishu
        result = await feishu.send_text(reply.target.id, text, payload.get("channel_id"))
        return result is not False
    elif platform == "qq" and reply.target.id:
        from agent.gateway import qq
        if _qq_reply_budget_exhausted(payload):
            return False
        reply_message_id = _qq_reply_message_id(payload, reply)
        if reply.target.type == "group":
            mention_user_id = payload.get("platform_user_id")
            args = (
                reply.target.id,
                text,
                reply_message_id,
                payload.get("channel_id"),
                payload.get("message_format"),
            )
            if mention_user_id:
                result = await qq.send_group(*args, mention_user_id)
            else:
                result = await qq.send_group(*args)
        else:
            result = await qq.send_c2c(
                reply.target.id,
                text,
                reply_message_id,
                payload.get("channel_id"),
                payload.get("message_format"),
            )
        if result:
            _mark_qq_passive_reply_used(payload, reply_message_id)
        return result
    elif platform == "wechat" and reply.target.id:
        from agent.gateway import wechat
        result = await wechat.send_text(
            reply.target.id,
            text,
            payload.get("channel_id"),
            payload.get("context_token", ""),
        )
        return result is not False
    elif platform == "telegram" and reply.target.id:
        from agent.gateway import telegram
        return await telegram.send_message(
            reply.target.id,
            text,
            channel_id=str(payload.get("channel_id") or ""),
            reply_to_message_id=reply.reply_to_message_id,
        )
    else:
        from agent.security import logsafe
        print(
            f"[im] (无发送通道) {platform}: len={len(reply.text)} "
            f"fp={logsafe.fingerprint(reply.text)}",
            flush=True,
        )
        return False


async def send_file(payload: dict, *, storage_key: str, ext: str, display_name: str, fname: str) -> bool:
    """把一个文件按目标平台发送，返回是否成功。

    调用方（``agent.im.files``）负责解析文件元数据和读取存储；这里只负责
    "这个平台该调哪个 Gateway 函数"这一步，跟文本/流式共用同一个分发入口。
    """
    platform = payload.get("platform")
    if platform == "wechat":
        return await _send_file_wechat(payload, storage_key, ext, fname)
    if platform == "feishu":
        from app.services.storage import get_storage
        data = await get_storage().get(storage_key)
        return await _send_file_feishu(payload, ext, data, fname)
    if platform == "qq":
        return await _send_file_qq(payload, storage_key, ext, display_name, fname)
    if platform == "telegram":
        return await _send_file_telegram(payload, storage_key, fname)
    return False


async def send_png_image(payload: dict, png: bytes) -> bool:
    """通过现有 Gateway 图片接口发送短期内存 PNG，不创建文件库记录。"""
    if not png or len(png) > 3 * 1024 * 1024:
        return False
    platform = payload.get("platform")
    if platform == "feishu":
        from agent.gateway import feishu
        target = payload.get("chat_id") or payload.get("platform_user_id")
        return bool(target) and await feishu.send_file(
            str(target), png, "mermaid-diagram", "png", payload.get("channel_id")
        )
    if platform == "qq":
        from agent.gateway import qq
        group = payload.get("chat_type") == "group"
        target = payload.get("chat_id") if group else payload.get("platform_user_id")
        if not target:
            return False
        # 每张图片与相邻文字是独立气泡；只在被动回复额度耗尽后改为主动发送。
        message_id = (
            None if _qq_reply_budget_exhausted(payload) else payload.get("message_id")
        )
        sent = await qq.send_file(
            str(target), png, "mermaid-diagram", "png", payload.get("channel_id"),
            message_id, group=group,
        )
        if sent:
            _mark_qq_passive_reply_used(payload, message_id)
        return bool(sent)
    if platform == "wechat":
        from agent.gateway import wechat
        target = payload.get("platform_user_id")
        return bool(target) and await wechat.send_image(
            str(target), png, payload.get("context_token", ""), payload.get("channel_id")
        )
    if platform == "telegram":
        from agent.gateway import telegram
        target = payload.get("chat_id") if payload.get("chat_type") == "group" else payload.get("platform_user_id")
        return bool(target) and await telegram.send_file(
            str(target), png, "mermaid-diagram.png",
            channel_id=str(payload.get("channel_id") or ""),
            reply_to_message_id=str(payload.get("message_id") or "") or None,
        )
    return False


async def _try_send_png_image(payload: dict, png: bytes) -> bool:
    """媒体 Gateway 异常只降级当前 Mermaid 图，不中断 Agent Run。"""
    try:
        sent = await send_png_image(payload, png)
        if not sent:
            from app.core.redaction import diag_log_raw

            diag_log_raw("agent.im.mermaid.send_image", "status=delivery_failed")
        return sent
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.mermaid.send_image", exc)
        return False


async def _send_file_telegram(payload: dict, storage_key: str, fname: str) -> bool:
    from agent.gateway import telegram
    from app.services.storage import get_storage

    target_id = payload.get("chat_id") if payload.get("chat_type") == "group" else payload.get("platform_user_id")
    if not target_id:
        return False
    data = await get_storage().get(storage_key)
    return await telegram.send_file(
        str(target_id), data, fname, channel_id=str(payload.get("channel_id") or ""),
        reply_to_message_id=str(payload.get("message_id") or "") or None,
    )


async def _send_file_wechat(payload: dict, storage_key: str, ext: str, fname: str) -> bool:
    from agent.gateway import wechat
    from app.services.storage import get_storage

    openid = payload.get("platform_user_id")
    if not openid:
        return False
    data = await get_storage().get(storage_key)
    if len(data) > _WECHAT_FILE_MAX:
        return False
    context_token = payload.get("context_token", "")
    is_image = (ext or "").lower() in _FEISHU_IMAGE_EXTS
    if is_image:
        ok = await wechat.send_image(openid, data, context_token, payload.get("channel_id"))
        label = "图片"
    else:
        ok = await wechat.send_file(openid, data, fname, context_token, payload.get("channel_id"))
        label = "文件"
    from agent.security import logsafe
    print(
        f"[im] wechat 发{label} fp={logsafe.fingerprint(fname)}: "
        f"{'ok' if ok else '失败'}（{len(data)} bytes）",
        flush=True,
    )
    return ok


async def _send_file_feishu(payload: dict, ext: str, data: bytes, fname: str) -> bool:
    from agent.gateway import feishu
    from agent.security import logsafe

    is_image = (ext or "").lower() in _FEISHU_IMAGE_EXTS
    limit = _FEISHU_IMAGE_MAX if is_image else _FEISHU_FILE_MAX
    if len(data) > limit:
        mb, lim_mb = len(data) / 1048576, limit // 1048576
        print(
            f"[im] feishu 发文件 fp={logsafe.fingerprint(fname)}: "
            f"跳过（{mb:.1f}MB > {lim_mb}MB 上限）",
            flush=True,
        )
        return False
    display_name = fname.rsplit(".", 1)[0] if "." in fname else fname
    ok = await feishu.send_file(
        payload.get("chat_id"), data, display_name, ext, payload.get("channel_id")
    )
    print(f"[im] feishu 发文件 fp={logsafe.fingerprint(fname)}: {'ok' if ok else '失败'}", flush=True)
    return ok


async def _send_file_qq(
    payload: dict,
    storage_key: str,
    ext: str,
    display_name: str,
    fname: str,
) -> bool:
    from agent.gateway import qq
    from app.services.storage import get_storage

    is_group = payload.get("chat_type") == "group"
    openid = payload.get("chat_id") if is_group else payload.get("platform_user_id")
    if not openid:
        return False
    if _qq_reply_budget_exhausted(payload):
        return False
    storage = get_storage()
    data = await storage.get(storage_key)
    if len(data) > _QQ_FILE_MAX:
        return False
    file_message_id = payload.get("message_id")
    ok = await qq.send_file(
        openid, data, display_name, ext, payload.get("channel_id"),
        file_message_id, group=is_group,
    )
    if ok:
        _mark_qq_passive_reply_used(payload, file_message_id)
    return ok


def _fix_loose_bold(text: str) -> str:
    """修正 IM markdown 渲染器不接受的宽松加粗写法，代码片段保持原样。"""
    parts = _CODE_SPLIT_RE.split(text)
    for i in range(0, len(parts), 2):
        parts[i] = _BOLD_LEAD_WS_RE.sub(r'**\1**', parts[i])
        parts[i] = _BOLD_TRAIL_WS_RE.sub(r'**\1**', parts[i])
    return ''.join(parts)


async def _send_mermaid_reply_text(payload: dict, text: str) -> str | None:
    """发送一段含 Mermaid 的文本，图像失败时降级回原始 fence。"""
    from agent.im.mermaid import render_reply

    if payload.get("platform") == "qq":
        text_parts = await render_reply(
            text, theme_preferences=payload.get("mermaid_theme_preferences")
        )
        for index, part in enumerate(text_parts):
            if not part.text:
                continue
            previous_part = text_parts[index - 1] if index > 0 else None
            next_part = text_parts[index + 1] if index + 1 < len(text_parts) else None
            previous_diagram = bool(
                previous_part and (
                    previous_part.png is not None
                    or _MERMAID_SOURCE_FENCE_RE.fullmatch(previous_part.text)
                )
            )
            next_diagram = bool(
                next_part and (
                    next_part.png is not None
                    or _MERMAID_SOURCE_FENCE_RE.fullmatch(next_part.text)
                )
            )
            text_value = part.text
            if previous_diagram:
                text_value = text_value.lstrip()
            if next_diagram:
                text_value = text_value.rstrip()
            text_parts[index] = type(part)(
                text=text_value, png=part.png, source=part.source,
                placeholder_emitted=part.placeholder_emitted,
            )
        visible = False
        for part in text_parts:
            if part.png is not None:
                visible = True
                if not await _try_send_png_image(payload, part.png) and part.source:
                    if not await _send_qq_mermaid_text(payload, part.source):
                        return None
            elif part.text.strip():
                visible = True
                if not await _send_qq_mermaid_text(payload, part.text):
                    return None
        return text.strip() if visible else None

    parts = await render_reply(
        text, theme_preferences=payload.get("mermaid_theme_preferences")
    )
    if payload.get("platform") == "wechat":
        # 微信把图和相邻文字作为独立消息发送；去掉图片边界上的围栏换行，
        # 避免 Mermaid 前一条文字气泡底部出现空行。其他平台保持原样。
        for index, part in enumerate(parts):
            if not part.text:
                continue
            previous_image = index > 0 and parts[index - 1].png is not None
            next_image = index + 1 < len(parts) and parts[index + 1].png is not None
            text_value = part.text
            if previous_image:
                text_value = text_value.lstrip()
            if next_image:
                text_value = text_value.rstrip()
            parts[index] = type(part)(
                text=text_value,
                png=part.png,
                source=part.source,
                placeholder_emitted=part.placeholder_emitted,
            )

    delivered: list[str] = []
    for part in parts:
        if part.png is not None:
            if not await _try_send_png_image(payload, part.png) and part.source:
                if not await send_text(payload, part.source):
                    return None
                delivered.append(part.source)
            continue
        if part.text.strip():
            if not await send_text(payload, part.text):
                return None
            delivered.append(part.text)
    return "".join(delivered).strip() or text.strip()


async def _send_completed_parts(payload: dict, parts) -> bool:
    """按解析顺序发送已渲染的文本与图片 part。"""
    for part in parts:
        if part.png is not None:
            if not await _try_send_png_image(payload, part.png) and part.source:
                if not await send_text(payload, part.source):
                    return False
        elif part.text.strip() and not await send_text(payload, part.text):
            return False
    return True


async def send_completed_round(payload: dict, text: str) -> bool:
    """发送已完成的 IM 回复轮次，并把 Mermaid 图表作为独立图片消息发送。"""
    return await _send_mermaid_reply_text(payload, text) is not None


async def send_agent_response(
    payload: dict,
    response: AgentResponse,
    *,
    already_sent_rounds: int | Set[int] = 0,
    show_intermediate_replies: bool = True,
) -> str | None:
    """统一收尾一轮 AgentResponse：先发送附件，再按 round 发送文本说明。

    IM Loop 不再分别判断平台、文件和文本入口；平台 capability 由
    ``send_reply``/``send_file`` 统一检查，返回最终实际发送的文本。
    """
    from agent.im.files import send_files

    result = await send_files(payload, response.files)
    if result.failed:
        # 附件失败提示是合成消息，不属于 Agent round index 域，不能参与
        # already_sent_rounds 去重，否则 round 0 已即时发送时会吞掉失败提示。
        failure_text = result.reason or "附件没有成功发出，你可以去网页或文件库查看。"
        return failure_text if await send_text(payload, failure_text) else None
    else:
        response_text = _fix_loose_bold(response.text or "").strip()
        if show_intermediate_replies:
            texts = [
                _fix_loose_bold(text)
                for text in (response.round_texts or [])
                if str(text or "").strip()
            ]
            if not texts and not response.errored:
                texts = [response_text] if response_text else (["给你～"] if response.files else ["嗯~在的，你说～"])
        else:
            # 关闭中间回复时忽略 round_texts，只发送 text（最后一轮正文）。
            # 生成失败时 text 是独立错误提示，仍由下方错误收尾逻辑发送。
            texts = [] if response.errored else (
                [response_text] if response_text else (["给你～"] if response.files else ["嗯~在的，你说～"])
            )

    # 每个 round 独立发送；图表按文本位置发送，失败时回退为原始 fence。
    last_text = ""
    if isinstance(already_sent_rounds, int):
        sent_indices = set(range(max(0, already_sent_rounds)))
    else:
        sent_indices = {index for index in already_sent_rounds if index >= 0}
    for index, text in enumerate(texts):
        if index in sent_indices:
            continue
        delivered_text = await _send_mermaid_reply_text(payload, text)
        if delivered_text is None:
            return None
        last_text = delivered_text or response_text or last_text

    # 生成失败时，response.text 是新的错误提示，而 round_texts 只是失败前已经
    # 生成的正文。它们属于两个不同的出站消息域：即使所有正文 round 都已发送，
    # 也必须单独把错误提示发出去，不能被 round 去重吞掉。
    if response.errored:
        if response_text and response_text != last_text:
            return response_text if await _send_mermaid_reply_text(payload, response_text) is not None else None
        return response_text or last_text or None
    return response_text or last_text
