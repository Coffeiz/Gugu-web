"""QQ 私聊流式回复生命周期与 Mermaid 分段交付。"""
from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Tuple

from agent.gateway.qq.client import QQStreamFinalizationError
from agent.interactions.events import ROUND_END
from agent.models import AgentResponse


class QQMermaidRound:
    """维护 QQ 私聊流及图文分段回退。"""

    def __init__(
        self,
        payload: dict,
        *,
        show_intermediate_replies: bool,
        send_text: Callable,
        try_send_png_image: Callable,
        send_mermaid_text: Callable,
        fix_loose_bold: Callable[[str], str],
    ) -> None:
        from agent.gateway import qq

        self.payload = payload
        self._send_text = send_text
        self._try_send_png_image = try_send_png_image
        self._send_mermaid_text = send_mermaid_text
        self._fix_loose_bold = fix_loose_bold
        # 保留参数兼容旧入口；QQ 私聊流开关决定是否启用流式发送。
        self.stream_kwargs = {
            "channel_id": payload.get("channel_id") or "",
            "message_id": payload.get("message_id"),
        }
        self._qq = qq
        self.stream_failed = False
        self.stream = self._new_stream()
        self.stream_sent = False
        self.last_text = ""
        self.round_text = ""
        self.segment_text = ""
        self.pending_whitespace = ""
        self.round_has_image = False
        self.trim_leading_segment = False
        self.stream_message_id: str | None = None

    def _new_stream(self):
        # 每个文本段是独立气泡；被动回复窗口/次数由 QQ 响应决定，触发限制时网关回退主动发送。
        if not self.payload.get("message_id"):
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
        final_text = self._fix_loose_bold(final_text or "")
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
            self.round_text.strip() or self.segment_text.strip() or self.round_has_image
        )
        if has_pending_output:
            if not self.round_text.strip() and final_text.strip() and not self.round_has_image:
                # 即使没有 token 事件，也要通过相同 Mermaid 解析和图文发送路径。
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
            # 只在流中完全没有交付内容时才补偿终态正文，避免重复已发送的文字和图。
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
        return self.stream_sent

    def _fail_stream(self) -> None:
        self._record_stream_delivery()
        self.stream_failed = True
        self.stream = None

    async def recover_after_stream_error(self) -> bool:
        """切换到普通文字发送，继续排空已生成内容，避免重发已发送图片。"""
        self._fail_stream()
        await self._finish_text_segment()
        return self.stream_sent

    async def _finish_text_segment(self, *, trim_end: bool = False) -> None:
        if trim_end:
            # 已展示的流式前缀不可回改；只丢弃还未推送的尾部空白。
            self.pending_whitespace = ""
        if not self.segment_text.strip():
            self.segment_text = ""
            return
        if self.stream is None:
            if self.stream_failed:
                text = self.segment_text
                self.segment_text = ""
                try:
                    payload = self.payload
                    if await self._send_text(payload, text):
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
            # 仅回退尚未确认送达的尾部，不能重发已成功推送的流正文。
            delivered = str(getattr(stream, "last_sent_text", "") or "")
            if stream.has_sent():
                self.stream_sent = True
                self.segment_text = (
                    text[len(delivered):]
                    if delivered and text.startswith(delivered)
                    else ""
                )
            raise
        self.stream_sent = self.stream_sent or self.stream.has_sent()
        self.segment_text = ""

    async def _emit_parts(self, parts) -> None:
        for part in parts:
            if part.png is not None:
                self.round_has_image = True
                try:
                    await self._finish_text_segment(trim_end=True)
                except QQStreamFinalizationError:
                    raise
                except Exception as exc:
                    from app.core.redaction import diag_log

                    diag_log("agent.im.qq_stream_transport", exc)
                    self._fail_stream()
                    await self._finish_text_segment(trim_end=True)
                image_sent = await self._try_send_png_image(self.payload, part.png)
                if image_sent:
                    self.stream_sent = True
                elif part.source:
                    if not await self._send_mermaid_text(self.payload, part.source):
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
    payload: dict,
    token_iter: AsyncIterator[tuple[str, object]],
    *,
    show_intermediate_replies: bool,
    sender_factory: Callable,
    fix_loose_bold: Callable[[str], str],
) -> Tuple[bool, AgentResponse, str]:
    """按 Agent 事件推进 QQ 流状态，并持续消费发送失败后的剩余事件。"""
    sender = sender_factory(payload, show_intermediate_replies=show_intermediate_replies)
    from agent.im.mermaid import ProgressiveMermaidTokenFilter

    token_iter = ProgressiveMermaidTokenFilter(
        theme_preferences=payload.get("mermaid_theme_preferences"),
    ).ordered_events(token_iter)
    response: AgentResponse | None = None
    transport_error: Exception | None = None

    async for kind, value in token_iter:
        if kind == "final" and isinstance(value, AgentResponse):
            response = value
            continue
        if isinstance(transport_error, QQStreamFinalizationError):
            # 继续消费模型终态以完成持久化，但关闭失败后不再发送其他分段。
            continue
        try:
            if kind == "token":
                await sender.push_token(str(value or ""))
            elif kind == "mermaid_image":
                await sender.push_image(value)
            elif kind == ROUND_END:
                await sender.finish_round(str(value or ""))
        except Exception as exc:
            if transport_error is None or isinstance(exc, QQStreamFinalizationError):
                transport_error = exc
            sender._fail_stream()

    response = response or AgentResponse()
    last_text = fix_loose_bold(response.text or "")
    if response.cancelled:
        # 取消终态正文为空是有意设计；结束已输出的流，不要补发普通空回复兜底。
        last_text = ""
    elif not last_text.strip():
        last_text = "给你～" if response.files else "嗯~在的，你说～"
    if transport_error is not None:
        from app.core.redaction import diag_log

        diag_log("agent.im.qq_stream_transport", transport_error)
        if isinstance(transport_error, QQStreamFinalizationError):
            raise transport_error
    # 错误终态由 dispatch_finalization 作为普通消息发送。若把 response.text
    # 也交给流式 sender，终态错误会先进入流，再由失败收尾路径发送第二次。
    stream_final_text = "" if response.errored else last_text
    try:
        stream_sent, last_text = await sender.finish_response(stream_final_text)
    except QQStreamFinalizationError:
        # 可见前缀不代表流已关闭；不能回退后把该 Run 标记为成功送达。
        raise
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.qq_stream_transport", exc)
        return await sender.recover_after_stream_error(), response, last_text
    return stream_sent, response, last_text
