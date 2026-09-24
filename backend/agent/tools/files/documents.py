"""文件文档操作：文本/Office 文件的列表、读取、编辑与管理。

复用文件服务层的现成 helper（`_build_key`/`_resolve_conflict`/
`_fmt_size`/`color_value`）、`app.services.storage.trash`（`move_file_to_trash`）与
存储层 `get_storage()`，整理类工具复刻 `update_file` 的 key 重建逻辑，不自己拼路径。

编辑和创建仅限 UTF-8 文本且 ≤256KB，已知文本扩展名和文件记录的 text/* MIME 都支持。
创建（create_file）支持批量文件和自定义后缀，不做格式转换、不执行文件内容；读取编排见 read.py。
"""
import json
import re

from sqlalchemy import select

from app.core.redaction import redact
from app.core.tz import now_utc
from app.services.storage.folders import resolve_folder_path
from app.services.files.response import color_value
from app.services.files.browser import (
    count_user_files,
    descendant_folder_ids,
    find_user_files_by_name,
    find_user_folders_by_name,
    get_user_file,
    get_user_folder,
    list_user_folders,
    search_user_files,
)
from app.services.storage.file_service.files import _fmt_size
from app.services.files.actions import delete_file as delete_file_action
from app.services.storage.keys import _build_key, _resolve_conflict
from app.models import File  # orm-exempt: list_dir 文件夹文件数只读统计，随 files Service 收口一并迁移（1.1.2 遗留口径）
from app.services.storage.file_service import FileService
from app.search.query import normalize_queries
from agent.tools.text_edit import apply_line_edits
from .locations import (
    _bound_workspace_target, _coerce_loc, _folder_by_name,
    _location_receipt, _norm_target,
    _resolve_create_location, _resolve_file as _locations_resolve_file, _resolve_key,
    _target_loc,
)


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
async def _resolve_folder_path(db, user_id, raw: str, space, project_id, workspace_directory_id):
    """把「个人文件/参考素材/方案」式路径（或单名）解析成 folder id。

    按 "/" 切分逐级下钻：第一段若是空间别名（personal/个人文件）则映射为 space；
    其余每段在上一级的子文件夹里按名匹配（精确优先，unique 才继续）。解析到第 i 级
    失败时，报错带上一级实际存在的子目录，模型能自我纠正而不是瞎猜。
    返回 (folder_id|None, 错误JSON|None)；空路径返回 (None, None) 表示不限目录。
    """
    raw = str(raw).strip().strip("/")
    if not raw:
        return None, None
    segments = [seg for seg in (part.strip() for part in raw.split("/")) if seg]
    if not segments:
        return None, None

    if len(segments) > 1 and segments[0].lower() in ("personal", "个人文件", "个人"):
        space = space or "personal"
        segments = segments[1:]

    parent_id = None
    for depth, seg in enumerate(segments):
        named = await find_user_folders_by_name(
            db, user_id, seg, space=space, project_id=project_id,
            workspace_directory_id=workspace_directory_id,
        )
        # 逐级约束：depth 0 只认根目录（parent_id is None），与 _folder_by_name
        # 「重名优先顶层」的语义一致——否则嵌套同名目录会让根路径误报歧义
        candidates = [folder for folder in named if folder.parent_id == parent_id]
        if not candidates:
            siblings = await list_user_folders(
                db, user_id, space=space, project_id=project_id,
                parent_id=parent_id,
                workspace_directory_id=workspace_directory_id,
                filter_parent=True,
            )
            where = "「{}」下".format(segments[depth - 1]) if depth else "根目录"
            return None, json.dumps({
                "error": "路径解析失败：{}没有名为「{}」的文件夹".format(where, seg),
                "available_folders": sorted({folder.name for folder in siblings}),
            })
        if len(candidates) > 1:
            return None, json.dumps({
                "error": "路径解析失败：第 {} 级「{}」有多个同名文件夹，请改用 folder_id".format(depth + 1, seg),
                "candidates": [{"id": folder.id, "parent_id": folder.parent_id} for folder in candidates],
            })
        parent_id = candidates[0].id
    return parent_id, None


