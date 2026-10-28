"""QQ 私聊流式回复生命周期与 Mermaid 分段交付。"""
from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Tuple

from agent.gateway.qq.client import QQStreamFinalizationError
from agent.interactions.events import ROUND_END
from agent.models import AgentResponse


@dataclass(slots=True)
class _FinalDeliveryState:
    text_sent: bool = False
    response_text: str = ""
    candidate: bool = False
    prefix_sent: bool = False
    uncertain: bool = False
    last_round_delivered: bool = False
    last_round_had_output: bool = False


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
        self.active_payload = {**payload, "message_id": None}
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
        self.final_delivery = _FinalDeliveryState()
        self.last_text = ""
        self.round_text = ""
        self.segment_text = ""
        self.pending_whitespace = ""
        self.round_has_image = False
        self.round_has_delivered_output = False
        self.trim_leading_segment = False
        self.stream_message_id: str | None = None
        self.pending_round_end = False
        self.pending_round_text = ""

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

    async def finish_round(
        self,
        final_text: str = "",
        *,
        start_next: bool = True,
        allow_rewrite: bool = False,
    ) -> bool:
        final_text = self._fix_loose_bold(final_text or "")
        if not self.round_text.strip() and final_text.strip() and not self.round_has_image:
            self.segment_text = final_text.strip()
            self.round_text = self.segment_text
            if self.stream is not None:
                self.stream.push(self.segment_text)
        self.pending_whitespace = ""
        delivered = await self._finish_text_segment(allow_rewrite=allow_rewrite)
        self.final_delivery.last_round_delivered = delivered
        self.final_delivery.last_round_had_output = self.round_has_delivered_output
        self.last_text = final_text.strip() or self.round_text.strip() or self.last_text
        self._reset_round()
        if start_next:
            self.stream = self._new_stream()
        return delivered

    async def finish_response(self, final_text: str) -> tuple[bool, str]:
        final_text = self._fix_loose_bold(final_text or "").strip()
        self.final_delivery.response_text = final_text
        self.final_delivery.candidate = False
        has_pending_output = bool(
            self.round_text.strip() or self.segment_text.strip() or self.round_has_image
        )
        if has_pending_output:
            await self._finish_pending_response(final_text)
        elif final_text and final_text != self.last_text:
            # 之前中间轮送达不等于最终正文送达；无终态 token 时独立补发最终内容。
            await self._send_final_text(final_text)
        elif final_text and self.final_delivery.last_round_delivered:
            # 只有完整结束且与终态正文相同的轮次，才能计为最终正文已送达。
            self.final_delivery.candidate = True
        self.pending_round_end = False
        self.pending_round_text = ""
        if self.stream is not None:
            self.stream_sent = self.stream_sent or self.stream.has_sent()
        self.final_delivery.text_sent = bool(
            self.final_delivery.candidate and final_text and self.last_text == final_text
        )
        return self.final_delivery.text_sent, self.last_text

    async def _finish_pending_response(self, final_text: str) -> None:
        current_text = self._fix_loose_bold(self.round_text or "").strip()
        if not current_text and final_text and not self.round_has_image:
            # 即使没有 token 事件，也要通过相同 Mermaid 解析和图文发送路径。
            await self._send_final_text(final_text)
            return
        if self._matches_final_round(current_text, final_text):
            await self._finish_final_round(current_text, final_text)
            return
        # ROUND_END 可能只是工具调用前的阶段性正文。若这轮没有后续 token，
        # 终态可以修订已流出的内容；在同一条 QQ replace 流里覆盖并结束即可。
        if self.pending_round_end and final_text and not self.round_has_image:
            self.round_text = final_text
            self.segment_text = final_text
            self.pending_whitespace = ""
            await self._finish_final_round(current_text, final_text)
            return
        # 没有待收束的阶段边界时，保留原来的分段回退语义。
        await self.finish_round(current_text)
        await self._send_final_text(final_text)

    def _matches_final_round(self, current_text: str, final_text: str) -> bool:
        return (
            self.round_has_image
            or current_text == final_text
            or bool(current_text and final_text.startswith(current_text))
        )

    async def _finish_final_round(self, current_text: str, final_text: str) -> None:
        if self.round_has_image:
            # response.text 仍含原始 Mermaid 源码；流式 renderer 已将其替换为图片，
            # 当前轮中仅保留 renderer 实际输出的普通文本，不从原文补写源码。
            delivered = await self.finish_round(current_text, start_next=False)
            self.final_delivery.candidate = (
                delivered and self.final_delivery.last_round_had_output
            )
            if self.final_delivery.candidate:
                self.last_text = final_text
            return
        # 最终 token 可能只覆盖正文前缀；收尾时把可确认的最终后缀补入当前流。
        if final_text.startswith(current_text) and final_text != current_text:
            self.round_text = final_text
            self.segment_text += final_text[len(current_text):]
        self.final_delivery.candidate = True
        delivered = await self.finish_round(
            final_text, start_next=False, allow_rewrite=True,
        )
        self.final_delivery.candidate = delivered

    async def _send_final_text(self, final_text: str) -> None:
        if not final_text:
            return
        from agent.im.mermaid import render_reply

        parts = await render_reply(
            final_text,
            theme_preferences=self.payload.get("mermaid_theme_preferences"),
        )
        await self._emit_parts(parts)
        delivered = await self._finish_text_segment(trim_end=any(part.png for part in parts))
        self.last_text = final_text
        if delivered:
            self.final_delivery.candidate = True

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
        delivered = await self._finish_text_segment()
        if delivered and self.final_delivery.candidate and self.final_delivery.response_text:
            self.last_text = self.final_delivery.response_text
            self.final_delivery.text_sent = True
        return self.final_delivery.text_sent

    async def _finish_text_segment(
        self,
        *,
        trim_end: bool = False,
        allow_rewrite: bool = False,
    ) -> bool:
        if trim_end:
            # 已展示的流式前缀不可回改；只丢弃还未推送的尾部空白。
            self.pending_whitespace = ""
        if not self.segment_text.strip():
            self.segment_text = ""
            return True
        if self.stream is None:
            if self.stream_failed:
                text = self.segment_text
                try:
                    payload = self.active_payload
                    if not await self._send_text(payload, text):
                        # 留给统一最终回复出口重试；此前的中间轮送达不能
                        # 被误当作终态正文已交付。
                        if self.final_delivery.prefix_sent:
                            self.final_delivery.uncertain = True
                        return False
                    self.stream_sent = True
                    self.segment_text = ""
                    self.round_has_delivered_output = True
                except Exception as exc:
                    from app.core.redaction import diag_log

                    diag_log("agent.im.qq_stream_text_recovery", exc)
                    raise
            return True
        stream = self.stream
        text = self.segment_text
        try:
            await stream.finish(text, allow_rewrite=allow_rewrite)
        except Exception:
            self._record_failed_segment(stream, text)
            raise
        self.stream_sent = self.stream_sent or self.stream.has_sent()
        if text.strip():
            self.round_has_delivered_output = True
        self.segment_text = ""
        return True

    def _record_failed_segment(self, stream, text: str) -> None:
        """只在有明确送达前缀时恢复尾部；无法确认则阻止重复发送整段。"""
        if not stream.has_sent():
            # 失败前没有任何文本送达，保留整段供普通回复出口重试。
            self.segment_text = text
            return
        self.stream_sent = True
        delivered = str(getattr(stream, "last_sent_text", "") or "")
        if delivered and text.startswith(delivered):
            self.segment_text = text[len(delivered):]
            self.final_delivery.prefix_sent = self.final_delivery.candidate
            return
        # 没有可验证的送达前缀时，不能把这一段标成完整交付或盲目重发。
        self.segment_text = ""
        self.final_delivery.candidate = False
        self.final_delivery.uncertain = bool(self.final_delivery.response_text)

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
                    self.round_has_delivered_output = True
                elif part.source:
                    if not await self._send_mermaid_text(self.active_payload, part.source):
                        raise RuntimeError("QQ Mermaid 图片和文本回退均发送失败")
                    self.stream_sent = True
                    self.round_has_delivered_output = True
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
        self.round_has_delivered_output = False
        self.pending_round_end = False
        self.pending_round_text = ""

    async def continue_after_round_end(self, text: str = "") -> None:
        """新一轮事件到达时，才把上一轮 ROUND_END 确认为独立消息。"""
        if not self.pending_round_end:
            return
        await self.finish_round(text or self.pending_round_text, start_next=True)


