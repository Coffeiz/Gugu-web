"""文件领域技能：查 / 读 / 改 / 整理 / 创建。

复用文件服务层的现成 helper（`_build_key`/`_resolve_conflict`/
`_fmt_size`/`color_value`）、`app.services.storage.trash`（`move_file_to_trash`）与
存储层 `get_storage()`，整理类工具复刻 `update_file` 的 key 重建逻辑，不自己拼路径。

读/改/创建仅限 UTF-8 文本且 ≤256KB，已知文本扩展名和文件记录的 text/* MIME 都支持。
创建（create_file）支持批量文件和自定义后缀，不做格式转换、不执行文件内容。
"""
from datetime import datetime
import json
import re

from app.core.redaction import redact
from app.core.tz import now_utc
from app.services.storage.folders import resolve_folder_path
from app.services.files.response import color_value
from app.services.files.browser import (
    descendant_folder_ids,
    find_user_files_by_name,
    find_user_folders_by_name,
    get_user_file,
    get_user_folder,
    list_user_folders,
    search_user_files,
)
from app.services.projects import get_user_project
from app.services.storage.file_service.files import _fmt_size
from app.services.files.actions import delete_file as delete_file_action
from app.services.storage.keys import _build_key, _resolve_conflict
from app.services.storage.file_service import FileService
from app.services.filesystem_authorization import (
    FilesystemPolicy,
    filesystem_location_can_write,
)
from app.search.query import normalize_queries
from agent.tools.base import BaseSkill, Tool, current_dispatch_session
from agent.tools.filesystem_policy import (
    current_filesystem_policy,
    current_workspace_target,
    file_write_access_error,
    write_access_error,
)
from agent.tools.text_edit import apply_line_edits, select_numbered_lines
from .locations import (
    _bound_workspace_target, _coerce_loc, _folder_by_name,
    _location_matches, _location_receipt, _norm_target,
    _resolve_create_location, _resolve_file as _locations_resolve_file, _resolve_key,
    _target_loc, _workspace_conflict,
)
from .folders import (
    _create_folder, _delete_folder, _find_folder, _list_folders,
    _move_items, _rename_folder,
)
from .grep import _grep_files


def get_storage():
    """兼容旧的 agent.tools.files.get_storage 注入点。"""
    from . import get_storage as package_get_storage
    return package_get_storage()


async def _resolve_file(db, user_id, args):
    """兼容旧的 agent.tools.files._resolve_file 注入点。"""
    from . import _resolve_file as package_resolve_file
    if package_resolve_file is not _resolve_file:
        return await package_resolve_file(db, user_id, args)
    return await _locations_resolve_file(db, user_id, args)

# 可读/可改的文本类扩展名
TEXT_EXTS = frozenset({
    "md", "markdown", "txt", "text", "json", "csv", "tsv", "yaml", "yml",
    "xml", "html", "htm", "css", "js", "ts", "jsx", "tsx", "py", "java",
    "c", "cpp", "h", "hpp", "go", "rs", "rb", "php", "sh", "bash", "sql",
    "ini", "toml", "conf", "log", "vue", "svg",
})
READ_MAX_BYTES = 256 * 1024

# 已知扩展名的 MIME 映射。create_file 不再限制格式枚举；未知后缀按 text/plain 保存。
_DOC_MIME = {
    "md":   "text/markdown",   "markdown": "text/markdown", "txt": "text/plain",
    "json": "application/json", "csv": "text/csv",
    "yaml": "text/yaml",       "yml":  "text/yaml",
    "text": "text/plain",      "tsv":  "text/tab-separated-values",
    "xml":  "application/xml", "html": "text/html", "htm": "text/html",
    "css":  "text/css",        "js":   "text/javascript", "ts": "text/typescript",
    "jsx":  "text/jsx",        "tsx":  "text/tsx", "py": "text/x-python",
    "java": "text/x-java-source", "c": "text/x-c", "cpp": "text/x-c++src",
    "h":    "text/x-c",        "hpp":  "text/x-c++hdr", "go": "text/x-go",
    "rs":   "text/x-rust",     "rb":   "text/x-ruby", "php": "text/x-php",
    "sh":   "application/x-sh", "bash": "application/x-sh", "sql": "application/sql",
    "ini":  "text/plain",     "toml": "text/plain", "conf": "text/plain",
    "log":  "text/plain",     "vue":  "text/html", "svg": "image/svg+xml",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf":  "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

# format → 落盘后缀（build_key 用 ext 参数）。同族不同写法归一到同一个 ext：
# md/markdown→md、txt/text→txt、yaml/yml→yaml，否则 name="README.md" + format="markdown"
# 会拼成 "README.md.markdown"（双后缀），跟「上传/重命名等其他途径创建的 md 都是 .md」
# 对不上。归一后的 ext 才是真"后缀事实"。
_DOC_EXT = {
    "md": "md", "markdown": "md",
    "txt": "txt", "text": "txt",
    "json": "json", "csv": "csv", "tsv": "tsv",
    "yaml": "yaml", "yml": "yaml",
    "docx": "docx", "pdf": "pdf", "xlsx": "xlsx",
}

# ext 的所有等价写法（用户手写的后缀、LLM 传的 format 都要归一到一个 ext）。
# _strip_ext 用这张表判断 name 末尾的后缀是不是 fmt 的等价变体。
_DOC_EXT_ALIASES: dict[str, set[str]] = {}
for _fmt, _ext in _DOC_EXT.items():
    _DOC_EXT_ALIASES.setdefault(_ext, set()).add(_fmt)

_CREATE_NAME_EXT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,19}$")
_CREATE_SPACES = {"project", "personal", "workspace"}
_CREATE_BINARY_EXTS = frozenset({
    "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods",
    "ppt", "pptx", "odp",
})


def _is_text_file_record(file) -> bool:
    """判断文件是否可按 UTF-8 文本处理。

    扩展名白名单只覆盖常见文件；create_file 对自定义扩展名写入 text/plain，
    因此这里同时信任文本 MIME。上传的未知二进制仍保持不可编辑/不可读。
    """
    ext = (getattr(file, "ext", "") or "").lower()
    mime = (getattr(file, "mime_type", "") or "").lower()
    return ext in TEXT_EXTS or mime.startswith("text/") or mime in {
        "application/json", "application/xml", "application/javascript",
        "application/typescript", "application/sql", "application/x-sh",
    } or mime.endswith("+json") or mime.endswith("+xml")


