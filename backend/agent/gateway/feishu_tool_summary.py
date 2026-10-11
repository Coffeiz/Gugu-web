"""飞书流式回复中的工具摘要卡片状态与元素构建。"""
from __future__ import annotations

from collections.abc import Awaitable, Callable

_MAX_VISIBLE_TOOL_CALLS = 24
_MAX_TOOL_DETAIL_CHARS = 1200
_MAX_CARD_COMPONENTS = 180


def _tool_detail_block(value: object) -> str:
    """复用 IM 工具详情的长度与代码块格式，再处理卡片出站内容。"""
    from agent.im.replies import _tool_code_block
    from agent.outbound import sanitize_outbound

    code_block = _tool_code_block(value, limit=_MAX_TOOL_DETAIL_CHARS)
    fence, body = code_block.split("\n", 1)
    body = body.removesuffix("\n```").replace("```", "` ` `")
    return f"{fence}\n{sanitize_outbound(body)}\n```"


def _component_count(value: object) -> int:
    if isinstance(value, dict):
        return int("tag" in value) + sum(_component_count(item) for item in value.values())
    if isinstance(value, list):
        return sum(_component_count(item) for item in value)
    return 0


class FeishuToolSummaryStream:
    """维护单轮 Feishu Card 2.0 的有序回复/工具摘要元素。"""

    def __init__(self, placeholder: str = "咕咕正在想…") -> None:
        self._blocks: list[dict] = [{
            "kind": "assistant",
            "id": "markdown_1",
            "text": placeholder,
            "placeholder": True,
        }]
        self._active_text_id: str | None = "markdown_1"
        self._next_text_id = 2
        self._tool_blocks: dict[str, tuple[int, int]] = {}
        self._active_tool_group_index: int | None = None
        self._visible_tool_calls = 0
        self._omitted_tool_calls = 0
        self._writer: Callable[[list[dict]], Awaitable[bool]] | None = None
        self._failed = False

    @property
    def healthy(self) -> bool:
        return not self._failed

    @property
    def active_text_id(self) -> str | None:
        return self._active_text_id

    @property
    def active_text(self) -> str:
        for block in reversed(self._blocks):
            if block.get("kind") == "assistant" and block.get("id") == self._active_text_id:
                return str(block.get("text") or "")
        return ""

    def bind(self, writer: Callable[[list[dict]], Awaitable[bool]]) -> None:
        self._writer = writer

    def append_text(self, text: str) -> bool:
        """追加正文；返回是否新建了需先整卡写入的 Markdown 元素。"""
        if not text:
            return False
        self._active_tool_group_index = None
        block = next((
            item for item in reversed(self._blocks)
            if item.get("kind") == "assistant" and item.get("id") == self._active_text_id
        ), None)
        if block is None:
            block = {
                "kind": "assistant",
                "id": f"markdown_{self._next_text_id}",
                "text": "",
            }
            self._next_text_id += 1
            self._blocks.append(block)
            self._active_text_id = block["id"]
            needs_card_update = True
        else:
            needs_card_update = bool(block.pop("placeholder", False))
            if needs_card_update:
                block["text"] = ""
        block["text"] += text
        return needs_card_update

    def end_round(self) -> None:
        self._active_text_id = None
        self._active_tool_group_index = None

    async def handle_tool_event(self, event: dict) -> bool:
        """处理工具事件；未绑定卡片时返回 False 供调用方沿用文本消息回退。"""
        if self._writer is None:
            return False

        event_type = str(event.get("type") or "")
        call_id = str(event.get("tool_call_id") or "").strip()
        if event_type not in {"tool_call", "tool_done"}:
            return True

        location = self._tool_blocks.get(call_id) if call_id else None
        if location is not None:
            group_index, tool_index = location
            prior = self._blocks[group_index]["tools"][tool_index]
            merged = dict(prior)
            merged.update(event)
            self._blocks[group_index]["tools"][tool_index] = merged
        else:
            self._append_tool_event(event, call_id)
        await self._write()
        return True

    def _append_tool_event(self, event: dict, call_id: str) -> None:
        if self._visible_tool_calls >= _MAX_VISIBLE_TOOL_CALLS:
            self._omitted_tool_calls += 1
            self._active_text_id = None
            return
        if self._blocks and self._blocks[-1].get("placeholder"):
            self._blocks.pop()
        self._active_text_id = None
        if self._active_tool_group_index is not None:
            group = self._blocks[self._active_tool_group_index]
        else:
            group = {"kind": "tool_summary", "tools": []}
            self._blocks.append(group)
            self._active_tool_group_index = len(self._blocks) - 1
        tool_index = len(group["tools"])
        group["tools"].append(dict(event))
        self._visible_tool_calls += 1
        if call_id:
            self._tool_blocks[call_id] = (self._active_tool_group_index, tool_index)

    def finish(self, text: str, *, cancelled: bool = False) -> None:
        """将最终清洗正文合入最后一段，并收束未完成工具状态。"""
        if self._blocks and self._blocks[-1].get("placeholder"):
            self._blocks.pop()
            self._active_text_id = None
        if cancelled:
            for block in self._blocks:
                for index, event in enumerate(block.get("tools", [])):
                    if event.get("type") == "tool_call" and event.get("status") in {"queued", "running"}:
                        updated = dict(event)
                        updated["status"] = "cancelled"
                        block["tools"][index] = updated
            return
        text = str(text or "")
        if not text:
            return
        if self._active_text_id:
            for block in reversed(self._blocks):
                if block.get("kind") == "assistant" and block.get("id") == self._active_text_id:
                    block["text"] = text
                    return
        self.append_text(text)

    async def flush(self) -> bool:
        return await self._write()

    def mark_failed(self) -> None:
        self._failed = True

    async def _write(self) -> bool:
        if self._writer is None or self._failed:
            return False
        try:
            result = await self._writer(self.elements())
        except Exception:
            self._failed = True
            return False
        if not result:
            self._failed = True
        return bool(result)

    def elements(self) -> list[dict]:
        elements: list[dict] = []
        for block in self._blocks:
            if block["kind"] == "assistant":
                text = str(block.get("text") or "")
                if not text:
                    continue
                from agent.gateway.feishu import _build_card_elements, _md_to_bold

                if block.get("id") == self._active_text_id:
                    candidates = [{
                        "tag": "markdown",
                        "content": _md_to_bold(text),
                        "element_id": block["id"],
                    }]
                else:
                    candidates = _build_card_elements(text)
                    for candidate in candidates:
                        candidate.pop("element_id", None)
                if _component_count(elements) + _component_count(candidates) > _MAX_CARD_COMPONENTS:
                    # 保留整段正文，但不再将超量表格拆成大量卡片元素。
                    candidates = [{"tag": "markdown", "content": _md_to_bold(text)}]
                elements.extend(candidates)
            elif block["kind"] == "tool_summary":
                panel = self._tool_summary_panel(block["tools"])
                if _component_count(elements) + _component_count(panel) <= _MAX_CARD_COMPONENTS:
                    elements.append(panel)
            elif block["kind"] == "omitted":
                elements.append({
                    "tag": "markdown",
                    "content": f"_另有 {self._omitted_tool_calls} 个工具调用摘要未展示。_",
                })

        if self._omitted_tool_calls:
            notice = {
                "tag": "markdown",
                "content": f"_另有 {self._omitted_tool_calls} 个工具调用摘要未展示。_",
            }
            if not any("未展示" in str(item.get("content") or "") for item in elements):
                if _component_count(elements) + 1 <= _MAX_CARD_COMPONENTS:
                    elements.append(notice)
                else:
                    elements[-1:] = [notice]
        if not elements:
            elements = [{"tag": "markdown", "content": " "}]
        return elements

    @classmethod
    def _tool_summary_panel(cls, events: list[dict]) -> dict:
        return {
            "tag": "collapsible_panel",
            "expanded": False,
            "background_color": "grey",
            "border": {"color": "grey", "corner_radius": "8px"},
            "header": {
                "title": {
                    "tag": "plain_text",
                    "content": f"🛠 工具摘要 ({len(events)})",
                },
            },
            "padding": "8px 12px",
            "elements": [
                {"tag": "markdown", "content": cls._tool_entry(event)}
                for event in events
            ],
        }

    @staticmethod
    def _tool_entry(event: dict) -> str:
        from agent.outbound import sanitize_outbound

        label = " ".join(str(event.get("label") or event.get("name") or "工具").split())[:80]
        status = str(event.get("status") or "")
        if event.get("type") == "tool_call":
            status_label, icon = {
                "queued": ("排队中", "⏳"),
                "running": ("执行中", "⏳"),
                "invalid": ("未执行", "⚠️"),
                "cancelled": ("已停止", "⏹️"),
            }.get(status, ("执行中", "⏳"))
        else:
            status_label, icon = {
                "success": ("已完成", "✅"),
                "ok": ("已完成", "✅"),
                "waiting": ("等待确认", "⏸️"),
                "cancelled": ("已停止", "⏹️"),
            }.get(status, ("未完成", "⚠️"))

        details = [f"**{icon} {label} · {status_label}**", f"**状态**：{status_label}"]
        if "input" in event:
            details.extend(("**输入**", _tool_detail_block(event.get("input"))))
        if event.get("result") is not None:
            details.extend(("**结果**", _tool_detail_block(event.get("result"))))
        detail_text = sanitize_outbound("\n\n".join(details))
        if len(detail_text) > _MAX_TOOL_DETAIL_CHARS * 2:
            detail_text = detail_text[: _MAX_TOOL_DETAIL_CHARS * 2 - 1] + "…"
        return detail_text
