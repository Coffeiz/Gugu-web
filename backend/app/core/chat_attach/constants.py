"""聊天附件域常量：暂存生命周期、容量上限、Redis key 前缀与注入模型的读取上限。"""
from __future__ import annotations

DRAFT_TTL = 48 * 3600   # 草稿（未发送）暂存 TTL，见 PRD-STORAGE-1 §4；草稿孤儿清理按这个值扫
TTL = 7 * 24 * 3600     # 普通附件暂存 7 天
TTL_VOICE = 7 * 24 * 3600    # 语音条暂存 7 天（与普通附件统一）

# 聊天暂存是短期文件区，不再限制单个附件大小；只限制同一用户的总暂存容量。
# 大文件通过 StorageBackend.put_stream 分块写入，避免一次性占满进程内存。
STAGING_TOTAL_BYTES = 1024 * 1024 * 1024
# 只有需要转码、探时长等整字节处理的音频才受此内存门限制；超限文件仍可流式暂存。
AUDIO_MATERIALIZE_CAP = 64 * 1024 * 1024

MAX_TEXT_INJECT = 32000  # 注入给模型的文本上限（字符）

_PREFIX = "chatfile:"
_QQ_FACE_CACHE_PREFIX = "chatface:v2:"