def _split_create_name(name: str) -> tuple[str | None, str | None, str | None]:
    """解析 create_file 的完整文件名，返回 display_name、ext、错误。"""
    value = str(name or "").strip()
    if not value:
        return None, None, "缺少必填参数 name（文件名，需包含扩展名）"
    if len(value) > 300 or any(char in value for char in ("/", "\\", "\x00")):
        return None, None, "文件名非法：不能包含路径分隔符或超过 300 个字符"
    dot = value.rfind(".")
    if dot < 0 or dot == len(value) - 1:
        return None, None, "文件名必须包含非空扩展名，例如 script.py 或 page.html"
    display_name = value[:dot]
    ext = value[dot + 1:].lower()
    if not _CREATE_NAME_EXT_RE.fullmatch(ext):
        return None, None, "扩展名非法：仅支持 ASCII 字母、数字、点、加号、下划线和短横线，最长 20 个字符"
    return display_name, ext, None


def _strip_ext(name: str, ext: str) -> str:
    """把 name 末尾的 ext 等价后缀全部剥到稳定。"""
    aliases = _DOC_EXT_ALIASES.get(ext.lower(), {ext.lower()})
    sorted_aliases = sorted(aliases, key=len, reverse=True)
    while True:
        low = name.lower()
        for alias in sorted_aliases:
            suffix = "." + alias
            if low.endswith(suffix):
                name = name[: -len(suffix)]
                break
        else:
            return name


# ── handlers ──
async def _list_files(db, user_id, args: dict):
    folder_value = args.get("folder_id")
    if folder_value in (None, ""):
        folder_value = args.get("folder")
    folder_id = None
    if folder_value not in (None, ""):
        try:
            folder_id = int(str(folder_value).strip().lstrip("#"))
        except (TypeError, ValueError):
            folder, error = await _folder_by_name(
                db,
                user_id,
                folder_value,
                args.get("space"),
                args.get("project_id"),
                args.get("workspace_directory_id"),
            )
            if error:
                return error
            folder_id = folder.id
    file_queries = normalize_queries(
        args.get("query") or args.get("q"), args.get("queries") if isinstance(args.get("queries"), list) else None,
    )
    requested_limit = args.get("limit", 100)
    try:
        limit = max(1, min(int(requested_limit), 200))
    except (TypeError, ValueError):
        limit = 100
    rows = await search_user_files(
        db, user_id,
        space=args.get("space"),
        project_id=args.get("project_id"),
        folder_id=folder_id,
        workspace_directory_id=args.get("workspace_directory_id"),
        ext=args.get("ext"),
        queries=file_queries,
        mode=args.get("mode"),
        limit=limit,
    )
    out = []
    for file in rows:
        folder_path = "（根目录）"
        if file.folder_id:
            resolved = await resolve_folder_path(
                db, user_id, file.folder_id,
                file.project_id if file.space == "project" else None,
                file.workspace_directory_id,
            )
            if resolved:
                _, folder_path = resolved
        out.append({
            "id": file.id, "name": f"{file.display_name}.{file.ext}", "ext": file.ext,
            "space": file.space, "size": file.size, "project_id": file.project_id,
            "folder_id": file.folder_id, "folder_path": folder_path,
        })
    return out


async def _read_file(db, user_id, args: dict):
    from app.core import doctext
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    ext = f.ext.lower()

    from agent.tools.file_readers import AUDIO_EXTS, VIDEO_EXTS, read_media
    if ext in AUDIO_EXTS or ext in VIDEO_EXTS:
        return await read_media(f)

    # SVG 保留为源码读取；当前视觉适配器只接受可栅格化的位图，不能把 SVG
    # 伪装成图片块，否则会既看不了图又读不到源码。
    from app.core import chat_attach
    if ext in chat_attach.IMAGE_EXTS and ext != "svg":
        if not chat_attach.vision_ready():
            return json.dumps({"error": f"这是图片（{f.ext}），当前模型/通道无法识别图像内容"})
        if ext not in chat_attach.VISION_EXTS:
            return json.dumps({"error": f"图片格式 {f.ext} 暂不支持识别（如 svg 矢量图）"})
        if (f.size_bytes or 0) > chat_attach.VISION_READ_MAX:
            return json.dumps({"error": f"图片过大（{f.size}），超出可看上限"})
        try:
            data = await get_storage().get(f.storage_key)
            block = chat_attach.vision_block(data, ext)
        except Exception as e:
            return json.dumps({"error": f"读取失败：{str(e)[:80]}"})
        if not block:
            return json.dumps({"error": "图片无法解析"})
        return {"_vision_image": block,
                "note": f"已打开图片《{f.display_name}.{f.ext}》，见随附图像。"}

    is_doc = ext in doctext.EXTRACTABLE      # PDF/docx/xlsx/pptx 等，需工具提取文本
    is_text = _is_text_file_record(f)
    if not is_text and not is_doc:
        return json.dumps({"error": f"不支持读取该类型（{f.ext}），支持文本、PDF/Office、图片、音频和视频"})
    cap = doctext.EXTRACT_MAX_BYTES if is_doc else READ_MAX_BYTES
    if (f.size_bytes or 0) > cap:
        return json.dumps({"error": f"文件过大（{f.size}），超出可读上限"})
    try:
        data = await get_storage().get(f.storage_key)
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
    }


