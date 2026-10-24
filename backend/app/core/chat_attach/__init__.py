"""聊天附件暂存：用户在对话里发给咕咕的文件**先暂存**（不进文件库）。

- 咕咕能「看」：文本类读内容注入上下文；图片给提示（看内容需支持 image 的模型）。
- 咕咕能「存」：用户说存时，`save_uploaded_file` 工具把暂存字节落成正式文件库记录。

字节走 StorageBackend（key 放 `.chat_staging/` 下）；**元数据以 `chat_attachments`
表为所有权真相来源**（PRD-STORAGE-1 Phase A）——附件只有 `draft`/`attached` 两态，
Redis 完全不参与"这个对象是否有主人"的判断，只在 DB 查不到时作为 v3 上线前遗留
数据的 legacy fallback（会随旧 Redis key 自然过期消失，不专门下线）。

物理删除的唯一入口是 `try_delete_storage_if_unreferenced()`（stage()/stage_sync()
insert 失败时的补偿删除除外）——删除前检查是否还有其他存活行引用同一个
`storage_key`（PRD-IM-9 的引用复用场景会让多条附件行共享一份物理字节）。

本包只管「附件是什么、归谁、存在哪」；**文件格式能不能喂给模型**是媒体域
（`agent/media/`）的事，**怎么把附件装配进本轮消息**是装配域
（`agent/chat/attachments.py`）的事——三块分开，app 层不反向依赖 agent 层。
"""
from __future__ import annotations

from .constants import (
    AUDIO_MATERIALIZE_CAP,
    DRAFT_TTL,
    MAX_TEXT_INJECT,
    STAGING_TOTAL_BYTES,
    TTL,
    TTL_VOICE,
)
from .file_types import (
    AUDIO_EXTS,
    IMAGE_EXTS,
    TEXT_EXTS,
    VIDEO_EXTS,
    kind_for_ext,
    model_attachment_name,
)
from .queries import (
    get_meta,
    get_meta_many,
    get_qq_face_cached,
    list_session_attachments,
    list_staged,
    read_bytes,
    read_text,
    resolve_attach,
    set_qq_face_cached,
)
from .records import (
    AttachmentClaimError,
    claim_attachments,
    clear_staged,
    reuse_attachment,
    try_delete_storage_if_unreferenced,
)
from .staging import (
    ChatAttachmentCapacityError,
    stage,
    stage_stream,
    stage_sync,
    stage_voice,
    stage_voice_sync,
    staging_capacity_remaining,
)

__all__ = [
    "AUDIO_EXTS",
    "AUDIO_MATERIALIZE_CAP",
    "AttachmentClaimError",
    "ChatAttachmentCapacityError",
    "DRAFT_TTL",
    "IMAGE_EXTS",
    "MAX_TEXT_INJECT",
    "STAGING_TOTAL_BYTES",
    "TEXT_EXTS",
    "TTL",
    "TTL_VOICE",
    "VIDEO_EXTS",
    "claim_attachments",
    "clear_staged",
    "get_meta",
    "get_meta_many",
    "get_qq_face_cached",
    "kind_for_ext",
    "list_session_attachments",
    "list_staged",
    "model_attachment_name",
    "read_bytes",
    "read_text",
    "reuse_attachment",
    "resolve_attach",
    "set_qq_face_cached",
    "stage",
    "stage_stream",
    "stage_sync",
    "stage_voice",
    "stage_voice_sync",
    "staging_capacity_remaining",
    "try_delete_storage_if_unreferenced",
]
