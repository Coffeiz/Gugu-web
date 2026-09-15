"""二进制文档 → 文本提取：让咕咕能读 PDF / Office 的内容。

- PDF → `pdftotext`（poppler，快）
- docx → python-docx；rtf → striprtf；odt → odfpy
- xlsx → openpyxl；xls → xlrd；ods → odfpy
- pptx → python-pptx（形状/表格/备注文本）

`read_file`（文件库）与 `chat_attach`（聊天附件）共用。
定位决策：LibreOffice 已从镜像移除，Office 提取全部走纯 Python 库；
旧式二进制格式（.doc/.ppt）不再支持，明确提示转存。
"""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path

PDF_EXTS = frozenset({"pdf"})
DOC_EXTS = frozenset({"docx", "doc", "odt", "rtf"})
SHEET_EXTS = frozenset({"xlsx", "xls", "ods"})
SLIDE_EXTS = frozenset({"pptx", "ppt", "odp"})
EXTRACTABLE = PDF_EXTS | DOC_EXTS | SHEET_EXTS | SLIDE_EXTS  # 需工具提取的二进制文档
LEGACY_EXTS = frozenset({"doc", "ppt"})  # 97-2003 二进制格式：无纯 Python 提取方案

MAX_CHARS = 200_000          # 提取文本上限，防止撑爆上下文
EXTRACT_MAX_BYTES = 30 * 1024 * 1024  # 可提取文档的原文件大小上限

_ROW_LIMIT = 5_000     # 单工作表最多提取行数，防超大表格撑爆上下文
_COL_LIMIT = 60        # 单行最多列数
_SHAPE_LIMIT = 500     # 单幻灯片文件最多形状数


async def _run(cmd: list[str], stdin: bytes | None = None, timeout: int = 120):
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if stdin is not None else None,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        # 命令不存在（如服务器没装 pdftotext）。必须区分于「用户文件丢失」，否则
        # 「No such file or directory: 'pdftotext'」会被误读成文件不见了，害得 agent 劝用户删好文件。
        raise RuntimeError(
            f"服务器未安装「{cmd[0]}」命令，无法提取该文档文本——这是服务端环境问题，"
            f"用户的文件本身完好、没有丢失，切勿建议删除或重传。"
        )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("提取超时")
    return proc.returncode, out, err


async def _pdftotext(data: bytes) -> str:
    # 第一个 - = 从 stdin 读 PDF，第二个 - = 文本写到 stdout；-layout 尽量保版面
    rc, out, err = await _run(["pdftotext", "-q", "-layout", "-enc", "UTF-8", "-", "-"], stdin=data)
    if rc != 0:
        raise RuntimeError("pdftotext 失败：" + err.decode(errors="replace")[:120])
    return out.decode("utf-8", errors="replace")


def _extract_docx_sync(data: bytes) -> str:
    import io

    import docx  # python-docx

    document = docx.Document(io.BytesIO(data))
    parts: list[str] = []
    for para in document.paragraphs:
        if para.text.strip():
            parts.append(para.text)
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if any(cells):
                parts.append("\t".join(cells))
    return "\n".join(parts)


def _extract_odt_sync(data: bytes) -> str:
    import io

    from odf import teletype
    from odf.opendocument import load as odf_load
    from odf.text import P

    doc = odf_load(io.BytesIO(data))
    return "\n".join(
        teletype.extractText(p) for p in doc.getElementsByType(P) if teletype.extractText(p).strip()
    )


def _extract_rtf_sync(data: bytes) -> str:
    from striprtf.striprtf import rtf_to_text

    return rtf_to_text(data.decode("latin-1", errors="replace"))


def _cell_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _extract_xlsx_sync(data: bytes) -> str:
    import io

    import openpyxl

    workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    parts: list[str] = []
    for sheet in workbook.worksheets:
        parts.append(f"## {sheet.title}")
        for row in sheet.iter_rows(max_row=_ROW_LIMIT, max_col=_COL_LIMIT, values_only=True):
            if any(value is not None for value in row):
                parts.append("\t".join(_cell_str(value) for value in row))
    return "\n".join(parts)


def _extract_xls_sync(data: bytes) -> str:
    import io

    import xlrd

    workbook = xlrd.open_workbook(file_contents=data)
    parts: list[str] = []
    for sheet in workbook.sheets():
        parts.append(f"## {sheet.name}")
        for row in sheet.get_rows()[:_ROW_LIMIT]:
            values = [_cell_str(cell.value) for cell in row[:_COL_LIMIT]]
            if any(values):
                parts.append("\t".join(values))
    return "\n".join(parts)


def _extract_ods_sync(data: bytes) -> str:
    import io

    from odf.opendocument import load as odf_load
    from odf.table import TableCell, TableRow, Table

    doc = odf_load(io.BytesIO(data))
    parts: list[str] = []
    for table in doc.getElementsByType(Table):
        parts.append(f"## {table.getAttribute('name') or 'sheet'}")
        for row in table.getElementsByType(TableRow)[:_ROW_LIMIT]:
            values: list[str] = []
            for cell in row.getElementsByType(TableCell)[:_COL_LIMIT]:
                repeat = int(cell.getAttribute("numbercolumnsrepeated") or 1)
                text = teletype_text(cell)
                values.extend([text] * min(repeat, _COL_LIMIT - len(values)))
            if any(values):
                parts.append("\t".join(values))
    return "\n".join(parts)


def teletype_text(cell) -> str:
    from odf import teletype

    return teletype.extractText(cell).strip()


def _extract_pptx_sync(data: bytes) -> str:
    import io

    from pptx import Presentation

    presentation = Presentation(io.BytesIO(data))
    parts: list[str] = []
    shape_count = 0
    for index, slide in enumerate(presentation.slides, start=1):
        parts.append(f"## 幻灯片 {index}")
        for shape in slide.shapes:
            shape_count += 1
            if shape_count > _SHAPE_LIMIT:
                return "\n".join(parts)
            if shape.has_text_frame:
                text = shape.text_frame.text.strip()
                if text:
                    parts.append(text)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    cells = [cell.text.strip() for cell in row.cells]
                    if any(cells):
                        parts.append("\t".join(cells))
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                parts.append(f"[备注] {notes}")
    return "\n".join(parts)


async def _extract_in_thread(func, data: bytes) -> str:
    return await asyncio.to_thread(func, data)


async def extract_text(data: bytes, ext: str) -> str:
    """把文档字节提取成文本。文本类直接 decode；PDF/Office 走工具或纯 Python 解析。失败抛异常。截到 MAX_CHARS。"""
    e = (ext or "").lower()
    if e in LEGACY_EXTS:
        raise RuntimeError(
            f"旧式二进制 .{e} 格式已不支持内容提取；文件本身完好，可让用户另存为 .{e}x 等新格式后再试。"
        )
    if e in PDF_EXTS:
        text = await _pdftotext(data)
    elif e == "docx":
        text = await _extract_in_thread(_extract_docx_sync, data)
    elif e in {"odt", "ods"}:
        text = await _extract_in_thread(_extract_ods_sync if e == "ods" else _extract_odt_sync, data)
    elif e == "rtf":
        text = await _extract_in_thread(_extract_rtf_sync, data)
    elif e == "xlsx":
        text = await _extract_in_thread(_extract_xlsx_sync, data)
    elif e == "xls":
        text = await _extract_in_thread(_extract_xls_sync, data)
    elif e == "pptx":
        text = await _extract_in_thread(_extract_pptx_sync, data)
    else:
        text = data.decode("utf-8", errors="replace")   # 文本类
    return text[:MAX_CHARS]
