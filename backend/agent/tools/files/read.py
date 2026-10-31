"""文件读取入口：统一处理文件库、历史附件、网络图片与批量媒体。"""
import json
from types import SimpleNamespace

from agent.tools.text_edit import select_numbered_lines


def _display_file_name(display_name: str, ext: str) -> str:
    """FILE/空扩展名是无后缀哨兵，展示时不拼出伪后缀。"""
    return display_name if not ext or ext.lower() == "file" else f"{display_name}.{ext}"


def _decode_extensionless_text(data: bytes) -> str | None:
    """只把可严格解码且不含二进制控制字符的无后缀内容当作文本。"""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    has_binary_control = any(
        (ord(char) < 32 and char not in "\n\r\t\f") or 0x7f <= ord(char) <= 0x9f
        for char in text
    )
    if has_binary_control:
        return None
    return text


async def _read_history_text(meta: dict, attach_id: str, *, target_lines="all",
                             max_source_bytes: int | None = None):
    from app.core import chat_attach, doctext
    from app.core.redaction import redact
    from app.services import storage as storage_service

    ext = str(meta.get("ext") or "").lower()
    is_document = ext in doctext.EXTRACTABLE
    size_limit = doctext.EXTRACT_MAX_BYTES if is_document else 32 * 1024 * 1024
    if ext not in chat_attach.TEXT_EXTS and not is_document:
        return json.dumps({"error": "该历史附件类型不支持文本提取"}, ensure_ascii=False)
    if int(meta.get("size") or 0) > size_limit:
        return json.dumps({"error": f"附件过大，超出可读上限（{size_limit // 1048576}MB）"}, ensure_ascii=False)
    try:
        storage = storage_service.get_storage()
        info = await storage.stat(meta["storage_key"])
        if info is None:
            return json.dumps({"error": "历史附件不存在，无法读取"}, ensure_ascii=False)
        if info.size > size_limit:
            return json.dumps({"error": f"附件过大，超出可读上限（{size_limit // 1048576}MB）"}, ensure_ascii=False)
        if max_source_bytes is not None and info.size > max_source_bytes:
            return json.dumps({"error": "本批次剩余容量不足，未读取该附件"}, ensure_ascii=False)
        data = await storage.get(meta["storage_key"])
        text = await doctext.extract_text(data, ext)
        selected, numbered, line_range = select_numbered_lines(text, target_lines)
    except Exception as exc:
        return json.dumps({"error": f"读取历史附件失败：{redact(str(exc))[:80]}"}, ensure_ascii=False)
    return {
        "attach_id": attach_id,
        "name": str(meta.get("name") or "聊天附件"),
        "content": selected,
        "numbered_content": numbered,
        "line_range": {"start": line_range[0], "end": line_range[1]},
        "_source_size_bytes": len(data),
    }


async def _read_history_media(db, user_id, attach_id: str, *,
                              max_source_bytes: int | None = None, target_lines="all"):
    from app.core import chat_attach
    from agent.tools.media_reader import AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, read_media, read_stored_image

    meta = await chat_attach.get_meta(user_id, attach_id)
    if not meta:
        return json.dumps({"error": "找不到这个历史附件，可能已被清理"}, ensure_ascii=False)
    ext = str(meta.get("ext") or "").lower()
    kind = str(meta.get("kind") or "").lower()
    name = str(meta.get("name") or "聊天附件")
    if ext and name.lower().endswith(f".{ext}"):
        name = name[: -(len(ext) + 1)]
    if kind == "image" and ext in IMAGE_EXTS:
        result = await read_stored_image(meta["storage_key"], ext, max_source_bytes=max_source_bytes)
        if result.get("error"):
            return json.dumps(result, ensure_ascii=False)
        return {
            "_image_block": result["block"], "_source_size_bytes": result["_source_size_bytes"],
            "note": f"已打开聊天附件图片《{meta.get('name') or attach_id}》，见随附图像。",
        }
    if kind == "text":
        return await _read_history_text(
            meta, attach_id, target_lines=target_lines,
            max_source_bytes=max_source_bytes,
        )
    if kind not in {"audio", "video", "voice"} or ext not in AUDIO_EXTS | VIDEO_EXTS:
        return json.dumps({"error": "历史附件目前支持文本、PDF/Office、图片、音频或视频"}, ensure_ascii=False)
    file = SimpleNamespace(
        id=attach_id, user_id=user_id, storage_key=meta["storage_key"], ext=ext,
        display_name=name,
    )
    return await read_media(file, max_source_bytes=max_source_bytes, db=db, user_id=user_id)