async def _edit_one(db, user_id, f, spec: dict) -> dict:
    """对已解析的 File f 应用一次编辑（mode + content/find/replace），各自 commit。返回结果 dict。
    供单个与批量 edit 共用。"""
    nm = f"{f.display_name}.{f.ext}"
    access_error = await file_write_access_error(db, user_id, f)
    if access_error:
        return {"error": access_error, "name": nm}
    if not _is_text_file_record(f):
        return {"error": f"不支持修改该类型（{f.ext}），仅支持文本类文件", "name": nm}
    if (f.size_bytes or 0) > READ_MAX_BYTES:
        return {"error": "文件过大，超出可改上限 256KB", "name": nm}
    storage = get_storage()
    try:
        old = (await storage.get(f.storage_key)).decode("utf-8")
    except Exception as e:
        return {"error": f"读取失败：文件不是有效的 UTF-8 文本或物理文件不可用（{str(e)[:80]}）", "name": nm}
    mode = spec.get("mode")
    # `change`：一句话改动摘要——给模型「反馈用户改了啥」的事实依据（按回执说，别自己编）。
    def _clip(s, n=24):
        s = (s or "").replace("\n", " ")
        return s[:n] + ("…" if len(s) > n else "")
    if mode == "append":
        add = spec.get("content", "")
        new = old + add
        change = f"末尾追加 {len(add)} 字"
    elif mode == "replace":
        new = spec.get("content", "")
        change = f"整体替换为 {len(new)} 字"
    elif mode == "find_replace":
        find = spec.get("find", "")
        if not find or find not in old:
            return {"error": "未找到要替换的内容（find）", "name": nm}
        rep = spec.get("replace", "")
        n = old.count(find)
        new = old.replace(find, rep)
        change = f"替换 {n} 处：「{_clip(find)}」→「{_clip(rep)}」"
    elif mode == "line_edit":
        try:
            new, changed_lines = apply_line_edits(old, spec.get("line_edits", []))
        except ValueError as exc:
            return {"error": str(exc), "name": nm}
        change = f"按行修改 {changed_lines} 行"
    else:
        return {"error": f"未知 mode: {mode}", "name": nm}
    data = new.encode("utf-8")
    if len(data) > READ_MAX_BYTES:
        return {"error": "修改后文件过大，单文件上限 256KB", "name": nm}
    await storage.put(f.storage_key, data, f.mime_type)
    f.size_bytes = len(data)
    f.size = _fmt_size(len(data))
    f.version = int(f.version or 1) + 1
    f.updated_at = now_utc()
    await db.commit()
    result = {"success": True, "file_id": f.id, "name": nm, "new_size": f.size, "change": change}
    # 内容骤降告警：行级整体替换也可能误删正文，改后显著变短时确定性提示模型核对。
    # 不全靠它自己「读回来发现」（配合 skills.md「改正文必须 read_file 读回比对」铁律）。
    if len(old) >= 200 and len(new) < len(old) * 0.5:
        result["warning"] = (
            f"⚠️ 改后内容明显变短（原约 {len(old)} 字 → 新约 {len(new)} 字）。"
            f"若你本只想改局部却用了整篇替换，可能把其它内容覆盖丢了——"
            f"请立刻 read_file 读回核对内容是否完整，缺了就补回。"
        )
    return result


async def _edit_file(db, user_id, args: dict):
    """改文本文件。单个：file + mode + content/find/replace。
    批量：edits=[{file 或 file_id, mode, content/find/replace}, ...]——一次改多个（多文件统一查找替换、
    或各文件不同编辑都行），省去 N 次调用。逐项回报成功/失败。"""
    items = args.get("edits")
    if items:
        edited, failed = [], []
        for it in items:
            if not isinstance(it, dict):
                failed.append({"item": it, "error": "每项需是 {file, mode, ...}"})
                continue
            f, _err = await _resolve_file(db, user_id, it)
            if _err:
                failed.append({"item": it.get("file") or it.get("file_id"), "error": "没找到这个文件"})
                continue
            r = await _edit_one(db, user_id, f, it)
            (edited if r.get("success") else failed).append(
                r if r.get("success") else {"item": it.get("file") or it.get("file_id"), **r})
        return {"success": True, "edited_count": len(edited), "failed_count": len(failed),
                "edited": edited, "failed": failed}
    # 单个
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    return await _edit_one(db, user_id, f, args)


async def _create_file(db, user_id, args: dict):
    """批量创建 UTF-8 文本文件；每项独立校验、写入和提交。"""
    items = args.get("files")
    if not isinstance(items, list) or not items:
        return {"error": "需要 files 数组；每项填写 name（含自定义扩展名）和 content"}
    if len(items) > 20:
        return {"error": "一次最多创建 20 个文件"}
    defaults = args.get("target")
    if defaults is None:
        defaults = {}
    if not isinstance(defaults, dict):
        return {"error": "target 必须是对象，支持 space/project_id/folder_id"}

    created, failed = [], []
    service = FileService(db)
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            failed.append({"index": index, "error": "每项必须是对象"})
            continue
        name = str(item.get("name") or "").strip()
        display_name, ext, name_error = _split_create_name(name)
        if name_error:
            failed.append({"index": index, "name": name, "error": name_error})
            continue
        content = item.get("content")
        if not isinstance(content, str):
            failed.append({"index": index, "name": name, "error": "content 必须是字符串"})
            continue
        if ext in _CREATE_BINARY_EXTS:
            failed.append({"index": index, "name": name,
                           "error": f"create_file 只写 UTF-8 文本，不能直接生成 {ext}；请使用上传文件"})
            continue
        data = content.encode("utf-8")
        if len(data) > READ_MAX_BYTES:
            failed.append({"index": index, "name": name, "error": "文件过大，单文件上限 256KB"})
            continue

        location_args = {**defaults, **{
            key: item[key] for key in ("space", "project_id", "folder_id") if key in item
        }}
        space, project_id, folder_id, workspace_directory_id, loc_err = await _resolve_create_location(
            db, user_id, location_args,
        )
        if loc_err:
            failed.append({"index": index, "name": name, "error": loc_err})
            continue
        if space not in _CREATE_SPACES:
            failed.append({"index": index, "name": name, "error": "create_file 只支持 personal/project/workspace 空间"})
            continue
        access_error = await write_access_error(
            db, user_id, space=space, project_id=project_id, folder_id=folder_id,
        )
        if access_error:
            failed.append({"index": index, "name": name, "error": access_error})
            continue

        try:
            result = await service.create_file(
                user_id,
                space=space,
                project_id=project_id if space == "project" else None,
                folder_id=folder_id,
                stage_name="",
                mind_map_id=None,
                display_name=display_name,
                ext=ext,
                # 未知后缀也按文本落库，保证 read/edit/前端预览使用同一事实。
                # svg 按 _DOC_MIME 落 image/svg+xml：read/edit 靠扩展名白名单（TEXT_EXTS
                # 含 svg）依旧可读写；落成 text/plain 会让缩略图/图片预览端点按 MIME 拒绝。
                mime_type=_DOC_MIME.get(ext, "text/plain"),
                data=data,
                workspace_directory_id=workspace_directory_id,
            )
            await db.commit()
        except Exception as e:
            await db.rollback()
            failed.append({"index": index, "name": name,
                           "error": redact(f"{type(e).__name__}: {e}")})
            continue
        db_file = result.file
        created.append({
            "index": index,
            "file_id": db_file.id,
            "name": f"{db_file.display_name}.{db_file.ext}",
            "size": db_file.size,
            **(await _location_receipt(db, user_id, space, project_id, folder_id)),
        })
    return {
        "success": True,
        "created_count": len(created),
        "failed_count": len(failed),
        "created": created,
        "failed": failed,
    }


