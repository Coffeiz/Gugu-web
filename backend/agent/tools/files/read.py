"""文件读取入口：统一处理文件库、历史附件、网络图片与批量媒体。"""
import json
from types import SimpleNamespace

from agent.tools.text_edit import select_numbered_lines

async def _read_history_media(user_id, attach_id: str, *, restricted: bool = False,
                              max_source_bytes: int | None = None):
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
            "_vision_image": result["block"], "_source_size_bytes": result["_source_size_bytes"],
            "note": f"已打开聊天附件图片《{meta.get('name') or attach_id}》，见随附图像。",
        }
    if restricted:
        return json.dumps({"error": "群聊成员和未识别身份只能读取图片附件"}, ensure_ascii=False)
    if kind not in {"audio", "video", "voice"} or ext not in AUDIO_EXTS | VIDEO_EXTS:
        return json.dumps({"error": "历史附件目前支持图片、音频或视频；其他文件请先保存到文件库"}, ensure_ascii=False)
    file = SimpleNamespace(
        id=attach_id, user_id=user_id, storage_key=meta["storage_key"], ext=ext,
        display_name=name,
    )
    return await read_media(file, max_source_bytes=max_source_bytes)


def _restricted_file_reader() -> bool:
    from agent.im import imctx
    current_im = imctx.get_im()
    return bool(current_im and current_im.get("im_role") != "owner")


async def _read_file_single(db, user_id, args: dict, *, restricted: bool = False,
                            max_source_bytes: int | None = None):
    from app.core import doctext
    from .documents import READ_MAX_BYTES, _is_text_file_record, _resolve_file, get_storage

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
            "_vision_image": result["block"],
            "_source_size_bytes": result.get("_source_size_bytes", 0),
            "note": f"已读取网络图片{title_note}，见随附图像。",
        }
    if attach_id:
        return await _read_history_media(
            user_id, attach_id, restricted=restricted, max_source_bytes=max_source_bytes,
        )
    if restricted and args.get("file"):
        return json.dumps({"error": "群聊成员和未识别身份只能按 file_id 读取图片"}, ensure_ascii=False)

    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    ext = f.ext.lower()

    from agent.tools.media_reader import IMAGE_EXTS, MEDIA_EXTS, read_media
    if restricted and ext not in IMAGE_EXTS:
        return json.dumps({"error": "群聊成员和未识别身份只能读取图片文件"}, ensure_ascii=False)
    if ext in MEDIA_EXTS:
        result = await read_media(f, max_source_bytes=max_source_bytes)
        if result.get("error"):
            return json.dumps(result, ensure_ascii=False)
        if ext in IMAGE_EXTS:
            return {"_vision_image": result["block"],
                    "_source_size_bytes": result.get("_source_size_bytes", 0),
                    "note": f"已打开图片《{f.display_name}.{f.ext}》，见随附图像。"}
        return result

    # SVG 保留为源码读取，不伪装成不可栅格化的视觉输入。
    is_doc = ext in doctext.EXTRACTABLE      # PDF/docx/xlsx/pptx 等，需工具提取文本
    is_text = _is_text_file_record(f)
    if not is_text and not is_doc:
        return json.dumps({"error": f"不支持读取该类型（{f.ext}），支持文本、PDF/Office、图片、音频和视频"})
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
        "name": f"{f.display_name}.{f.ext}",
        "content": selected_content,
        "numbered_content": selected_numbered,
        "line_range": {"start": selected_range[0], "end": selected_range[1]},
        "_source_size_bytes": len(data),
    }


def _file_item_source_count(item: dict) -> int:
    return sum((item.get("file_id") is not None, bool(item.get("file")),
                bool(item.get("attach_id")),
                bool(item.get("url") or item.get("image_url") or item.get("img_src"))))


def _file_item_label(item: dict, result: dict, index: int) -> str:
    return str(
        item.get("title") or item.get("result_id") or result.get("name")
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
    if items is None:
        items = [args]
        batch = False
    else:
        batch = True
        if any(args.get(key) not in (None, "") for key in ("file_id", "file", "attach_id", "url", "image_url", "img_src")):
            return json.dumps({"error": "items 批量模式不能同时提供单文件来源字段"}, ensure_ascii=False)
        if not isinstance(items, list) or not items:
            return json.dumps({"error": "items 必须是非空数组"}, ensure_ascii=False)
        if len(items) > MEDIA_BATCH_MAX_ITEMS:
            return json.dumps({"error": f"一次最多读取 {MEDIA_BATCH_MAX_ITEMS} 个文件或媒体"}, ensure_ascii=False)

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
            content_blocks.append({"type": "text", "text": f"【第 {index} 项】需且只能指定 file_id、file、attach_id 或图片 url 之一。"})
            continue
        result = await _read_file_single(
            db, user_id, item, restricted=restricted,
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
        if result.get("_vision_image"):
            content_blocks.extend([
                {"type": "text", "text": f"【{label}】图片内容："}, result.pop("_vision_image"),
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