def _restricted_file_reader() -> bool:
    from agent.im import imctx
    current_im = imctx.get_im()
    return bool(current_im and current_im.get("im_role") != "owner")


async def _is_current_group_session_attachment(db, user_id, attach_id: str) -> bool:
    """只允许群成员回读确实挂在当前群 session 消息上的聊天附件。"""
    from agent.im import imctx
    from agent.tools.base import current_dispatch_session_id
    from app.models import ChatAttachment, ConversationMessage, ConversationSession
    from sqlalchemy import select

    current_im = imctx.get_im() or {}
    session_id = current_dispatch_session_id()
    if current_im.get("chat_type") != "group" or session_id is None:
        return False
    linked_session_id = await db.scalar(
        select(ConversationSession.id)
        .join(ConversationMessage, ConversationMessage.session_id == ConversationSession.id)
        .join(ChatAttachment, ChatAttachment.message_id == ConversationMessage.id)
        .where(
            ChatAttachment.user_id == user_id,
            ChatAttachment.attach_id == attach_id,
            ChatAttachment.state == "attached",
            ConversationSession.id == int(session_id),
            ConversationSession.user_id == user_id,
            ConversationSession.source == current_im.get("platform"),
            ConversationSession.bot_id == current_im.get("channel_id"),
            ConversationSession.chat_id == current_im.get("chat_id"),
            ConversationSession.chat_type == "group",
        )
    )
    return linked_session_id is not None


