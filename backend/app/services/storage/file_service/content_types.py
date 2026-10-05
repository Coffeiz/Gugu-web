"""文件后缀改名的内容类别判断；仅校验，不转换文件字节。"""
from __future__ import annotations

import mimetypes

from app.core.errors import Invalid

TEXT_EXTS = frozenset({
    "md", "markdown", "txt", "text", "json", "csv", "tsv", "yaml", "yml",
    "xml", "html", "htm", "css", "js", "ts", "jsx", "tsx", "py", "java",
    "c", "cpp", "h", "hpp", "go", "rs", "rb", "php", "sh", "bash", "sql",
    "ini", "toml", "conf", "log", "vue", "svg", "env",
})

_TEXT_APPLICATION_MIMES = frozenset({
    "application/json", "application/xml", "application/javascript",
    "application/typescript", "application/sql", "application/x-sh",
})
_BINARY_EXTS = frozenset({
    "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods",
    "ppt", "pptx", "odp", "pyc",
})


def is_text_file_record(file) -> bool:
    ext = (getattr(file, "ext", "") or "").lower()
    mime = (getattr(file, "mime_type", "") or "").lower()
    return ext in TEXT_EXTS or mime.startswith("text/") or mime in _TEXT_APPLICATION_MIMES \
        or mime.endswith(("+json", "+xml"))


def is_binary_extension(ext: str) -> bool:
    normalized = (ext or "").lower()
    if normalized in TEXT_EXTS:
        return False
    if normalized in _BINARY_EXTS:
        return True
    mime, _ = mimetypes.guess_type(f"file.{normalized}", strict=False)
    if mime is None or mime.startswith("text/") or mime in _TEXT_APPLICATION_MIMES \
            or mime.endswith(("+json", "+xml")):
        return False
    return True


def validated_rename_extension(file, new_ext: str) -> str:
    """拒绝可识别的文本/二进制跨类改名，扩展名未知时保留字节语义。"""
    if (is_text_file_record(file) and is_binary_extension(new_ext)) \
            or (not is_text_file_record(file) and new_ext.lower() in TEXT_EXTS):
        raise Invalid(
            "file.rename_content_type_mismatch",
            "不能仅通过改后缀在文本和二进制类型间转换；改名不会转换文件内容",
        )
    return new_ext