async def _list_dir(db, user_id, args: dict):
    """统一目录浏览：一次返回目录内的子文件夹与文件（取代 list_files/list_folders）。

    folder 不传时 folders 只含各空间根目录；传了（id 或名字）时 folders 为该目录的子文件夹、files 为直属文件。
    文件夹只返回当前层的直属子目录，不递归展开。parent_id 是 folder 的纯 id 形式。
    limit 只约束 files，folders 恒全量。
    """
    kind = args.get("kind") if args.get("kind") in ("both", "file", "folder") else "both"

    folder_value = args.get("folder_id")
    if folder_value in (None, ""):
        folder_value = args.get("folder")
    if folder_value in (None, ""):
        folder_value = args.get("parent_id")
    scope_folder_id = None
    if folder_value not in (None, ""):
        try:
            scope_folder_id = int(str(folder_value).strip().lstrip("#"))
        except (TypeError, ValueError):
            if "/" in str(folder_value).strip().strip("/"):
                scope_folder_id, error = await _resolve_folder_path(
                    db, user_id, folder_value,
                    args.get("space"), args.get("project_id"),
                    args.get("workspace_directory_id"),
                )
            else:
                folder, error = await _folder_by_name(
                    db,
                    user_id,
                    folder_value,
                    args.get("space"),
                    args.get("project_id"),
                    args.get("workspace_directory_id"),
                )
                scope_folder_id = folder.id if folder is not None else None
            if error:
                return error

    file_queries = normalize_queries(
        args.get("query") or args.get("q"), args.get("queries") if isinstance(args.get("queries"), list) else None,
    )
    requested_limit = args.get("limit", 100)
    try:
        limit = max(1, min(int(requested_limit), 200))
    except (TypeError, ValueError):
        limit = 100

    out_files: list[dict] = []
    total = 0
    if kind != "folder":
        filter_kwargs = dict(
            space=args.get("space"),
            project_id=args.get("project_id"),
            folder_id=scope_folder_id,
            workspace_directory_id=args.get("workspace_directory_id"),
            ext=args.get("ext"),
            queries=file_queries,
            mode=args.get("mode"),
        )
        offset = max(0, int(args.get("offset") or 0))
        sort = args.get("sort") if args.get("sort") in ("updated", "name") else "updated"
        rows = await search_user_files(
            db, user_id, limit=limit, offset=offset, sort=sort, **filter_kwargs,
        )
        total = await count_user_files(db, user_id, **filter_kwargs)
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
            out_files.append({
                "id": file.id, "name": f"{file.display_name}.{file.ext}", "ext": file.ext,
                "space": file.space, "size": file.size, "project_id": file.project_id,
                "folder_id": file.folder_id, "folder_path": folder_path,
            })

    out_folders: list[dict] = []
    if kind != "file":
        folder_rows = await list_user_folders(
            db, user_id,
            space=args.get("space"),
            project_id=args.get("project_id"),
            parent_id=scope_folder_id,
            workspace_directory_id=args.get("workspace_directory_id"),
            filter_parent=True,
        )
        counts: dict[int, int] = {}
        folder_ids = [folder.id for folder in folder_rows]
        if folder_ids:
            from sqlalchemy import func
            stmt = (
                select(File.folder_id, func.count())  # orm-exempt: list_dir 文件夹文件数只读统计，随 files Service 收口一并迁移（1.1.2 遗留口径）
                .where(
                    File.user_id == user_id,
                    File.deleted_at.is_(None),
                    File.folder_id.in_(folder_ids),
                )
                .group_by(File.folder_id)
            )
            counts = dict((await db.execute(stmt)).all())  # orm-exempt: list_dir 文件夹文件数只读统计，随 files Service 收口一并迁移（1.1.2 遗留口径）
        for folder in folder_rows:
            resolved = await resolve_folder_path(
                db, user_id, folder.id, folder.project_id,
                folder.workspace_directory_id,
            )
            if not resolved:
                continue
            _, path = resolved
            out_folders.append({
                "id": folder.id, "name": folder.name, "path": path,
                "project_id": folder.project_id, "parent_id": folder.parent_id,
                "depth": path.count("/"),
                "file_count": counts.get(folder.id, 0),
            })
        out_folders.sort(key=lambda item: (item["depth"], item["path"]))

    # shown/total 只统计 files（folders 只含当前层且恒全量、无截断语义）：shown<total 说明被
    # limit 截断，必须加大 limit 重查或加过滤条件，不能把前 N 条当全量下结论。
    return {"shown": len(out_files), "total": total, "files": out_files, "folders": out_folders}


async def _edit_one(db, user_id, f, spec: dict) -> dict:
    """对已解析的 File f 应用一次编辑（mode + content/find/replace），各自 commit。返回结果 dict。
    供单个与批量 edit 共用。"""
    nm = f"{f.display_name}.{f.ext}"
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
        if not _valid_file_ids(file_ids):
            return json.dumps({"error": "file_ids 必须是 1-50 个文件 id"})
        files = []
        for file_id in file_ids:
            file, error = await _resolve_file(db, user_id, {"file_id": file_id})
            if error:
                return error
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
    fid = f.id; fname = f"{f.display_name}.{f.ext}"
    await delete_file_action(db, get_storage(), user_id, f.id, now_utc())
    await db.commit()
    return {"success": True, "file_id": fid, "name": fname,
            "note": "已移入回收站，30 天内可还原",
            "_file_op": {"op": "remove", "kind": "file", "id": fid}}


def _valid_file_ids(file_ids) -> bool:
    """批量软删除最多接收 50 个显式文件 ID，拒绝空集合和非数组输入。"""
    return isinstance(file_ids, list) and bool(file_ids) and len(file_ids) <= 50


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




# 保留旧导入路径；新实现位于 read.py。
from .read import (  # noqa: E402
    _batch_text_result, _file_item_label, _file_item_source_count,
    _read_file, _read_file_single, _read_history_media, _restricted_file_reader,
)


from .skill import FilesSkill  # noqa: E402