async def _read_file_single(db, user_id, args: dict, *, restricted: bool = False,
                            max_source_bytes: int | None = None):
    if args.get("path") not in (None, ""):
        if args.get("scope") != "system":
            return {"error": "path 仅可与 scope=system 一起使用"}
        if any(args.get(key) not in (None, "") for key in (
            "file_id", "file", "attach_id", "url", "image_url", "img_src",
        )):
            return {"error": "system 路径不能与文件库、附件或图片来源混用"}
        if restricted:
            return {"error": "群聊成员和未识别身份不能读取 system 范围文件"}
        from .system_access import read_system_file

        return await read_system_file(
            db, user_id, args, max_source_bytes=max_source_bytes,
        )
    if args.get("scope") == "system":
        return {"error": "scope=system 时必须提供绝对 path"}
    from app.core import doctext
    from .file_operations import READ_MAX_BYTES, _is_text_file_record, _resolve_file, get_storage

    attach_id = str(args.get("attach_id") or "").strip()
    url = str(args.get("url") or args.get("image_url") or args.get("img_src") or "").strip()
    source_count = sum((args.get("file_id") is not None, bool(args.get("file")), bool(attach_id), bool(url)))
    if source_count != 1:
        return json.dumps({"error": "请指定 file_id、file、attach_id 或图片 url 中的一种来源"}, ensure_ascii=False)
    if url:
        from agent.tools.files import inspect_image_url
        result = await inspect_image_url(url, max_bytes=max_source_bytes)
        if result.get("error"):
            return json.dumps(result, ensure_ascii=False)
        title = str(args.get("title") or "").strip()
        title_note = f"《{title}》" if title else ""
        return {
            "_image_block": result["block"],
            "_source_size_bytes": result.get("_source_size_bytes", 0),
            "note": f"已读取网络图片{title_note}，见随附图像。",
        }
    if attach_id:
        if restricted:
            from agent.im import imctx

            current_im = imctx.get_im() or {}
            allowed_ids = current_im.get("current_attachment_ids") or ()
            is_session_attachment = attach_id not in allowed_ids and (
                await _is_current_group_session_attachment(db, user_id, attach_id)
                if current_im.get("chat_type") == "group"
                else False
            )
            if attach_id not in allowed_ids and not is_session_attachment:
                return json.dumps(
                    {"error": "群聊成员和未识别身份只能读取当前群会话中提供的附件"},
                    ensure_ascii=False,
                )
        return await _read_history_media(
            db, user_id, attach_id, max_source_bytes=max_source_bytes,
            target_lines=args.get("target_lines", "all"),
        )
    if restricted and args.get("file_id") is not None:
        return json.dumps(
            {"error": "群聊成员和未识别身份只能读取当前会话明确提供的图片附件"},
            ensure_ascii=False,
        )
    if restricted and args.get("file"):
        return json.dumps({"error": "群聊成员和未识别身份只能读取当前会话明确提供的图片附件"}, ensure_ascii=False)

    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    ext = f.ext.lower()
    file_name = _display_file_name(f.display_name, ext)

    from agent.tools.media_reader import IMAGE_EXTS, MEDIA_EXTS, read_media
    if restricted and ext not in IMAGE_EXTS:
        return json.dumps({"error": "群聊成员和未识别身份只能读取图片文件"}, ensure_ascii=False)
    if ext in MEDIA_EXTS:
        result = await read_media(f, max_source_bytes=max_source_bytes, db=db, user_id=user_id)
        if result.get("error"):
            return json.dumps(result, ensure_ascii=False)
        if ext in IMAGE_EXTS:
            return {"_image_block": result["block"],
                    "_source_size_bytes": result.get("_source_size_bytes", 0),
                    "note": f"已打开图片《{file_name}》，见随附图像。"}
        return result

    # SVG 保留为源码读取，不伪装成不可栅格化的视觉输入。
    is_doc = ext in doctext.EXTRACTABLE      # PDF/docx/xlsx/pptx 等，需工具提取文本
    is_text = _is_text_file_record(f)
    extensionless = ext in {"", "file"}
    mime_type = (f.mime_type or "").lower()
    can_sniff_extensionless_text = extensionless and (
        not mime_type or mime_type in {"application/octet-stream", "binary/octet-stream"}
        or mime_type.startswith("text/")
    )
    if not is_text and not is_doc and not can_sniff_extensionless_text:
        label = ext or "无扩展名"
        return json.dumps({"error": f"不支持读取该类型（{label}），支持文本、PDF/Office、图片、音频和视频"})
    cap = doctext.EXTRACT_MAX_BYTES if is_doc else READ_MAX_BYTES
    if (f.size_bytes or 0) > cap:
        return json.dumps({"error": f"文件过大（{f.size}），超出可读上限"})
    try:
        storage = get_storage()
        if max_source_bytes is not None:
            info = await storage.stat(f.storage_key)
            if info is None:
                return json.dumps({"error": "文件不存在，无法读取"}, ensure_ascii=False)
            if info.size > max_source_bytes:
                return json.dumps({"error": "本批次剩余容量不足，未读取该文件"}, ensure_ascii=False)
        data = await storage.get(f.storage_key)
        if extensionless:
            text = _decode_extensionless_text(data)
            if text is None:
                label = ext or "无扩展名"
                return json.dumps({"error": f"不支持读取该类型（{label}），内容不是 UTF-8 文本"})
        else:
            text = await doctext.extract_text(data, ext)   # 文本类直接 decode；文档走 pdftotext/LibreOffice
    except Exception as e:
        return json.dumps({"error": f"读取失败：{str(e)[:80]}"})
    target_lines = args.get("target_lines", "all")
    try:
        selected_content, selected_numbered, selected_range = select_numbered_lines(text, target_lines)
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return {
        "file_id": f.id,
        "name": file_name,
        "content": selected_content,
        "numbered_content": selected_numbered,
        "line_range": {"start": selected_range[0], "end": selected_range[1]},
        "_source_size_bytes": len(data),
    }


def _file_item_source_count(item: dict) -> int:
    return sum((item.get("file_id") is not None, bool(item.get("file")),
                bool(item.get("attach_id")),
                bool(item.get("url") or item.get("image_url") or item.get("img_src")),
                bool(item.get("path"))))


def _file_item_label(item: dict, result: dict, index: int) -> str:
    return str(
        item.get("title") or item.get("result_id") or result.get("name")
        or item.get("path")
        or (f"文件 {item['file_id']}" if item.get("file_id") is not None else None)
        or (f"附件 {item['attach_id']}" if item.get("attach_id") else None)
        or (item.get("file") or f"媒体 {index}")
    )


def _batch_text_result(result: dict, label: str) -> str:
    if result.get("error"):
        return f"【{label}】读取失败：{result['error']}"
    content = result.get("content") or result.get("numbered_content")
    if content is not None:
        lines = result.get("line_range") or {}
        line_note = (f"（第 {lines.get('start')}–{lines.get('end')} 行）"
                     if lines.get("start") is not None else "")
        return f"【{label}】{line_note}\n{content}"
    return f"【{label}】\n{json.dumps(result, ensure_ascii=False)}"