async def _save_one_attach(db, user_id, meta: dict, *, space, project_id, folder_id, workspace_directory_id=None):
    """把一个已解析好的暂存附件 meta 落成文件库记录，返回 (ok, item)。供单个/批量 save 共用。"""
    access_error = await write_access_error(
        db, user_id, space=space, project_id=project_id, folder_id=folder_id,
    )
    if access_error:
        return False, {"error": access_error}
    from app.core import chat_attach
    ext = meta.get("ext") or "bin"
    display_name = meta.get("name") or "上传文件"
    try:
        data = await chat_attach.read_bytes(meta)
    except Exception as e:
        return False, {"name": f"{display_name}.{ext}", "error": f"读取附件失败：{str(e)[:80]}"}
    try:
        result = await FileService(db).create_file(
            user_id,
            space=space,
            project_id=project_id if space == "project" else None,
            folder_id=folder_id,
            workspace_directory_id=workspace_directory_id,
            stage_name="",
            mind_map_id=None,
            display_name=display_name,
            ext=ext,
            mime_type=meta.get("mime") or "application/octet-stream",
            data=data,
        )
    except Exception as e:
        return False, {"name": f"{display_name}.{ext}", "error": redact(f"{type(e).__name__}: {e}")}
    await db.commit()
    db_file = result.file
    return True, {"file_id": db_file.id, "name": f"{db_file.display_name}.{db_file.ext}",
                  "size": db_file.size,
                  **(await _location_receipt(db, user_id, space, project_id, folder_id))}


async def _save_uploaded_file(db, user_id, args: dict):
    """把用户聊天里上传的暂存附件保存进文件库。默认 personal，可直接指定项目/文件夹。
    单个：attach_id。批量（同一批连发的多个附件，如连拍的几张图）：attach_ids=[id1,id2,...]——
    每个各自精确解析，比逐个分别调用更可靠（避免每次没对上都各自回退、可能救回不相关的附件，
    如把连发图片之外的一条语音存进来了；见 resolve_attach 的歧义防护）。"""
    from app.core import chat_attach

    source = args.get("source")
    if source == "latest":
        args = {**args, "attach_id": None, "attach_ids": None}
    elif source == "attach_id" and not args.get("attach_id"):
        return {"error": "source=attach_id 时必须提供 attach_id"}
    elif source == "attach_ids" and not args.get("attach_ids"):
        return {"error": "source=attach_ids 时必须提供 attach_ids"}

    space, project_id, folder_id, workspace_directory_id, loc_err = await _resolve_create_location(db, user_id, args)
    if loc_err:
        return loc_err

    ids = args.get("attach_ids")
    if ids:
        if not isinstance(ids, list):
            return json.dumps({"error": "attach_ids 需要是数组"}, ensure_ascii=False)
        saved, failed = [], []
        for aid in ids:
            meta, note = await chat_attach.resolve_attach(user_id, str(aid or ""))
            if not meta:
                failed.append({"attach_id": aid,
                               "error": note or "没找到可保存的附件，可能确实过期了（聊天附件只暂存 7 天）。"})
                continue
            ok, item = await _save_one_attach(db, user_id, meta, space=space,
                                              project_id=project_id, folder_id=folder_id,
                                              workspace_directory_id=workspace_directory_id)
            (saved if ok else failed).append(item)
        return {"success": True, "saved_count": len(saved), "failed_count": len(failed),
                "saved": saved, "failed": failed}

    # 单个（兼容旧行为）
    meta, note = await chat_attach.resolve_attach(user_id, args.get("attach_id") or "")
    if not meta:
        return json.dumps({"error": note or "没找到可保存的附件，可能确实过期了（聊天附件只暂存 7 天）。"
                                    "麻烦让用户重新发一下～"}, ensure_ascii=False)
    ok, item = await _save_one_attach(db, user_id, meta, space=space, project_id=project_id,
                                      folder_id=folder_id, workspace_directory_id=workspace_directory_id)
    if not ok:
        return json.dumps(item, ensure_ascii=False)
    return {**item, **({"note": note} if note else {})}


