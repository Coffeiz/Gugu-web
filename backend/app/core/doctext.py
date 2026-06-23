"""二进制文档 → 文本提取：让咕咕能读 PDF / Office 的内容。

- PDF → `pdftotext`（poppler，快）
- docx/doc/odt/rtf → LibreOffice 转 txt
- xlsx/xls/ods → LibreOffice 转 csv
- pptx/ppt/odp → LibreOffice 转 pdf 再 pdftotext（幻灯片直接转 txt 不可靠）

`read_file`（文件库）与 `chat_attach`（聊天附件）共用。无新依赖：pdftotext + libreoffice 均为系统命令。
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

MAX_CHARS = 200_000          # 提取文本上限，防止撑爆上下文
EXTRACT_MAX_BYTES = 30 * 1024 * 1024  # 可提取文档的原文件大小上限


async def _run(cmd: list[str], stdin: bytes | None = None, timeout: int = 120):
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
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


async def _lo_convert(data: bytes, src_ext: str, target: str) -> bytes:
    """LibreOffice headless 转换。target 如 'txt:Text'/'csv'/'pdf'，返回结果字节。"""
    tmp = Path(tempfile.mkdtemp())
    try:
        src = tmp / f"input.{src_ext}"
        src.write_bytes(data)
        rc, _, err = await _run([
            "libreoffice", "--headless", "--convert-to", target,
            "--outdir", str(tmp), str(src),
        ])
        out = tmp / f"input.{target.split(':')[0]}"
        if rc != 0 or not out.exists():
            raise RuntimeError("LibreOffice 转换失败：" + err.decode(errors="replace")[:120])
        return out.read_bytes()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def extract_text(data: bytes, ext: str) -> str:
    """把文档字节提取成文本。文本类直接 decode；PDF/Office 走工具。失败抛异常。截到 MAX_CHARS。"""
    e = (ext or "").lower()
    if e in PDF_EXTS:
        text = await _pdftotext(data)
    elif e in DOC_EXTS:
        text = (await _lo_convert(data, e, "txt:Text")).decode("utf-8", errors="replace")
    elif e in SHEET_EXTS:
        text = (await _lo_convert(data, e, "csv")).decode("utf-8", errors="replace")
    elif e in SLIDE_EXTS:
        text = await _pdftotext(await _lo_convert(data, e, "pdf"))
    else:
        text = data.decode("utf-8", errors="replace")   # 文本类
    return text[:MAX_CHARS]
