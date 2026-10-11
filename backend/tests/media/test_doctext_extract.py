"""doctext 纯 Python 提取（LibreOffice 移除后的替代路径）。

覆盖 docx/xlsx/pptx 生成 → 提取的往返；xls/odt/ods/rtf 依赖只装不造数据，
冒烟校验模块可导入即可。
"""
from __future__ import annotations

import io

import pytest

from app.core.doctext import extract_text


def _make_docx() -> bytes:
    import docx

    document = docx.Document()
    document.add_paragraph("第一段正文")
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "甲"
    table.rows[0].cells[1].text = "乙"
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _make_xlsx() -> bytes:
    import openpyxl

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "数据"
    sheet.append(["名称", "数量"])
    sheet.append(["苹果", 3])
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _make_pptx() -> bytes:
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[1])
    slide.shapes.title.text = "标题页"
    body = slide.placeholders[1]
    body.left = Inches(1)
    body.text = "第一行要点"
    buffer = io.BytesIO()
    presentation.save(buffer)
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_extract_docx_paragraphs_and_tables():
    text = await extract_text(_make_docx(), "docx")
    assert "第一段正文" in text
    assert "甲\t乙" in text


@pytest.mark.asyncio
async def test_extract_xlsx_rows():
    text = await extract_text(_make_xlsx(), "xlsx")
    assert "## 数据" in text
    assert "名称\t数量" in text
    assert "苹果\t3" in text


@pytest.mark.asyncio
async def test_extract_pptx_shapes():
    text = await extract_text(_make_pptx(), "pptx")
    assert "标题页" in text
    assert "第一行要点" in text


@pytest.mark.asyncio
async def test_legacy_doc_ppt_rejected_with_clear_hint():
    with pytest.raises(RuntimeError, match="另存为"):
        await extract_text(b"whatever", "doc")
    with pytest.raises(RuntimeError, match="另存为"):
        await extract_text(b"whatever", "ppt")