async def _rename_one(db, user_id, f, new_name: str, new_fmt: str | None = None) -> dict:
    """重命名已解析的 File f，各自 commit。返回结果 dict。供单个与批量 rename 共用。

    new_fmt 为 None 时沿用 f.ext（旧行为，"改名不改格式"）。传了新 fmt 就用规范 ext，
    用于修双后缀文件：new_name="README" + new_fmt="md" 会把 f.ext="markdown" 的
    README.md.markdown 改成 README.md。文本类互相转也走这条；非文本类（docx/pdf/xlsx）
    仅当 new_fmt 等于当前 ext 时允许"改名不改内容"，跨文本/二进制的格式转换请重新上传，
    而不是把 rename 当成转换工具。
    """
    old_ext = f.ext
    access_error = await file_write_access_error(db, user_id, f)
    if access_error:
        return {"error": access_error, "name": f"{f.display_name}.{f.ext}"}
    if new_fmt is not None:
        fmt = new_fmt.lower()
        if fmt not in _DOC_MIME:
            return {"error": f"不支持的格式: {fmt}", "supported": list(_DOC_MIME), "name": f"{f.display_name}.{f.ext}"}
        new_ext = _DOC_EXT.get(fmt, fmt)
        # 格式转换只在文本家族内允许：源是图片等二进制后缀（png/jpg…，不在 _DOC_MIME）
        # 或目标是 docx/pdf/xlsx 时，改后缀只会产出内容对不上的坏文件，一律拒绝
        if new_ext != old_ext and (old_ext not in _DOC_MIME or new_ext in ("docx", "pdf", "xlsx")):
            return {"error": f"rename 不能跨文本/二进制格式（{old_ext}→{new_ext}），请用 edit_file 走 LibreOffice 转换",
                    "name": f"{f.display_name}.{f.ext}"}
    else:
        new_ext = old_ext
    new_display = _strip_ext(new_name, new_ext)
    try:
        new_key = await _resolve_key(
            db, user_id, f.space, new_display, new_ext,
            project_id=f.project_id, folder_id=f.folder_id,
            workspace_directory_id=getattr(f, "workspace_directory_id", None),
        )
    except ValueError as e:
        return {"error": str(e), "name": f"{f.display_name}.{f.ext}"}
    storage = get_storage()
    if new_key != f.storage_key:
        new_key, new_display = await _resolve_conflict(storage, new_key, new_display, new_ext)
        try:
            await storage.rename_file(f.storage_key, new_key)
        except Exception as e:
            return {"error": f"重命名失败（物理文件可能已丢失）：{str(e)[:80]}", "name": f"{f.display_name}.{f.ext}"}
        f.storage_key = new_key
    old = f.display_name
    f.display_name = new_display
    if new_ext != old_ext:
        # 文本类同族转换（md↔txt↔yaml…）是显示层差异，内容不需要重写；mime 跟着规范 ext 走
        f.ext = new_ext
        f.mime_type = _DOC_MIME[new_ext]
    f.updated_at = now_utc()
    await db.commit()
    return {"success": True, "file_id": f.id, "old_name": f"{old}.{old_ext}", "name": f"{new_display}.{f.ext}"}


async def _rename_file(db, user_id, args: dict):
    """重命名文件。单个：file/file_id + new_name。
    批量：renames=[{file 或 file_id, new_name, format?}, ...]——适合「按顺序编号」，Agent 自己生成序号、一次调用全改。
    可选 format：传了就改后缀（修 .md.markdown 这种双后缀文件 → format="md"），不传沿用旧 ext。
    """
    items = args.get("renames")
    if items:
        renamed, failed = [], []
        for it in items:
            if not isinstance(it, dict) or not str(it.get("new_name") or "").strip():
                failed.append({"item": it, "error": "每项需要 new_name"})
                continue
            f, _err = await _resolve_file(db, user_id, it)
            if _err:
                failed.append({"item": it.get("file") or it.get("file_id"), "error": "没找到这个文件"})
                continue
            r = await _rename_one(db, user_id, f, it["new_name"], it.get("format"))
            (renamed if r.get("success") else failed).append(
                r if r.get("success") else {"item": it.get("file") or it.get("file_id"), **r})
        return {"success": True, "renamed_count": len(renamed), "failed_count": len(failed),
                "renamed": renamed, "failed": failed}
    # 单个
    if not str(args.get("new_name") or "").strip():
        return json.dumps({"error": "需要 new_name；批量改名用 renames=[{file,new_name},...]"})
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    return await _rename_one(db, user_id, f, args["new_name"], args.get("format"))


async def _delete_file(db, user_id, args: dict):
    # 软删进回收站，30 天可还原 —— 非不可逆，无需二次确认
    file_ids = args.get("file_ids")
    if file_ids is not None:
        if not isinstance(file_ids, list) or not file_ids or len(file_ids) > 50:
            return json.dumps({"error": "file_ids 必须是 1-50 个文件 id"})
        files = []
        for file_id in file_ids:
            file, error = await _resolve_file(db, user_id, {"file_id": file_id})
            if error:
                return error
            access_error = await file_write_access_error(db, user_id, file)
            if access_error:
                return {"error": access_error}
            files.append(file)
        results = []
        for file in files:
            await delete_file_action(db, get_storage(), user_id, file.id, now_utc())
            results.append({"file_id": file.id, "name": f"{file.display_name}.{file.ext}",
                            "note": "已移入回收站，30 天内可还原",
                            "_file_op": {"op": "remove", "kind": "file", "id": file.id}})
        await db.commit()
        return {"success": True, "deleted_count": len(results), "results": results}
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    access_error = await file_write_access_error(db, user_id, f)
    if access_error:
        return {"error": access_error}
    fid = f.id; fname = f"{f.display_name}.{f.ext}"
    await delete_file_action(db, get_storage(), user_id, f.id, now_utc())
    await db.commit()
    return {"success": True, "file_id": fid, "name": fname,
            "note": "已移入回收站，30 天内可还原",
            "_file_op": {"op": "remove", "kind": "file", "id": fid}}


