"""飞书卡片 Markdown 与卡片数据格式化。"""
from __future__ import annotations

import json
import re

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


def _make_card_payload(text: str, title: str = "咕咕思考中", color: str = "blue",
                       streaming_mode: bool = True,
                       elements: list[dict] | None = None) -> str:
    """构造 CardKit 卡片 2.0 的 data 字段（JSON 字符串）。

    OpenAPI 要求 schema 2.0 的内嵌 card JSON 必须有 schema + header + body 结构：
        {"schema": "2.0", "header": {...}, "body": {"elements": [...]}}
    顶层直接放 elements 会触发 99992402（field validation failed），
    而不带 body 包络时串化整个对象做 form 又会让飞书网关解析成 body is nil。

    config.streaming_mode=true 让服务端启用 typewriter 渲染（飞书 7.20+ 支持，spec
    streaming-updates-openapi-overview）；先开是默认行为，收尾改标题时传 False 关掉。
    """
    return json.dumps({
        "schema": "2.0",
        "update_multi": True,   # CardKit 流式更新要求 update_multi=true（官方 spec 300302）
        "config": {
            "streaming_mode": streaming_mode,
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
            "elements": elements if elements is not None else _build_card_elements(text),
        },
    }, ensure_ascii=False)
