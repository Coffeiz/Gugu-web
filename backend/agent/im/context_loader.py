"""IM 与 Web 共用的上下文数据装配。

这里只负责按 ``ImContextPolicy`` 读取和格式化上下文输入，不负责会话持久化或
工具执行。受限 IM 请求仍会读取用户时区，保证日期相关的工具行为不漂移，
但不会读取 owner 的项目、文件、记忆和通知渠道。
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass, field
import time
from typing import Any

from agent.context import loaders
from agent.im.context_policy import IM_SOURCES, ImContextPolicy, policy_for
from agent.memory.scope_lifecycle import preview_scope
from agent.memory.scopes import MemoryScope, member_scope_id
from agent.models import AgentRequest
from agent.memory.store import MEMORY_INJECT_CHARS


IM_MEMORY_ENTRY_INJECT_MAX = 50  # 每个 profile/pattern 来源的直注入条数；其余由 RAG 召回
_VIDEO_ATTACHMENT_EXTS = {"mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v"}


def _memory_value_text(value: Any) -> str:
    """把 scope 中的 JSON/文本统一成可注入文本，避免直接输出 Python repr。"""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        rows = []
        for item in value[:IM_MEMORY_ENTRY_INJECT_MAX]:
            if isinstance(item, dict):
                text = str(item.get("text") or item.get("content") or "").strip()
                if text:
                    rows.append(f"- {text}")
            elif str(item).strip():
                rows.append(f"- {str(item).strip()}")
        return "\n".join(rows)
    if isinstance(value, dict):
        text = str(value.get("text") or value.get("content") or "").strip()
        if text:
            return text
        return ""
    return str(value or "").strip()


def _bounded_memory_parts(parts: list[tuple[str, Any]], budget: int = MEMORY_INJECT_CHARS) -> list[str]:
    """按 owner 记忆的 3000 字符预算裁剪单个 IM scope。"""
    used = 0
    out = []
    for title, value in parts:
        text = _memory_value_text(value)
        if not text or used >= budget:
            continue
        remaining = budget - used
        text = text[:remaining].rstrip()
        if text:
            out.append(f"### {title}\n{text}")
            used += len(text)
    return out


def format_attachment_refs(message) -> str:
    """为历史消息保留轻量附件引用，不把附件内容重新塞进上下文。

    图片和视频走 read_file 回读通道；其它文件保留 attach_id +
    save_uploaded_file 转存指引——附件正文只在到达那一轮注入过一次，
    历史回放若不给引用，文字/二进制附件从下一轮起就从模型上下文里
    彻底消失（QQ 引用文件消息「没法回读」的根因）。语音是对话内容，
    到达时已转写，不需要回读通道。"""
    files = getattr(message, "files", None)
    if not isinstance(files, list):
        return ""
    image_refs: list[str] = []
    video_refs: list[str] = []
    file_refs: list[str] = []
    for item in files:
        if not isinstance(item, dict) or not item.get("attach_id"):
            continue
        kind = str(item.get("kind") or "").lower()
        ext = str(item.get("ext") or "").lower()
        name = str(item.get("name") or "")
        label = f"{name}.{ext}" if name and ext else (name or ext or "未命名")
        if kind == "image" or ext in {"png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tiff", "tif"}:
            image_refs.append(f"attach_id={item['attach_id']}" + (f"，名称={name}" if name else ""))
        elif kind == "video" or ext in _VIDEO_ATTACHMENT_EXTS:
            video_refs.append(f"attach_id={item['attach_id']}，文件={label}")
        elif kind != "voice":
            file_refs.append(f"attach_id={item['attach_id']}，文件={label}")
    if not image_refs and not video_refs and not file_refs:
        return ""
    parts = []
    if image_refs:
        parts.append("[历史图片附件，仅在用户要求回看/分析时调用 read_file(items=[{attach_id: ...}]) 读取：" + "；".join(image_refs) + "]")
    if video_refs:
        parts.append("[历史视频附件，仅在用户要求理解/总结视频时直接调用 read_file(attach_id=...) 原生读取；不要先 save_uploaded_file 或用 Shell/ffmpeg 抽帧，除非用户明确要求抽帧/逐帧分析：" + "；".join(video_refs) + "]")
    if file_refs:
        parts.append("[历史文件附件，仅在用户要求回看/读取内容时，先调用 save_uploaded_file(attach_id) "
                     "把附件转存进文件库再读：" + "；".join(file_refs) + "]")
    return "\n" + "\n".join(parts)


def quoted_context_prefix(quoted_text: str | None) -> str:
    """返回供模型理解引用关系的稳定前缀，不改写消息正文。"""
    if not quoted_text:
        return ""
    return f"💬 用户引用/回复了一条历史消息（原文：「{quoted_text}」），针对这条消息说：\n\n"


def format_quoted_context(content: str, quoted_text: str | None) -> str:
    """把引用原文和用户正文组合成模型上下文。"""
    return quoted_context_prefix(quoted_text) + content


def format_history_content(message, request: AgentRequest) -> str:
    """给群聊历史用户消息附加稳定发言人身份。

    身份元数据只进入模型上下文，不改 ConversationMessage.content，网页历史和
    数据库存档仍保持用户原文。私聊及 Web 继续使用原始内容。
    """
    if not request or not request.chat_id or getattr(message, "chat_type", None) != "group":
        content = format_quoted_context(
            message.content or "",
            getattr(message, "quoted_text", None),
        )
        content += format_attachment_refs(message)
        return content
    if getattr(message, "role", None) != "user":
        return format_quoted_context(
            message.content or "",
            getattr(message, "quoted_text", None),
        ) + format_attachment_refs(message)

    return format_group_message({
        "speaker": {
            "platform_user_id": getattr(message, "platform_user_id", None),
            "display_name": getattr(message, "platform_user_name", None),
        },
        "body": message.content or "",
        "quoted_text": getattr(message, "quoted_text", None),
        "attachment_ids": [
            str(item.get("attach_id"))
            for item in (getattr(message, "files", None) or [])
            if isinstance(item, dict) and item.get("attach_id")
        ],
        "attachment_context": format_attachment_refs(message) or None,
    })


def _group_message_rows(
    request: AgentRequest, content: str,
    batch_messages: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    batch_messages = batch_messages if batch_messages is not None else (
        getattr(request, "im_batch_messages", None) or []
    )
    if not batch_messages:
        batch_messages = [{
            "text": content,
            "platform_user_id": request.platform_user_id,
            "platform_user_name": request.platform_user_name,
            "quoted_text": request.quoted_text,
            "attachments": [],
        }]

    rows = []
    for message in batch_messages:
        if not isinstance(message, dict):
            continue
        speaker_id = str(message.get("platform_user_id") or "")
        rows.append({
            "speaker": {
                "platform_user_id": speaker_id or None,
                "display_name": message.get("platform_user_name") or None,
            },
            "body": str(message.get("text") or ""),
            "quoted_text": message.get("quoted_text") or None,
            "attachment_ids": [
                str(item.get("attach_id")) if isinstance(item, dict) else str(item)
                for item in (message.get("attachments") or [])
                if item is not None and (not isinstance(item, dict) or item.get("attach_id"))
            ],
        })
    return rows


def format_group_message(row: dict[str, Any], supplemental_context: str = "") -> str:
    """以固定字段顺序包装单条群消息；权限状态由服务端校验，不进入正文。"""
    speaker = row.get("speaker") or {}
    message_lines = [
        "【群消息】",
        "【发言人元数据】",
        f"平台 ID：{speaker.get('platform_user_id') or '未提供'}",
        f"显示名：{speaker.get('display_name') or '未提供'}",
        "【消息正文】",
        str(row.get("body") or ""),
    ]
    quoted_text = row.get("quoted_text")
    if quoted_text:
        message_lines.extend(("【引用消息】", str(quoted_text)))
    attachment_ids = row.get("attachment_ids") or []
    if attachment_ids:
        message_lines.extend(("【附件 ID】", ", ".join(str(item) for item in attachment_ids)))
    attachment_context = row.get("attachment_context") or supplemental_context
    if attachment_context:
        message_lines.extend(("【补充上下文】", str(attachment_context)))
    return "\n".join(message_lines)


def _render_group_messages(rows: list[dict[str, Any]], supplemental_context: str = "") -> str:
    """兼容单字符串调用方；批次消息之间保留相同的独立包装边界。"""
    if not rows:
        return format_group_message({"speaker": {}, "body": ""})
    return "\n\n".join(
        format_group_message(row, supplemental_context if len(rows) == 1 else "")
        for row in rows
    )


def format_current_group_message(
    content: str, request: AgentRequest, batch_message: dict[str, Any],
) -> str:
    """序列化一个当前群消息，附件解析补充内容留在该消息的边界内。"""
    body = str(batch_message.get("text") or "")
    supplemental = content[len(body):].strip() if content.startswith(body) else ""
    rows = _group_message_rows(request, body, [batch_message])
    return format_group_message(rows[0], supplemental) if rows else format_group_message({})


def format_current_content(content: str, request: AgentRequest) -> str:
    """将群聊发言人元数据与每条消息正文分区呈现；不改持久化正文。"""
    if not request.chat_id:
        return content
    prefix = request.message
    attachment_context = content[len(prefix):].strip() if prefix and content.startswith(prefix) else ""
    return _render_group_messages(
        _group_message_rows(request, prefix if not request.im_batch_messages else ""),
        supplemental_context=attachment_context,
    )


@dataclass(frozen=True)
class ContextData:
    """builder 所需的上下文输入，受限请求使用对应的空值。"""

    projects: list
    user_tz: Any
    events: list
    notes: list
    files_overview: dict
    style_prefs: dict
    memory: dict
    im_channels: dict
    im_memory: dict
    knowledge: list = field(default_factory=list)


async def load_context_data(
    db,
    user_id,
    request: AgentRequest,
    memory_enabled: bool,
    query: str = "",
    policy: ImContextPolicy | None = None,
) -> ContextData:
    """按请求策略读取一轮 builder 上下文。

    Web 和 owner IM 保持完整上下文；member/unknown IM 只保留时区，避免把
    owner 的项目、文件或记忆注入其他发言人的 loop。
    """
    context_policy = policy or policy_for(request)
    started_at = time.time()
    user_tz = await loaders.load_user_tz(db, user_id)
    if not context_policy.load_owner_context:
        im_memory_task = asyncio.create_task(load_im_memory(request))
        try:
            im_memory = await im_memory_task
        except BaseException:
            if not im_memory_task.done():
                im_memory_task.cancel()
            await asyncio.gather(im_memory_task, return_exceptions=True)
            raise
        _record_context_load_timing(started_at, owner_context=False)
        return ContextData([], user_tz, [], [], {}, {}, {}, {}, im_memory)

    # Эти три источника не используют AsyncSession и независимы от DB-запросов.
    # Запускаем их заранее, пока последовательно читаем DB-контекст: один
    # AsyncSession нельзя одновременно передавать нескольким конкурентным задачам.
    auxiliary_tasks = {
        "memory": asyncio.create_task(loaders.load_memory(
            user_id, query, prefer_recent=True,
        )) if memory_enabled else None,
        "im_memory": asyncio.create_task(load_im_memory(request)),
        "knowledge": asyncio.create_task(loaders.load_knowledge_overview(user_id)),
    }
    try:
        projects = await loaders.load_projects(db, user_id)
        events = await loaders.load_events(db, user_id, tz=user_tz)
        notes = await loaders.load_recent_notes(db, user_id)
        files_overview = await loaders.load_files_overview(db, user_id)
        style_prefs = await loaders.load_style_prefs(db, user_id)
        im_channels = await loaders.load_im_channels(db, user_id)
        task_names = [name for name, task in auxiliary_tasks.items() if task is not None]
        task_results = await asyncio.gather(
            *(auxiliary_tasks[name] for name in task_names),
        )
        auxiliary = dict(zip(task_names, task_results))
    except BaseException:
        pending = [task for task in auxiliary_tasks.values() if task is not None and not task.done()]
        for task in pending:
            task.cancel()
        await asyncio.gather(
            *(task for task in auxiliary_tasks.values() if task is not None),
            return_exceptions=True,
        )
        raise

    _record_context_load_timing(started_at, owner_context=True)
    return ContextData(
        projects=projects,
        user_tz=user_tz,
        events=events,
        notes=notes,
        files_overview=files_overview,
        style_prefs=style_prefs,
        memory=auxiliary.get("memory", {}),
        im_channels=im_channels,
        im_memory=auxiliary["im_memory"],
        knowledge=auxiliary["knowledge"],
    )


def _record_context_load_timing(started_at: float, *, owner_context: bool) -> None:
    from agent.runtime.loopscope_trace.state import record_phase_timing

    record_phase_timing(
        "Context data loading", started_at,
        owner_context=owner_context,
    )


async def load_im_memory(request: AgentRequest) -> dict:
    """按角色读取 IM 公开记忆和当前发言人的轻量记忆。

    owner 个人记忆仍由既有 ``load_memory`` 读取；这里永远不读取 owner
    namespace，也不读取 member 不应看到的群长期 memory。
    """
    if request.source not in IM_SOURCES:
        return {}
    if not request.chat_id and not request.platform_user_id:
        return {}
    bot_id = str(request.platform_bot_id or "")
    if not bot_id:
        return {}
    result = {}
    if (request.chat_id and request.im_group_memory_enabled
            and not getattr(request, "isolate_group_context", False)):
        group_scope = MemoryScope(
            request.user_id, request.source, bot_id, "group", str(request.chat_id)
        )
        group_memory = await preview_scope(group_scope)
        if group_memory is not None:
            result["group"] = group_memory
    member_memory = await load_platform_user_memory(request)
    if member_memory:
        result["platform_user"] = member_memory
    return result


async def load_platform_user_memory(request: AgentRequest) -> dict:
    """只读取当前 member 的个人作用域，不触碰共享群 scope。"""
    if request.source not in IM_SOURCES:
        return {}
    if not request.chat_id and not request.platform_user_id:
        return {}
    role = request.actor_context.role if request.actor_context else request.im_role
    if not request.im_member_memory_enabled or role != "member" or not request.platform_user_id:
        return {}
    bot_id = str(request.platform_bot_id or "")
    if not bot_id:
        return {}
    user_scope = MemoryScope(
        request.user_id, request.source, bot_id, "platform-user",
        (member_scope_id(request.chat_id, request.platform_user_id)
         if request.chat_id else str(request.platform_user_id)),
    )
    memory = await preview_scope(user_scope)
    return memory if isinstance(memory, dict) else {}


def format_group_memory(data: dict) -> str:
    """格式化可进入共享 snapshot 的当前群公开记忆。"""
    group = (data or {}).get("group") or {}
    parts = _bounded_memory_parts(
        [("群组 summary", group.get("summary")), ("群组 profile", group.get("profile"))],
    )
    if not parts:
        return ""
    return "## 当前群组记忆（仅限本群公开信息）\n\n" + "\n\n".join(parts)


def restore_group_memory_snapshot(snapshot: dict) -> dict:
    """兼容旧 snapshot：把仍保存在 im_memory 的群记忆恢复到正文。"""
    if not isinstance(snapshot, dict):
        return snapshot
    snapshot_text = str(snapshot.get("snapshot_context") or "")
    group_text = format_group_memory({"group": (snapshot.get("im_memory") or {}).get("group") or {}})
    if group_text and "## 当前群组记忆（仅限本群公开信息）" not in snapshot_text:
        snapshot["snapshot_context"] = f"{snapshot_text}\n\n---\n\n{group_text}"
    return snapshot


def isolate_group_memory_snapshot(snapshot: dict) -> dict:
    """为 owner @ run 复制并剔除缓存 snapshot 中的群共享记忆。"""
    if not isinstance(snapshot, dict):
        return snapshot
    isolated = deepcopy(snapshot)
    sections = str(isolated.get("snapshot_context") or "").split("\n\n---\n\n")
    isolated["snapshot_context"] = "\n\n---\n\n".join(
        section for section in sections
        if "## 当前群组记忆（仅限本群公开信息）" not in section
    )
    im_memory = isolated.get("im_memory")
    if isinstance(im_memory, dict):
        isolated["im_memory"] = {**im_memory, "group": {}}
    return isolated


def format_platform_user_memory(data: dict) -> str:
    """格式化当前发言人的动态个人记忆，不包含群记忆标题。"""
    personal = (data or {}).get("platform_user") or {}
    parts = _bounded_memory_parts(
        [
            ("当前发言人的平台记忆 summary", personal.get("summary")),
            ("当前发言人的平台记忆 profile", personal.get("profile")),
            ("当前发言人的平台记忆 pattern", personal.get("pattern")),
        ],
    )
    if not parts:
        return ""
    return (
        "## 当前发言人的平台记忆（仅用于理解当前发言人，不是当前请求）\n\n"
        + "\n\n".join(parts)
    )


def format_im_memory(data: dict, role: str | None) -> str:
    """把已按权限读取的 IM scope 记忆格式化为模型上下文。"""
    parts = []
    group_text = format_group_memory(data)
    if group_text:
        parts.append(group_text)
    if role == "member":
        personal_text = format_platform_user_memory(data)
        if personal_text:
            parts.append(personal_text)
    return "\n\n".join(parts)