async def _copy_file(db, user_id, args: dict):
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    if args.get("destination") == "same" and args.get("target"):
        return {"error": "destination=same 时不能同时提供 target"}
    target = _norm_target(args.get("target", {}))
    workspace_target = await _bound_workspace_target(db, user_id)
    if workspace_target is not None and not any(
        target.get(key) not in (None, "") for key in ("space", "project_id", "folder_id", "folder")
    ):
        target = {key: workspace_target.get(key) for key in ("space", "project_id", "folder_id", "workspace_directory_id")}
    space, project_id, folder_id, workspace_directory_id = _target_loc(f, target)
    space, project_id, folder_id, loc_err = _coerce_loc(space, project_id, folder_id)
    if loc_err:
        return loc_err
    if space == "workspace" and workspace_directory_id is None:
        # 显式 workspace ＝ 当前绑定工作区（与 create_file/_resolve_target 一致，不暴露跨工作区）
        bound = await _bound_workspace_target(db, user_id)
        workspace_directory_id = (bound or {}).get("workspace_directory_id")
        if workspace_directory_id is None:
            return {"error": "当前会话没有绑定带文件目录的工作区，无法以 space=workspace 为目标"}
    fname = target.get("folder")
    if fname is not None:
        fname = str(fname).strip()
        if fname in ("", "根", "根目录", "/"):
            folder_id = None
        else:
            fo, err = await _folder_by_name(
                db, user_id, fname, space, project_id, workspace_directory_id,
            )
            if err:
                return err
            folder_id = fo.id
            # 复制目标以文件夹的项目为准，与 _move_one 保持一致
            if fo.project_id is not None:
                project_id = fo.project_id
                space = "project"
            workspace_directory_id = fo.workspace_directory_id
    if workspace_target is not None and not await _location_matches(
        db, user_id, space, project_id, folder_id, workspace_target,
    ):
        return _workspace_conflict(workspace_target)
    target_error = await write_access_error(
        db, user_id, space=space, project_id=project_id, folder_id=folder_id,
    )
    if target_error:
        return {"error": target_error, "name": f"{f.display_name}.{f.ext}"}
    try:
        result = await FileService(db).copy_file(
            user_id, f.id, folder_id=folder_id,
            project_id=project_id if space == "project" else None,
            workspace_directory_id=workspace_directory_id if space == "workspace" else None,
        )
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    await db.commit()
    new_file = result.file
    return {"success": True, "file_id": new_file.id,
            "name": f"{new_file.display_name}.{new_file.ext}"}


# ── 网络图片下载（send_file 的 url 分支用）：SSRF 防护 ─────────────────────────
from .transfer import (
    _normalize_send_path,
    _stage_send_path,
    _send_file_from_url,
    _send_file,
    _present_file,
    _list_recent_attachments,
    inspect_image_url,
    _build_pinned_request,
    _url_is_safe,
    _SEND_URL_MAX_BYTES,
    _SEND_URL_IMAGE_EXT,
)