async def _read_file(db, user_id, args: dict):
    from agent.tools.media_reader import MEDIA_BATCH_MAX_BYTES, MEDIA_BATCH_MAX_ITEMS, reserve_remote_image_read

    items = args.get("items")
    system_scope = args.get("scope") == "system"
    if items is None:
        items = [args]
        batch = False
    else:
        batch = True
        if any(args.get(key) not in (None, "") for key in (
            "file_id", "file", "attach_id", "url", "image_url", "img_src", "path",
        )):
            return json.dumps({"error": "items 批量模式不能同时提供单文件来源字段"}, ensure_ascii=False)
        if not isinstance(items, list) or not items:
            return json.dumps({"error": "items 必须是非空数组"}, ensure_ascii=False)
        if len(items) > MEDIA_BATCH_MAX_ITEMS:
            return json.dumps({"error": f"一次最多读取 {MEDIA_BATCH_MAX_ITEMS} 个文件或媒体"}, ensure_ascii=False)
        if system_scope and any(
            not isinstance(item, dict) or set(item) - {"path", "title", "result_id", "target_lines"}
            or not item.get("path")
            for item in items
        ):
            return json.dumps({"error": "scope=system 的批量模式每项只能提供 path、title、result_id 或 target_lines"}, ensure_ascii=False)
        if not system_scope and any(isinstance(item, dict) and item.get("path") for item in items):
            return json.dumps({"error": "批量读取系统路径必须在顶层显式设置 scope=system"}, ensure_ascii=False)

    has_url = any(
        isinstance(item, dict) and bool(item.get("url") or item.get("image_url") or item.get("img_src"))
        for item in items
    )
    if has_url and not reserve_remote_image_read():
        return json.dumps({"error": "本轮对话读取网络图片已达到 3 次上限，请基于已有结果继续分析"}, ensure_ascii=False)

    restricted = _restricted_file_reader()
    if not batch:
        result = await _read_file_single(db, user_id, args, restricted=restricted)
        if isinstance(result, dict):
            result.pop("_source_size_bytes", None)
        return result

    content_blocks = []
    total_bytes = 0
    succeeded = 0
    failed = 0
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict) or _file_item_source_count(item) != 1:
            failed += 1
            content_blocks.append({"type": "text", "text": f"【第 {index} 项】需且只能指定 file_id、file、attach_id、图片 url，或顶层 scope=system 时的 path 之一。"})
            continue
        item_args = {**item, "scope": "system"} if system_scope else item
        result = await _read_file_single(
            db, user_id, item_args, restricted=restricted,
            max_source_bytes=MEDIA_BATCH_MAX_BYTES - total_bytes,
        )
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except (TypeError, ValueError):
                result = {"error": result}
        source_size = int(result.pop("_source_size_bytes", 0) or 0)
        label = _file_item_label(item, result, index)
        if result.get("error"):
            failed += 1
            content_blocks.append({"type": "text", "text": f"【{label}】读取失败：{result['error']}"})
            continue
        if total_bytes + source_size > MEDIA_BATCH_MAX_BYTES:
            failed += 1
            content_blocks.append({
                "type": "text",
                "text": f"【{label}】跳过：本批次源文件总量不能超过 {MEDIA_BATCH_MAX_BYTES // (1024 * 1024)} MiB。",
            })
            content_blocks.append({"type": "text", "text": "已达到批次总量上限，后续项目未读取。"})
            break
        total_bytes += source_size
        succeeded += 1
        if result.get("_image_block"):
            content_blocks.extend([
                {"type": "text", "text": f"【{label}】图片内容："}, result.pop("_image_block"),
            ])
        elif result.get("_media_block"):
            note = result.get("note") or f"【{label}】媒体内容："
            content_blocks.extend([{"type": "text", "text": f"【{label}】{note}"}, result.pop("_media_block")])
        else:
            content_blocks.append({"type": "text", "text": _batch_text_result(result, label)})
    content_blocks.insert(0, {
        "type": "text",
        "text": f"批量读取完成：成功 {succeeded} 项，失败或跳过 {failed} 项；请按每项标题对应内容分析。",
    })
    return {"_media_content": content_blocks}
