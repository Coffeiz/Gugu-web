"""Telegram live draft 与 Mermaid 有序发送状态机。"""
from __future__ import annotations

import secrets
import time
from collections.abc import AsyncIterator, Callable

from agent.interactions.events import ROUND_END
from agent.models import AgentResponse


class TelegramDraftRound:
    """管理 Telegram live draft，并在 Mermaid 图片边界切分正式消息。"""

    def __init__(
        self,
        payload: dict,
        *,
        show_intermediate_replies: bool,
        send_text: Callable,
        send_completed_round: Callable,
        try_send_png_image: Callable,
        draft_min_interval: float,
    ) -> None:
        self.payload = payload
        self.show_intermediate_replies = show_intermediate_replies
        self._send_text = send_text
        self._send_completed_round = send_completed_round
        self._try_send_png_image = try_send_png_image
        self._draft_min_interval = draft_min_interval
        self.round_text = ""
        self.draft_id = secrets.randbits(63) or 1
        self.last_update_at = 0.0
        self.last_draft_text = ""
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
            # 首次遇图时先冲刷偏好设置暂存的轮次，再切换到有序分段发送，
            # 确保此前正文、图片及后续正文保持生成顺序。
            self.mermaid_streaming = True
            deferred, self.deferred_rounds = self.deferred_rounds, []
            for round_index, parts in deferred:
                if await self._flush_parts(parts):
                    self.sent_rounds.add(round_index)
                else:
                    self.deferred_rounds.append((round_index, parts))

        # 围栏边界换行不属于前后两段正文，避免图片前后的消息气泡留空行。
        if self.parts and self.parts[-1].text:
            previous = self.parts[-1]
            trimmed = previous.text.rstrip()
            if trimmed:
                self.parts[-1] = ReplyPart(text=trimmed)
            else:
                self.parts.pop()
            self.round_text = self.round_text.rstrip()
        self.parts.append(ReplyPart(png=png, source=source))

        # 草稿只是临时预览。图片到达时按文本 → 图片顺序正式发送，
        # 再换 draft_id，让图片后的正文从新草稿继续预览。
        sent = await self._flush_parts()
        if sent:
            self.parts = []
            self.round_text = ""
        else:
            # 尚未成功交付的 part 保留到轮次收尾重试。
            self.draft_enabled = False
        self.draft_id = secrets.randbits(63) or 1
        self.last_update_at = 0.0
        self.last_draft_text = ""
        self.trim_leading_segment = True

    async def finish_round(self, text: str) -> None:
        round_has_content = bool(text.strip() or self.parts or self.round_has_image)
        # Token 更新受 Telegram draft 限频；轮次结束前强制推送尾部，避免最后一段代码
        # 因为没有后续 token 触发节流窗口而只在正式消息中出现。
        await self._update_draft(force=True)
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
            self.last_draft_text = ""
        self.round_has_image = False
        self.trim_leading_segment = False
        self.last_update_at = 0.0
        self.round_text = ""
        self.parts = []

    async def finish_response(self, response: AgentResponse) -> None:
        """关闭 final 前尚未收到 round_end 的尾轮，避免统一出口重复交付。"""
        if not (self.round_text.strip() or self.parts or self.round_has_image):
            return
        round_texts = response.round_texts or []
        final_text = round_texts[-1] if round_texts else response.text
        await self.finish_round(str(final_text or ""))

    async def _flush_parts(self, parts=None) -> bool:
        """按序发送文字/图片段，只移除已确认送达的 part。"""
        pending = self.parts if parts is None else parts
        while pending:
            part = pending[0]
            if part.png is not None:
                sent = await self._try_send_png_image(self.payload, part.png)
                if not sent and part.source:
                    sent = await self._send_text(self.payload, part.source)
            elif part.text.strip():
                sent = await self._send_completed_round(self.payload, part.text)
            else:
                sent = True
            if not sent:
                return False
            pending.pop(0)
        return True

    async def _update_draft(self, *, force: bool = False) -> None:
        if not self.draft_enabled or not self.round_text.strip():
            return
        if force and self.round_text == self.last_draft_text:
            return
        elapsed = time.monotonic() - self.last_update_at
        if not force and self.last_update_at and elapsed < self._draft_min_interval:
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
            self.last_draft_text = self.round_text
        else:
            # 草稿 API 不可用时继续消费 Agent 流，末尾仍发送正式回复。
            self.draft_enabled = False


async def send_telegram_stream_by_round(
    payload: dict,
    token_iter: AsyncIterator[tuple[str, object]],
    *,
    show_intermediate_replies: bool,
    send_text: Callable,
    send_completed_round: Callable,
    try_send_png_image: Callable,
    draft_min_interval: float,
) -> tuple[AgentResponse, set[int]]:
    """以草稿预览生成过程；遇到 Mermaid 后按图文顺序正式流式交付。"""
    sender = TelegramDraftRound(
        payload,
        show_intermediate_replies=show_intermediate_replies,
        send_text=send_text,
        send_completed_round=send_completed_round,
        try_send_png_image=try_send_png_image,
        draft_min_interval=draft_min_interval,
    )
    from agent.im.mermaid import ProgressiveMermaidTokenFilter

    token_iter = ProgressiveMermaidTokenFilter(
        theme_preferences=payload.get("mermaid_theme_preferences"),
    ).ordered_events(token_iter)
    response: AgentResponse | None = None
    async for kind, value in token_iter:
        if kind == "final" and isinstance(value, AgentResponse):
            response = value
            await sender.finish_response(value)
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
        final_round_index = expected_rounds - 1
        if expected_rounds and final_round_index in sender.sent_rounds:
            # 隐藏中间回复模式的统一出口只会发送 response.text（最后一轮）。
            # 之前轮次交付失败不应导致最后一轮已经送达后又重发一次。
            sender.sent_rounds = {0}
        else:
            # 最后一轮未完整送达时，由统一出口补发 response.text。
            sender.sent_rounds.clear()
    return response, sender.sent_rounds