class FilesSkill(BaseSkill):
    name = "files"
    tools = [
        Tool(
            name="list_files", label="查询文件",
            description_short='查询文件；默认覆盖当前用户可访问的所有空间。',
            description="按空间、项目、工作区、文件夹、扩展名或名称关键词查询文件；不传位置条件时查询当前用户所有可访问空间，结果含完整 folder_path。",
            input_schema={
                "type": "object",
                "properties": {
                    "space": {"type": "string", "enum": ["project", "workspace", "mind", "asset", "personal"]},
                    "project_id": {"type": "integer"},
                    "folder_id": {"type": "integer"},
                    "workspace_directory_id": {"type": "integer"},
                    "folder": {"type": "string"},
                    "ext": {"type": "string"},
                    "query": {"type": "string"},
                    "q": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "mode": {"type": "string", "enum": ["OR", "AND"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                },
            },
            repeat_safe=True,
            handler=_list_files,
        ),
        Tool(
            name="read_file", label="读取文件",
            description_short='读取文件内容；支持按行范围读取，图片会交给视觉模型查看。',
            description="读取文本、文档、表格、图片、音频或视频并返回与问题相关的内容；文本/文档可用 target_lines 按原始物理行读取，支持 all、8、8-11、8,11，默认 all；文件库位图会直接交给视觉模型查看，SVG 按源码文本读取；不要把本地路径或 file:/// URI 传给 inspect_images。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "target_lines": {"type": "string", "pattern": "^(all|[0-9]+([-,][0-9]+)?)$"},
                },
                "required": [],
            },
            repeat_safe=True,
            handler=_read_file,
        ),
        Tool(
            name="grep", label="搜索文件正文",
            description_short='在当前权限内的个人、项目和 Workspace 文本文件中查找内容。',
            description="按关键词逐行搜索当前用户有权访问的个人、项目和 Workspace 文本文件；返回 file_id、逻辑路径、命中行号、匹配行和可选上下文，不执行 Shell grep。可用 context_lines 控制命中行前后行数，limit 限制总命中数；需要完整正文或精确读取时再调用 read_file。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "path": {"type": "string", "description": "可选逻辑路径，如 /personal/F1、/project/项目名、/workspace/workspace-1"},
                    "context_lines": {"type": "integer", "minimum": 0, "maximum": 20},
                    "case_sensitive": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            repeat_safe=True,
            handler=_grep_files,
        ),
        Tool(
            name="edit_file", label="修改文件",
            description_short='修改 UTF-8 文本文件；支持整体替换、追加和查找替换。',
            description="修改 UTF-8 文本文件；支持整体替换、追加、查找替换和按 target_lines 更新/删除指定行，多个文件用 edits 批量处理。target_lines 支持 8、8-11、8,11，content 为空表示删除；行号以最新 read_file 内容为准，多个范围不能重叠。",
            input_schema={
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string"},
                                "file_id": {"type": "integer"},
                                "mode": {"type": "string", "enum": ["replace", "append", "find_replace", "line_edit"]},
                                "content": {"type": "string"},
                                "find": {"type": "string"},
                                "replace": {"type": "string"},
                                "line_edits": {"type": "array", "items": {"type": "object", "properties": {"target_lines": {"type": "string", "pattern": "^(all|[0-9]+([-,][0-9]+)?)$"}, "content": {"type": "string"}, "expected": {"type": "string"}}, "required": ["target_lines", "content"], "additionalProperties": False}},
                            },
                            "required": ["mode"],
                            "allOf": [
                                {
                                    "if": {"required": ["mode"], "properties": {"mode": {"const": "replace"}}},
                                    "then": {
                                        "required": ["content"],
                                        "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}, {"required": ["line_edits"]}]},
                                    },
                                },
                                {
                                    "if": {"required": ["mode"], "properties": {"mode": {"const": "append"}}},
                                    "then": {
                                        "required": ["content"],
                                        "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}]},
                                    },
                                },
                                {
                                    "if": {"required": ["mode"], "properties": {"mode": {"const": "find_replace"}}},
                                    "then": {
                                        "required": ["find", "replace"],
                                        "not": {"required": ["content"]},
                                    },
                                },
                                {"if": {"required": ["mode"], "properties": {"mode": {"const": "line_edit"}}}, "then": {"required": ["line_edits"], "not": {"anyOf": [{"required": ["content"]}, {"required": ["find"]}, {"required": ["replace"]}]}}},
                            ],
                        },
                    },
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "mode": {"type": "string", "enum": ["replace", "append", "find_replace", "line_edit"]},
                    "content": {"type": "string"},
                    "find": {"type": "string"},
                    "replace": {"type": "string"},
                    "line_edits": {"type": "array", "items": {"type": "object", "properties": {"target_lines": {"type": "string", "pattern": "^(all|[0-9]+([-,][0-9]+)?)$"}, "content": {"type": "string"}, "expected": {"type": "string"}}, "required": ["target_lines", "content"], "additionalProperties": False}},
                },
                "allOf": [
                    {"if": {"required": ["mode"], "properties": {"mode": {"const": "replace"}}}, "then": {"required": ["content"], "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}, {"required": ["line_edits"]}]}}},
                    {"if": {"required": ["mode"], "properties": {"mode": {"const": "line_edit"}}}, "then": {"required": ["line_edits"], "not": {"anyOf": [{"required": ["content"]}, {"required": ["find"]}, {"required": ["replace"]}]}}},
                    {
                        "if": {"required": ["mode"], "properties": {"mode": {"const": "append"}}},
                        "then": {
                            "required": ["content"],
                            "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}]},
                        },
                    },
                    {
                        "if": {"required": ["mode"], "properties": {"mode": {"const": "find_replace"}}},
                        "then": {
                            "required": ["find", "replace"],
                            "not": {"required": ["content"]},
                        },
                    },
                ],
            },
            handler=_edit_file,
            mutates=True,
        ),
        Tool(
            name="create_file", label="创建文件",
            description_short='批量创建 UTF-8 文本文件；支持自定义扩展名。',
            description="批量创建 UTF-8 文本文件；files 必须是数组，name 和 content 写在数组项内，不要放到顶层。每项填写完整文件名（如 script.py、page.html、config.custom）和 content，未知扩展名也按文本保存。可用 target 指定默认 personal/project、project_id、folder_id，单项可覆盖；会话绑定 Workspace 时可显式传 target.space=workspace（或整体省略目标参数）写入当前工作区。不做格式转换、不执行内容，同名自动保留副本。",
            input_schema={
                "type": "object",
                "properties": {
                    "target": {
                        "type": "object",
                        "properties": {
                            "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                            "project_id": {"type": "integer"},
                            "folder_id": {"type": "integer"},
                        },
                        "additionalProperties": False,
                    },
                    "files": {
                        "type": "array", "minItems": 1, "maxItems": 20,
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "minLength": 1, "maxLength": 300},
                                "content": {"type": "string", "maxLength": 262144},
                                "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                                "project_id": {"type": "integer"},
                                "folder_id": {"type": "integer"},
                            },
                            "required": ["name", "content"],
                            "additionalProperties": False,
                            "allOf": [
                                {
                                    "if": {"required": ["space"], "properties": {"space": {"const": "project"}}},
                                    "then": {"required": ["project_id"]},
                                },
                            ],
                        },
                    },
                },
                "required": ["files"],
                "additionalProperties": False,
            },
            handler=_create_file,
            mutates=True,
        ),
        Tool(
            name="rename_file", label="重命名文件",
            description_short='重命名文件；可选修改扩展名。',
            description="重命名文件，可单个或批量修改名称及后缀，不改变位置。",
            input_schema={
                "type": "object",
                "properties": {
                    "renames": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string"},
                                "file_id": {"type": "integer"},
                                "new_name": {"type": "string"},
                                "format": {"type": "string", "enum": sorted(_DOC_MIME)},
                            },
                            "required": ["new_name"],
                        },
                    },
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "new_name": {"type": "string"},
                    "format": {"type": "string", "enum": sorted(_DOC_MIME)},
                },
            },
            handler=_rename_file,
            mutates=True,
        ),
        Tool(
            name="move_items", label="移动文件/文件夹",
            description_short='移动文件或文件夹；批量传 files/folders，目标传 target；folder_id 优先，project 空间传 project_id',
            description="批量移动文件或文件夹；源项传 files/folders，目标传 target。目标空间用 target.space（project/workspace/mind/asset/personal），workspace＝当前绑定工作区；项目目标用 project_id。",
            input_schema={
                "type": "object",
                "properties": {
                    "files":   {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "integer"}]}},
                    "folders": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "integer"}]}},
                    "target": {
                        "type": "object",
                        "properties": {
                            "folder": {"type": "string"},
                            "folder_id": {"type": "integer"},
                            "space": {"type": "string", "enum": ["project", "workspace", "mind", "asset", "personal"]},
                            "project_id": {"type": "integer"},
                        },
                    },
                    "destination": {"type": "string", "enum": ["same", "folder"]},
                },
                "required": ["target"],
            },
            handler=_move_items,
            mutates=True,
        ),
        Tool(
            name="copy_file", label="复制文件",
            description_short='复制文件。',
            description="复制一份文件到目标位置（target.folder 填文件夹名；不填则在原位复制一份）。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "target": {
                        "type": "object",
                        "properties": {
                            "folder": {"type": "string"},
                            "space": {"type": "string", "enum": ["project", "workspace", "mind", "asset", "personal"]},
                            "project_id": {"type": "integer"},
                            "folder_id": {"type": "integer"},
                        },
                    },
                },
                "oneOf": [
                    {"required": ["file_id"], "not": {"required": ["file"]}},
                    {"required": ["file"], "not": {"required": ["file_id"]}},
                ],
                "allOf": [
                    {"if": {"required": ["destination"], "properties": {"destination": {"const": "folder"}}}, "then": {"required": ["target"]}},
                    {"if": {"required": ["destination"], "properties": {"destination": {"const": "same"}}}, "then": {"not": {"required": ["target"]}}},
                ],
            },
            handler=_copy_file,
            mutates=True,
        ),
        Tool(
            name="create_folder", label="新建文件夹",
            description_short='新建文件夹。',
            description="新建文件夹，可指定所属项目与父文件夹（支持嵌套）。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "project_id": {"type": "integer"},
                    "parent_id": {"type": "integer"},
                },
                "required": ["name"],
            },
            handler=_create_folder,
            mutates=True,
        ),
        Tool(
            name="delete_file", label="删除文件",
            description_short='删除文件到回收站。',
            description="删除一个或多个文件（移入回收站，30 天内可还原，非永久删除）。单项传 file_id/file，批量传 file_ids。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "file_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                },
                "required": [],
            },
            handler=_delete_file,
            mutates=True,
        ),
        Tool(
            name="list_folders", label="查询文件夹",
            description_short='查询文件夹；默认覆盖当前用户可访问的所有空间。',
            description="列出文件夹，可按空间、项目、工作区或父文件夹筛选；不传位置条件时查询当前用户所有可访问空间。"
                        "返回 path（根到叶的完整路径）与 depth，决定新文件落点时据此审视一级和相关二级目录。",
            input_schema={
                "type": "object",
                "properties": {
                    "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                    "project_id": {"type": "integer"},
                    "parent_id": {"type": "integer"},
                    "workspace_directory_id": {"type": "integer"},
                },
            },
            repeat_safe=True,
            handler=_list_folders,
        ),
        Tool(
            name="rename_folder", label="重命名文件夹",
            description_short='重命名文件夹；跨项目存在同名文件夹时按项目范围定位。',
            description="重命名文件夹。用 name 指定要改的文件夹名（或用 folder_id）。同名文件夹存在于多个项目时必须传 project_id 避免误操作。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "folder_id": {"type": "integer"},
                    "project_id": {"type": "integer"},
                    "new_name": {"type": "string"},
                },
                "required": ["new_name"],
            },
            handler=_rename_folder,
            mutates=True,
        ),
        Tool(
            name="delete_folder", label="删除文件夹",
            description_short='删除文件夹；跨项目存在同名文件夹时按项目范围定位。',
            description="删除一个或多个文件夹。单项用 name/folder_id，批量传 folder_ids。文件夹及其内容会整体移入回收站，30 天内可恢复。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "folder_id": {"type": "integer"},
                    "folder_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                    "project_id": {"type": "integer"},
                },
            },
            handler=_delete_folder,
            mutates=True,
        ),
        Tool(
            name="send_file", label="发送文件",
            description_short='发送文件或图片。',
            description="把文件、网络图片或暂存附件真正发送给用户；仅在用户明确要发送时调用。文件库文件优先使用 list_files 返回的 file_id；也支持 Shell 逻辑路径 /workspace/...、/personal/...、/project/...，不要把路径填到 file_id。查位置请用文件链接。",
            input_schema={
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "file_id": {"type": "integer"},
                    "url": {"type": "string"},
                    "title": {"type": "string"},
                    "attach_id": {"type": "string"},
                    "source_type": {"type": "string", "enum": ["file", "file_id", "url", "attach_id"]},
                },
                "oneOf": [
                    {"required": ["file"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["url"]}, {"required": ["attach_id"]}]}},
                    {"required": ["file_id"], "not": {"anyOf": [{"required": ["file"]}, {"required": ["url"]}, {"required": ["attach_id"]}]}},
                    {"required": ["url"], "not": {"anyOf": [{"required": ["file"]}, {"required": ["file_id"]}, {"required": ["attach_id"]}]}},
                    {"required": ["attach_id"], "not": {"anyOf": [{"required": ["file"]}, {"required": ["file_id"]}, {"required": ["url"]}]}},
                ],
                "allOf": [
                    {"if": {"required": ["title"]}, "then": {"required": ["url"]}},
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "file"}}}, "then": {"required": ["file"]}},
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "file_id"}}}, "then": {"required": ["file_id"]}},
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "url"}}}, "then": {"required": ["url"]}},
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "attach_id"}}}, "then": {"required": ["attach_id"]}},
                ],
            },
            handler=_send_file,
            mutates=True,
        ),
        Tool(
            name="present_file", label="在网页展示文件",
            description_short='把文件直接推到用户当前网页上打开预览。',
            description="把文件库里的文件直接推到用户当前网页上打开预览（图片/音频/视频/文档立即展示）。"
                        "仅在用户明确要求「打开/展示/给我看」某个文件时调用；不产生聊天附件，IM 会话里不可用。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                },
                "required": [],
                # oneOf：file 与 file_id 恰好给一个；不能用 allOf 写互斥（两条 required 子句会互相矛盾，任何输入都过不了）
                "oneOf": [
                    {"required": ["file"], "not": {"required": ["file_id"]}},
                    {"required": ["file_id"], "not": {"required": ["file"]}},
                ],
            },
            handler=_present_file,
        ),
        Tool(
            name="list_recent_attachments", label="查最近暂存的附件",
            description_short='查最近暂存的附件；用于找回近期图片或文件',
            description="列出当前仍在暂存区的聊天附件；可用于找回近期图片或文件，再发送或保存。",
            input_schema={"type": "object", "properties": {}},
            repeat_safe=True,
            handler=_list_recent_attachments,
        ),
        Tool(
            name="save_uploaded_file", label="保存上传文件",
            description_short='保存聊天附件到文件库。',
            description="保存对话附件到文件库；多个附件用 attach_ids，可指定项目或文件夹。",
            input_schema={
                "type": "object",
                "properties": {
                    "attach_id": {"type": "string"},
                    "attach_ids": {"type": "array", "items": {"type": "string"}},
                    "project_id": {"type": "integer"},
                    "folder_id": {"type": "integer"},
                    "source": {"type": "string", "enum": ["latest", "attach_id", "attach_ids"]},
                },
                "required": [],
                "allOf": [
                    {"if": {"required": ["source"], "properties": {"source": {"const": "latest"}}}, "then": {"not": {"anyOf": [{"required": ["attach_id"]}, {"required": ["attach_ids"]}]} }},
                    {"if": {"required": ["source"], "properties": {"source": {"const": "attach_id"}}}, "then": {"required": ["attach_id"]}},
                    {"if": {"required": ["source"], "properties": {"source": {"const": "attach_ids"}}}, "then": {"required": ["attach_ids"]}},
                    {"not": {"required": ["attach_id", "attach_ids"]}},
                ],
            },
            handler=_save_uploaded_file,
            mutates=True,
        ),
    ]