async def send_qq_stream_by_round(
    payload: dict,
    token_iter: AsyncIterator[tuple[str, object]],
    *,
    show_intermediate_replies: bool,
    sender_factory: Callable,
    fix_loose_bold: Callable[[str], str],
) -> Tuple[bool, AgentResponse, str | None]:
    """按 Agent 事件推进 QQ 流状态，并持续消费发送失败后的剩余事件。"""
    sender = sender_factory(payload, show_intermediate_replies=show_intermediate_replies)
    from agent.im.mermaid import ProgressiveMermaidTokenFilter

    token_iter = ProgressiveMermaidTokenFilter(
        theme_preferences=payload.get("mermaid_theme_preferences"),
    ).ordered_events(token_iter)
    response: AgentResponse | None = None
    transport_error: Exception | None = None

    try:
        async for kind, value in token_iter:
            if kind == "final" and isinstance(value, AgentResponse):
                response = value
                continue
            if isinstance(transport_error, QQStreamFinalizationError):
                # 继续消费模型终态以完成持久化，但关闭失败后不再发送其他分段。
                continue
            try:
                if kind in {"token", "mermaid_image"} and sender.pending_round_end:
                    await sender.continue_after_round_end()
                if kind == "token":
                    await sender.push_token(str(value or ""))
                elif kind == "mermaid_image":
                    await sender.push_image(value)
                elif kind == ROUND_END:
                    sender.pending_round_end = True
                    sender.pending_round_text = str(value or "")
            except Exception as exc:
                if transport_error is None or isinstance(exc, QQStreamFinalizationError):
                    transport_error = exc
                sender._fail_stream()
    except BaseException:
        await _close_aborted_qq_stream(sender)
        raise

    if response is None:
        # 事件流正常结束却缺少模型终态时，先关闭已打开的 QQ 流，避免客户端
        # 永久显示生成中；仍向上报告协议错误，不把部分内容误判成成功回复。
        await _close_aborted_qq_stream(sender)
        raise RuntimeError("QQ 回复未收到模型终态")

    return await _finish_qq_stream_run(sender, response, transport_error, fix_loose_bold)


async def _close_aborted_qq_stream(sender) -> None:
    if sender.stream is None or not (
        sender.round_text.strip() or sender.segment_text.strip() or sender.pending_round_text.strip()
    ):
        return
    try:
        await sender.finish_round(
            sender.pending_round_text or sender.round_text,
            start_next=False,
        )
    except BaseException as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.qq_stream_abort_finalize", exc)


async def _finish_qq_stream_run(sender, response, transport_error, fix_loose_bold):
    if response is None:
        raise RuntimeError("QQ 回复未收到模型终态")
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
        return (
            await sender.recover_after_stream_error(),
            response,
            None if sender.final_delivery.uncertain else last_text,
        )
    return (
        stream_sent,
        response,
        None if sender.final_delivery.uncertain else last_text,
    )
