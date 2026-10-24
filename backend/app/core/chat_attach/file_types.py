"""附件类型分型：按扩展名判断上传文件属于图片 / 音频 / 视频 / 文本 / 二进制。

分型只回答「这是什么文件」，与「当前 Provider 能不能直接吃这个格式」是两件事——
后者由媒体域（`agent/media/`）按 Provider 能力判断。两边分开，暂存侧（app 层）
就不必依赖 Provider 适配层。

音频扩展名合并了「Provider 原生可直传」与「需先转码」两组：分型阶段不区分二者，
是否需要转码由媒体域按当前 Provider 的原生格式集判断。
"""
from __future__ import annotations

import re

# 能被咕咕「读内容」的文本类扩展名
TEXT_EXTS = frozenset({
    "md", "txt", "json", "csv", "yaml", "yml", "log", "py", "js", "ts", "tsx", "jsx",
    "vue", "html", "css", "scss", "java", "go", "rs", "c", "cpp", "h", "hpp", "sh",
    "sql", "xml", "toml", "ini", "conf", "env", "tex",
})

# 图片扩展名。不含 svg——矢量图保留为源码文件，由文件工具按 UTF-8 文本读取，
# 不伪造为视觉图片。
IMAGE_EXTS = frozenset({"png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"})

# 视频理解支持的容器
VIDEO_EXTS = frozenset({"mp4", "mov", "avi", "wmv", "mkv"})

# 音频扩展名 = Provider 原生可直传（mp3/wav/flac/m4a/ogg）
#           ∪ 需先转码才能喂给模型（IM 语音 silk/opus/amr、浏览器录音 webm）
AUDIO_EXTS = frozenset({
    "mp3", "wav", "flac", "m4a", "ogg",
    "amr", "silk", "sil", "slk", "opus", "aac", "wma", "webm", "3gp", "3gpp",
})


def kind_for_ext(ext: str) -> str:
    """按扩展名判定附件类别：image / audio / video / text / binary。"""
    e = (ext or "").lower()
    if e in IMAGE_EXTS:
        return "image"
    if e in AUDIO_EXTS:
        return "audio"
    if e in VIDEO_EXTS:
        return "video"
    if e in TEXT_EXTS:
        return "text"
    from app.core import doctext
    if e in doctext.EXTRACTABLE:   # PDF/docx/xlsx/pptx：能提取文本，按可读处理
        return "text"
    return "binary"


def model_attachment_name(meta: dict) -> str:
    """给模型看的附件名：隐藏平台生成的长随机文件名，保留用户自定义文件名。"""
    if meta.get("qq_face"):
        return "QQ表情"
    name = str(meta.get("name") or "附件")
    if re.fullmatch(r"[0-9a-fA-F]{24,}", name):
        return {
            "image": "图片",
            "audio": "音频",
            "video": "视频",
            "voice": "语音",
            "text": "文本文件",
        }.get(meta.get("kind"), "文件")
    ext = str(meta.get("ext") or "").lower()
    return f"{name}.{ext}" if ext else name
