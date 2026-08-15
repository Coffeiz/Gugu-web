"""文件领域技能：查 / 读 / 改 / 整理 / 生成。

复用文件服务层的现成 helper（`_build_key`/`_resolve_conflict`/
`_fmt_size`/`color_value`）、`app.services.storage.trash`（`move_file_to_trash`）与
存储层 `get_storage()`，整理类工具复刻 `update_file` 的 key 重建逻辑，不自己拼路径。

读/改仅限文本类（白名单 ext）且 ≤256KB，避免把二进制当文本、撑爆上下文。
生成（create_document）：文本格式直写；docx/pdf 由 HTML、xlsx 由 CSV 经 LibreOffice
转换（系统已装，零新依赖）。
"""
import json
from app.core.tz import now_utc
from datetime import datetime

from sqlalchemy import select

from app.models import Project
from app.core.ownership import get_owned
from app.core.redaction import redact
from app.services.storage import get_storage
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
from app.services.storage.file_service.files import _fmt_size
from app.services.files.actions import delete_file as delete_file_action
from app.services.storage.keys import _build_key, _resolve_conflict
from app.services.storage.file_service import FileService
from app.search.query import normalize_queries
from agent.tools.base import BaseSkill, Tool

# 可读/可改的文本类扩展名
TEXT_EXTS = frozenset({
    "md", "markdown", "txt", "text", "json", "csv", "tsv", "yaml", "yml",
    "xml", "html", "htm", "css", "js", "ts", "jsx", "tsx", "py", "java",
    "c", "cpp", "h", "hpp", "go", "rs", "rb", "php", "sh", "bash", "sql",
    "ini", "toml", "conf", "log", "vue", "svg",
})
READ_MAX_BYTES = 256 * 1024

# create_document 支持的格式 → mime
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


# ── 内部：LibreOffice 转换（复刻 files.py 的 _office_to_pdf 模式，泛化目标格式）──
# (src_ext, target_ext) -> (convert-to 参数, 可选 infilter)
# HTML 默认会被当作 Writer/Web 组件载入而无法导出 docx，需用 "HTML (StarWriter)"
# 强制以 Writer 载入；导出指定具体过滤器名，避免 "no export filter"。
_CONVERT_SPEC = {
    ("html", "docx"): ("docx:MS Word 2007 XML", "HTML (StarWriter)"),
    ("html", "pdf"):  ("pdf:writer_pdf_Export", "HTML (StarWriter)"),
    ("csv",  "xlsx"): ("xlsx:Calc MS Excel 2007 XML", None),
}


async def _libreoffice_convert(data: bytes, src_ext: str, target_ext: str) -> bytes:
    import asyncio
    import shutil
    import tempfile
    from pathlib import Path

    convert_to, infilter = _CONVERT_SPEC.get(
        (src_ext, target_ext), (target_ext, None)
    )
    tmp = Path(tempfile.mkdtemp())
    try:
        src = tmp / f"input.{src_ext}"
        src.write_bytes(data)
        cmd = ["libreoffice", "--headless"]
        if infilter:
            cmd += [f"--infilter={infilter}"]
        cmd += ["--convert-to", convert_to, "--outdir", str(tmp), str(src)]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("文档转换超时")
        out = tmp / f"input.{target_ext}"
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError("文档转换失败：" + (stderr.decode(errors="replace")[:120]))
        return out.read_bytes()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── 内部：按目标解析 storage_key（复刻 update_file/copy_file）──
async def _resolve_key(db, user_id, space, display_name, ext,
                       project_id=None, folder_id=None):
    project_name = project_year = project_month = folder_path = ""
    if space == "project" and project_id:
        p = await get_owned(db, Project, project_id, user_id)
        if not p:
            raise ValueError("目标项目不存在")
        project_name = p.name
        date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    if folder_id:
        resolved = await resolve_folder_path(
            db, user_id, folder_id, project_id if space == "project" else None,
        )
        if not resolved:
            raise ValueError("目标文件夹不存在，或不属于指定的项目/个人空间")
        _, folder_path = resolved
    key = _build_key(
        uid=user_id, space=space, display_name=display_name, ext=ext,
        project_name=project_name, project_id=project_id or 0,
        project_year=project_year, project_month=project_month,
        folder_path=folder_path,
    )
    return key


async def _location_receipt(db, user_id, space, project_id, folder_id):
    """保存/创建后的真实落点，完整路径供模型照回执转告，不再猜目录。"""
    project_name = None
    if space == "project" and project_id:
        project = await get_owned(db, Project, project_id, user_id)
        project_name = project.name if project else None
    folder_path = "（根目录）"
    if folder_id:
        resolved = await resolve_folder_path(
            db, user_id, folder_id, project_id if space == "project" else None,
        )
        if resolved:
            _, folder_path = resolved
    return {
        "space": space,
        "project_id": project_id if space == "project" else None,
        "project_name": project_name,
        "folder_id": folder_id,
        "folder_path": folder_path,
    }


def _strip_ext(name: str, ext: str) -> str:
    """把 name 末尾的 ext 等价后缀全部剥到稳定。

    按 _DOC_EXT_ALIASES 整族匹配（md/markdown、txt/text、yaml/yml 互认），谁在末尾都剥。
    长 alias 优先匹配（".markdown" 4 字符比 ".md" 2 字符先命中，避免 "notes.markdown.md"
    这种字符串剥错位）。**循环到稳定**——name 已经被拼成 "README.md.markdown" 这种双
    后缀进来时，单次剥完仍残留一层后缀，再拼 ext 又会回到双后缀。"""
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


def _coerce_loc(space, project_id, folder_id):
    """归一 move/copy 的目标位置，返回 (space, project_id, folder_id, error_json|None)。
    ① id 字符串转 int —— LLM 常把 "91" 当字符串传，int4 列拿到字符串会让 asyncpg 直接抛错。
    ② 落到「项目空间」却没指定具体项目 → 报错，挡住 space=project 但 project_id=None 的孤儿文件
       （在任何项目里都看不到、却占着"项目空间"，正是之前让人困惑的状态）。"""
    def _as_int(v):
        try:
            return int(str(v).strip().lstrip("#")) if v not in (None, "") else None
        except (ValueError, TypeError):
            return None   # 解析不出（如把项目名当 id 传进来）→ None，别回原串：否则非数字会流进整数主键查询 → asyncpg DataError 崩
    project_id = _as_int(project_id)
    folder_id = _as_int(folder_id)
    if space == "project" and not project_id:
        return space, project_id, folder_id, json.dumps(
            {"error": "移动/复制到项目空间必须指定 target.project_id（具体哪个项目）。"
                      "可先用 list_projects 拿到项目 id 再操作。"})
    return space, project_id, folder_id, None


def _norm_target(target):
    """target 容错：模型偶尔把它序列化成字符串（JSON 或 Python 字面量），统一回 dict。"""
    if isinstance(target, dict):
        return target
    if isinstance(target, str) and target.strip():
        import ast
        for _p in (json.loads, ast.literal_eval):
            try:
                v = _p(target)
                if isinstance(v, dict):
                    return v
            except Exception:
                pass
    return {}


def _target_loc(f, target: dict):
    """据 target 算出 (space, project_id, folder_id)。关键：跨项目/空间又没显式指定 folder 时，
    folder_id 落到目标根目录（None），**不继承源文件夹**——否则「复制到别的项目」会落回原文件夹
    （源文件夹属于原项目），表现为「原地复制了一份」。给了 project_id 没给 space 则视为进项目空间。"""
    def _i(v):
        try:
            return int(str(v).strip().lstrip("#")) if v not in (None, "") else None
        except (ValueError, TypeError):
            return None   # 同 _as_int：非数字（项目名误当 id）→ None，别让它流进整数查询崩
    if "space" in target:
        space = target["space"]
    elif target.get("project_id") not in (None, ""):
        space = "project"
    else:
        space = f.space
    project_id = _i(target.get("project_id", f.project_id))
    if "folder_id" in target:
        folder_id = _i(target.get("folder_id"))
    elif space == f.space and project_id == f.project_id:
        folder_id = f.folder_id          # 同项目同空间内复制/移动 → 默认留在原文件夹
    else:
        folder_id = None                 # 跨项目/空间 → 落目标根目录，不继承源文件夹
    return space, project_id, folder_id


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
            )
            if error:
                return error
            folder_id = folder.id
    file_queries = normalize_queries(
        args.get("q"), args.get("queries") if isinstance(args.get("queries"), list) else None,
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

    # 图片：vision 模型 + Anthropic 通道 → 把图喂给模型「看」（结果走 tool_result 图片块）
    from app.core import chat_attach
    if ext in chat_attach.IMAGE_EXTS:
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
    if ext not in TEXT_EXTS and not is_doc:
        return json.dumps({"error": f"不支持读取该类型（{f.ext}），支持文本、PDF/Office、图片、音频和视频"})
    cap = doctext.EXTRACT_MAX_BYTES if is_doc else READ_MAX_BYTES
    if (f.size_bytes or 0) > cap:
        return json.dumps({"error": f"文件过大（{f.size}），超出可读上限"})
    try:
        data = await get_storage().get(f.storage_key)
        text = await doctext.extract_text(data, ext)   # 文本类直接 decode；文档走 pdftotext/LibreOffice
    except Exception as e:
        return json.dumps({"error": f"读取失败：{str(e)[:80]}"})
    return {"file_id": f.id, "name": f"{f.display_name}.{f.ext}", "content": text}


async def _edit_one(db, user_id, f, spec: dict) -> dict:
    """对已解析的 File f 应用一次编辑（mode + content/find/replace），各自 commit。返回结果 dict。
    供单个与批量 edit 共用。"""
    nm = f"{f.display_name}.{f.ext}"
    if f.ext.lower() not in TEXT_EXTS:
        return {"error": f"不支持修改该类型（{f.ext}），仅支持文本类文件", "name": nm}
    if (f.size_bytes or 0) > READ_MAX_BYTES:
        return {"error": "文件过大，超出可改上限 256KB", "name": nm}
    storage = get_storage()
    try:
        old = (await storage.get(f.storage_key)).decode("utf-8", errors="replace")
    except Exception as e:
        return {"error": f"读取失败：{str(e)[:80]}", "name": nm}
    mode = spec.get("mode", "replace_all")
    # `change`：一句话改动摘要——给模型「反馈用户改了啥」的事实依据（按回执说，别自己编）。
    def _clip(s, n=24):
        s = (s or "").replace("\n", " ")
        return s[:n] + ("…" if len(s) > n else "")
    if mode == "replace_all":
        new = spec.get("content", "")
        change = f"整体覆盖（{len(old)} → {len(new)} 字）"
    elif mode == "append":
        add = spec.get("content", "")
        new = old + add
        change = f"末尾追加 {len(add)} 字"
    elif mode == "find_replace":
        find = spec.get("find", "")
        if not find or find not in old:
            return {"error": "未找到要替换的内容（find）", "name": nm}
        rep = spec.get("replace", "")
        n = old.count(find)
        new = old.replace(find, rep)
        change = f"替换 {n} 处：「{_clip(find)}」→「{_clip(rep)}」"
    else:
        return {"error": f"未知 mode: {mode}", "name": nm}
    data = new.encode("utf-8")
    await storage.put(f.storage_key, data, f.mime_type)
    f.size_bytes = len(data)
    f.size = _fmt_size(len(data))
    f.updated_at = now_utc()
    await db.commit()
    result = {"success": True, "file_id": f.id, "name": nm, "new_size": f.size, "change": change}
    # P2c · 内容骤降告警：replace_all 最容易把整段覆盖丢。改后显著变短时确定性提示模型核对，
    # 不全靠它自己「读回来发现」（配合 skills.md「改正文必须 read_file 读回比对」铁律）。
    if len(old) >= 200 and len(new) < len(old) * 0.5:
        result["warning"] = (
            f"⚠️ 改后内容明显变短（原约 {len(old)} 字 → 新约 {len(new)} 字）。"
            f"若你本只想改局部却用了整体覆盖，可能把其它内容覆盖丢了——"
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


async def _create_document(db, user_id, args: dict):
    fmt = (args.get("format") or "md").lower()
    if fmt not in _DOC_MIME:
        return json.dumps({"error": f"不支持的格式: {fmt}", "supported": list(_DOC_MIME)}, ensure_ascii=False)
    # 落盘 ext 走规范名（md/markdown→md、txt/text→txt、yaml/yml→yaml），跟上传/重命名等其他途径
    # 创建的 md 一致都是 .md 后缀，避免 markdown 等同族写法落到存储里变成 .markdown（双后缀 bug 根因）。
    ext = _DOC_EXT.get(fmt, fmt)
    name = (args.get("name") or "").strip()
    if not name:
        return json.dumps({"error": "缺少必填参数 name（文件名）；请带上 name 再调用本工具"}, ensure_ascii=False)
    display_name = _strip_ext(name, ext)
    space = args.get("space", "personal")
    space, project_id, folder_id, loc_err = _coerce_loc(
        space, args.get("project_id"), args.get("folder_id"),
    )
    if loc_err:
        return loc_err
    content = args.get("content", "")

    # 生成二进制内容。LibreOffice 路径走 ext（规范名），跟 mime/storage_key 保持同一份事实——
    # 别在分支判定里用 fmt 又在落盘/DB 用 ext，alias 化后两边可能不一致（比如以后加
    # fmt="doc"→ext="docx"，这里再写 fmt in ("docx",) 就会漏过 doc 这条路径）。
    try:
        if ext in ("docx", "pdf"):
            data = await _libreoffice_convert(content.encode("utf-8"), "html", ext)
        elif ext == "xlsx":
            data = await _libreoffice_convert(content.encode("utf-8"), "csv", "xlsx")
        else:  # 文本类直写
            data = content.encode("utf-8")
    except Exception as e:
        return json.dumps({"error": f"生成失败：{str(e)[:120]}"})

    try:
        result = await FileService(db).create_file(
            user_id,
            space=space,
            project_id=project_id if space == "project" else None,
            folder_id=folder_id,
            stage_name="",
            mind_map_id=None,
            display_name=display_name,
            ext=ext,
            mime_type=_DOC_MIME[ext],
            data=data,
        )
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    await db.commit()
    db_file = result.file
    await db.refresh(db_file)
    return {"success": True, "file_id": db_file.id,
            "name": f"{db_file.display_name}.{db_file.ext}", "size": db_file.size,
            **(await _location_receipt(db, user_id, space, project_id, folder_id))}


async def _save_one_attach(db, user_id, meta: dict, *, space, project_id, folder_id):
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
    await db.refresh(db_file)
    return True, {"file_id": db_file.id, "name": f"{db_file.display_name}.{db_file.ext}",
                  "size": db_file.size,
                  **(await _location_receipt(db, user_id, space, project_id, folder_id))}


async def _save_uploaded_file(db, user_id, args: dict):
    """把用户聊天里上传的暂存附件保存进文件库。默认 personal，可直接指定项目/文件夹。
    单个：attach_id。批量（同一批连发的多个附件，如连拍的几张图）：attach_ids=[id1,id2,...]——
    每个各自精确解析，比逐个分别调用更可靠（避免每次没对上都各自回退、可能救回不相关的附件，
    如把连发图片之外的一条语音存进来了；见 resolve_attach 的歧义防护）。"""
    from app.core import chat_attach

    space = args.get("space") or ("project" if args.get("project_id") else "personal")
    space, project_id, folder_id, loc_err = _coerce_loc(space, args.get("project_id"), args.get("folder_id"))
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
                                              project_id=project_id, folder_id=folder_id)
            (saved if ok else failed).append(item)
        return {"success": True, "saved_count": len(saved), "failed_count": len(failed),
                "saved": saved, "failed": failed}

    # 单个（兼容旧行为）
    meta, note = await chat_attach.resolve_attach(user_id, args.get("attach_id") or "")
    if not meta:
        return json.dumps({"error": note or "没找到可保存的附件，可能确实过期了（聊天附件只暂存 7 天）。"
                                    "麻烦让用户重新发一下～"}, ensure_ascii=False)
    ok, item = await _save_one_attach(db, user_id, meta, space=space, project_id=project_id, folder_id=folder_id)
    if not ok:
        return json.dumps(item, ensure_ascii=False)
    return {**item, **({"note": note} if note else {})}


async def _rename_one(db, user_id, f, new_name: str, new_fmt: str | None = None) -> dict:
    """重命名已解析的 File f，各自 commit。返回结果 dict。供单个与批量 rename 共用。

    new_fmt 为 None 时沿用 f.ext（旧行为，"改名不改格式"）。传了新 fmt 就用规范 ext，
    用于修双后缀文件：new_name="README" + new_fmt="md" 会把 f.ext="markdown" 的
    README.md.markdown 改成 README.md。文本类互相转也走这条；非文本类（docx/pdf/xlsx）
    仅当 new_fmt 等于当前 ext 时允许"改名不改内容"，跨文本/二进制的格式转换请走 edit_file
    + LibreOffice，而不是 rename。
    """
    old_ext = f.ext
    if new_fmt is not None:
        fmt = new_fmt.lower()
        if fmt not in _DOC_MIME:
            return {"error": f"不支持的格式: {fmt}", "supported": list(_DOC_MIME), "name": f"{f.display_name}.{f.ext}"}
        new_ext = _DOC_EXT.get(fmt, fmt)
        # 二进制格式必须显式同 ext 才允许（避免 rename 把 .md 文件"改名"成 .docx 但内容是 markdown）
        if new_ext != old_ext and (new_ext in ("docx", "pdf", "xlsx") or old_ext in ("docx", "pdf", "xlsx")):
            return {"error": f"rename 不能跨文本/二进制格式（{old_ext}→{new_ext}），请用 edit_file 走 LibreOffice 转换",
                    "name": f"{f.display_name}.{f.ext}"}
    else:
        new_ext = old_ext
    new_display = _strip_ext(new_name, new_ext)
    try:
        new_key = await _resolve_key(
            db, user_id, f.space, new_display, new_ext,
            project_id=f.project_id, folder_id=f.folder_id,
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


async def _resolve_file(db, user_id, args):
    """按 file_id 或文件名 file 定位（仅未删除文件）；返回 (File|None, 错误JSON|None)。"""
    fid = args.get("file_id")
    if fid:
        f = await get_user_file(db, user_id, fid)
        if not f:
            return None, json.dumps({"error": "文件不存在"})
        return f, None
    name = args.get("file")
    if name:
        name = str(name).strip()
        base = name.rsplit(".", 1)[0] if "." in name else name
        rows = await find_user_files_by_name(db, user_id, base)
        if not rows:
            return None, json.dumps({"error": f"未找到文件「{name}」"})
        if len(rows) > 1:
            return None, json.dumps({"error": f"有多个匹配「{name}」的文件，请指明",
                                     "candidates": [{"id": f.id, "name": f"{f.display_name}.{f.ext}",
                                                     "space": f.space, "folder_id": f.folder_id} for f in rows[:10]]})
        return rows[0], None
    return None, json.dumps({"error": "需提供 file_id 或文件名 file"})


async def _folder_by_name(db, user_id, name, space=None, project_id=None):
    """按名称定位文件夹，返回 (Folder|None, 错误JSON字符串|None)。

    重名时优先顶层（parent_id 为空）；仍有歧义则返回候选让调用方/模型用 folder_id 指定。
    """
    name = str(name).strip()
    rows = await find_user_folders_by_name(
        db, user_id, name, space=space, project_id=project_id)
    if not rows:
        # 报错时只列出同项目/同空间的文件夹名，避免跨项目泄露
        available = await list_user_folders(
            db, user_id, project_id=project_id if space == "project" else None)
        avail = [folder.name for folder in available]
        return None, json.dumps({"error": f"未找到名为「{name}」的文件夹",
                                 "available_folders": sorted(set(avail))})
    if len(rows) > 1:
        top = [f for f in rows if f.parent_id is None]
        if len(top) == 1:
            return top[0], None
        cand = top or rows
        return None, json.dumps({"error": f"有多个名为「{name}」的文件夹，请用 folder_id 指定",
                                 "candidates": [{"id": f.id, "parent_id": f.parent_id} for f in cand]})
    return rows[0], None


async def _move_one(db, user_id, f, target: dict) -> dict:
    """把已解析的 File f 移到 target，各自 commit。返回结果 dict（成功或 {"error":...}）。
    供 move_items 移动文件时复用（单个文件也走它）。"""
    target = _norm_target(target)
    space, project_id, folder_id = _target_loc(f, target)
    space, project_id, folder_id, loc_err = _coerce_loc(space, project_id, folder_id)
    if loc_err:
        return loc_err

    # 支持按文件夹「名称」移动（agent 通常不知道 folder_id）
    fname = target.get("folder")
    if fname is not None:
        fname = str(fname).strip()
        if fname in ("", "根", "根目录", "/"):
            folder_id = None
        else:
            fo, err = await _folder_by_name(db, user_id, fname, space, project_id)
            if err:
                return err
            folder_id = fo.id
            # 文件夹决定归属项目：以 folder 的 project_id 为准，避免跨项目移动后 project_id 与 folder 不一致
            if fo.project_id is not None:
                project_id = fo.project_id
                space = "project"

    # 无变动 → 明确报错，而不是假成功（避免咕咕误报"已移动"）
    cur_pid = f.project_id
    new_pid = project_id if space == "project" else None
    if folder_id == f.folder_id and space == f.space and new_pid == cur_pid:
        return json.dumps({"error": "未指定有效目标或文件已在该位置，未移动。"
                                    "请用 target.folder 指定目标文件夹名，或先用 list_folders 确认。",
                           "current_folder_id": f.folder_id})

    try:
        result = await FileService(db).update_file(
            user_id,
            f.id,
            display_name=None,
            stage_name=target.get("stage_name") if "stage_name" in target else None,
            folder_id=folder_id,
            project_id=new_pid,
            folder_set=True,
            project_set=True,
        )
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    await db.commit()
    moved = result.file
    folder_name = result.folder_name or "（根目录）"
    # 明确回报落点的「空间/项目/文件夹」，别只给文件夹名——否则模型无从确认到底进了哪个项目，
    # 容易自行脑补位置（曾出现移到项目根目录后谎报项目/文件名的情况）
    project_name = result.project.name if result.project else None
    return {"success": True, "file_id": moved.id, "name": f"{moved.display_name}.{moved.ext}",
            "space": moved.space, "project_id": moved.project_id, "project_name": project_name,
            "folder_id": moved.folder_id, "moved_to": folder_name}


def _as_dict(r):
    """把 _move_one 的返回归一成 dict（错误分支历史上返回 json 字符串）。"""
    if isinstance(r, str):
        try:
            return json.loads(r)
        except Exception:
            return {"error": r}
    return r


# ── move_items：统一「集合移动」（文件 + 文件夹混合，文件夹后端递归展开）──────────────

async def _descendant_folder_ids(db, user_id, root_id: int) -> list[int]:
    """root_id 及其所有子孙文件夹 id（沿 parent_id 逐层 BFS）。"""
    return await descendant_folder_ids(db, user_id, root_id)


async def _resolve_target(db, user_id, target: dict):
    """把 target 解析成统一落点 (space, project_id, folder_id)。返回 (space, pid, folder_id, err_dict|None)。
    支持 folder_id（最准）/ folder 名 + space/project_id 限定 / 不给文件夹=空间根。"""
    space = target.get("space")
    project_id = target.get("project_id")
    folder_id = target.get("folder_id")
    fname = target.get("folder")
    if folder_id:
        fo = await get_user_folder(db, user_id, folder_id)
        if not fo:
            return None, None, None, {"error": "目标文件夹不存在"}
        return ("project" if fo.project_id else "personal"), fo.project_id, fo.id, None
    if fname is not None:
        fname = str(fname).strip()
        if fname in ("", "根", "根目录", "/"):
            sp = space or ("project" if project_id else "personal")
            return sp, (project_id if sp == "project" else None), None, None
        sp = space or ("project" if project_id else "personal")
        fo, err = await _folder_by_name(db, user_id, fname, sp, project_id)
        if err:
            return None, None, None, {"error": f"目标文件夹「{fname}」没找到，请用 list_folders 确认，或改用 folder_id"}
        return ("project" if fo.project_id else "personal"), fo.project_id, fo.id, None
    sp = space or "personal"
    return sp, (project_id if sp == "project" else None), None, None


async def _move_folder(db, user_id, folder, t_space, t_pid, t_parent_id) -> dict:
    """委托 FileService 搬文件夹树，并同步重建所有后代文件的物理路径。"""
    name = folder.name
    sub_ids = await _descendant_folder_ids(db, user_id, folder.id)
    try:
        await FileService(db).move_folder(
            user_id, folder.id, t_parent_id, client_version=folder.version,
            target_project_id=t_pid,
        )
        await db.commit()
    except Exception as e:
        return {"error": redact(f"{type(e).__name__}: {e}")}
    return {"success": True, "type": "folder", "folder": name,
            "subfolders": len(sub_ids) - 1,
            "space": t_space, "project_id": t_pid}


async def _move_items(db, user_id, args: dict):
    """统一移动：files + folders 一次搬到同一 target。文件夹连内容递归搬（后端展开，
    Agent 不必知道里面有多少文件）。逐条如实回报成功/失败。"""
    target = args.get("target", {})
    t_space, t_pid, t_folder_id, terr = await _resolve_target(db, user_id, target)
    if terr:
        return terr
    file_target = {"space": t_space, "project_id": t_pid, "folder_id": t_folder_id}

    moved_files, moved_folders, failed = [], [], []
    # 文件
    for it in (args.get("files") or []):
        sub = {}
        if isinstance(it, int) or (isinstance(it, str) and str(it).strip().isdigit()):
            sub["file_id"] = int(it)
        else:
            sub["file"] = str(it)
        f, _err = await _resolve_file(db, user_id, sub)
        if _err:
            failed.append({"item": it, "kind": "file", "error": "没找到这个文件"})
            continue
        r = _as_dict(await _move_one(db, user_id, f, file_target))
        (moved_files if r.get("success") else failed).append(
            r if r.get("success") else {"item": it, "kind": "file", **r})
    # 文件夹
    for it in (args.get("folders") or []):
        if isinstance(it, int) or (isinstance(it, str) and str(it).strip().isdigit()):
            fo = await get_user_folder(db, user_id, int(it))
        else:
            # 按名找：在源处可能任意空间，这里全局按名匹配（重名则提示用 id）
            rows = await find_user_folders_by_name(db, user_id, str(it))
            fo = rows[0] if len(rows) == 1 else None
            if len(rows) > 1:
                failed.append({"item": it, "kind": "folder", "error": "有多个同名文件夹，请改用 folder_id"})
                continue
        if not fo:
            failed.append({"item": it, "kind": "folder", "error": "没找到这个文件夹"})
            continue
        r = await _move_folder(db, user_id, fo, t_space, t_pid, t_folder_id)
        (moved_folders if r.get("success") else failed).append(
            r if r.get("success") else {"item": it, "kind": "folder", **r})

    return {"success": True,
            "moved_files": len(moved_files), "moved_folders": len(moved_folders),
            "failed_count": len(failed),
            "files": moved_files, "folders": moved_folders, "failed": failed}


async def _create_folder(db, user_id, args: dict):
    try:
        fo = await FileService(db).create_folder(
            user_id, name=args["name"], parent_id=args.get("parent_id"),
            project_id=args.get("project_id"),
        )
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    await db.commit()
    await db.refresh(fo)
    return {"success": True, "folder_id": fo.id, "name": fo.name}


async def _delete_file(db, user_id, args: dict):
    # 软删进回收站，30 天可还原 —— 非不可逆，无需二次确认
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    fid = f.id; fname = f"{f.display_name}.{f.ext}"
    await delete_file_action(db, get_storage(), user_id, f.id, now_utc())
    await db.commit()
    return {"success": True, "file_id": fid, "name": fname,
            "note": "已移入回收站，30 天内可还原",
            "_file_op": {"op": "remove", "kind": "file", "id": fid}}


async def _list_folders(db, user_id, args: dict):
    rows = await list_user_folders(
        db, user_id,
        project_id=args.get("project_id"),
        parent_id=args.get("parent_id"),
    )
    out = []
    for folder in rows:
        resolved = await resolve_folder_path(db, user_id, folder.id, folder.project_id)
        if not resolved:
            continue
        _, path = resolved
        out.append({
            "id": folder.id, "name": folder.name, "path": path,
            "project_id": folder.project_id, "parent_id": folder.parent_id,
            "depth": path.count("/"),
        })
    return sorted(out, key=lambda item: (item["depth"], item["path"]))


async def _find_folder(db, user_id, args: dict):
    """按 folder_id 或文件夹名定位；返回 Folder 或错误 JSON 字符串（含可选项）。"""
    fid = args.get("folder_id")
    if fid:
        try:
            fid = int(str(fid).strip())
        except (ValueError, TypeError):
            pass
        fo = await get_user_folder(db, user_id, fid)
        if not fo:
            return json.dumps({"error": "文件夹不存在"})
        return fo
    name = args.get("name") or args.get("folder")
    if name:
        # 把调用方传来的项目上下文透传进去，防止跨项目同名文件夹被误操作
        pid = args.get("project_id")
        try:
            pid = int(str(pid).strip()) if pid not in (None, "") else None
        except (ValueError, TypeError):
            pid = None
        space = "project" if pid else args.get("space")
        fo, err = await _folder_by_name(db, user_id, name, space, pid)
        return err if err else fo
    return json.dumps({"error": "需提供 folder_id 或文件夹名 name"})


async def _rename_folder(db, user_id, args: dict):
    fo = await _find_folder(db, user_id, args)
    if isinstance(fo, str):
        return fo
    try:
        fo = await FileService(db).rename_folder(
            user_id, fo.id, args["new_name"], client_version=fo.version,
        )
        await db.commit()
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    return {"success": True, "folder_id": fo.id, "name": fo.name}


async def _delete_folder(db, user_id, args: dict):
    fo = await _find_folder(db, user_id, args)
    if isinstance(fo, str):
        return fo
    fid = fo.id
    fname = fo.name
    try:
        await FileService(db).delete_folder(user_id, fo.id)
        await db.commit()
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    note = f"文件夹「{fname}」已删除，其中的文件已移入回收站（30 天内可恢复）"
    return {"success": True, "deleted_folder_id": fid, "note": note,
            "_file_op": {"op": "remove", "kind": "folder", "id": fid}}


async def _copy_file(db, user_id, args: dict):
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    target = _norm_target(args.get("target", {}))
    space, project_id, folder_id = _target_loc(f, target)
    space, project_id, folder_id, loc_err = _coerce_loc(space, project_id, folder_id)
    if loc_err:
        return loc_err
    fname = target.get("folder")
    if fname is not None:
        fname = str(fname).strip()
        if fname in ("", "根", "根目录", "/"):
            folder_id = None
        else:
            fo, err = await _folder_by_name(db, user_id, fname, space, project_id)
            if err:
                return err
            folder_id = fo.id
            # 复制目标以文件夹的项目为准，与 _move_one 保持一致
            if fo.project_id is not None:
                project_id = fo.project_id
                space = "project"
    try:
        result = await FileService(db).copy_file(
            user_id, f.id, folder_id=folder_id,
            project_id=project_id if space == "project" else None,
        )
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    await db.commit()
    new_file = result.file
    await db.refresh(new_file)
    return {"success": True, "file_id": new_file.id,
            "name": f"{new_file.display_name}.{new_file.ext}"}


# ── 网络图片下载（send_file 的 url 分支用）：SSRF 防护 ─────────────────────────
_SEND_URL_MAX_BYTES = 15 * 1024 * 1024   # 下载体积上限
_SEND_URL_IMAGE_EXT = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/bmp": "bmp",
}


def _url_is_safe(url: str) -> str | None:
    from app.core.url_security import url_is_safe

    return url_is_safe(url)


def _build_pinned_request(client, method: str, url: str):
    """校验 host 并把连接 pin 到校验时解析到的那个 IP，返回 (request, error)。

    单纯"校验一次、httpx 连接时再 resolve 一次"堵不住 DNS rebinding（攻击者控制的域名
    可以在两次解析之间把 A 记录从公网 IP 换成内网 IP，见 url_security.resolve_pinned_ip
    文档）。这里改成用解析到的 IP 直接建连，Host 头 / TLS SNI 仍用原始域名，保证证书
    校验和路由都不受影响，只是"连去哪"这件事不再交给 httpx 自己二次决定。
    """
    from urllib.parse import urlparse

    from app.core.url_security import resolve_pinned_ip

    ip, error = resolve_pinned_ip(url)
    if error:
        return None, error
    parsed = urlparse(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    netloc = f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}"
    pinned_url = parsed._replace(netloc=netloc).geturl()
    extensions = {"sni_hostname": parsed.hostname} if parsed.scheme == "https" else {}
    # Host 头：字面 IPv6 地址在 URI authority/HTTP Host 里必须带方括号（如
    # "[2606:4700:4700::1111]"），否则冒号会被误当成端口分隔符——parsed.hostname
    # 对这种 URL 返回的是不带括号的裸地址，直接拼进 Host 头格式不合法（code review
    # 发现）。普通域名不含冒号，加不加这个判断都不受影响。
    host = f"[{parsed.hostname}]" if ":" in (parsed.hostname or "") else parsed.hostname
    # 非默认端口（如 :8443）省略端口会让部分虚拟主机/CDN 按错误的站点路由（同样是
    # code review 发现）；有 parsed.port 时原样带上，用默认端口时留纯 host。
    host_header = f"{host}:{parsed.port}" if parsed.port else host
    req = client.build_request(method, pinned_url, headers={"Host": host_header}, extensions=extensions)
    return req, None


def _fmt_age(ttl_left: int, total_ttl: int) -> str:
    """按剩余 TTL 反推大致存了多久（暂存无绝对时间戳，只能这样估）。"""
    if ttl_left is None or ttl_left < 0:
        return "未知"
    elapsed = max(0, total_ttl - ttl_left)
    if elapsed < 3600:
        return f"约{max(1, elapsed // 60)}分钟前"
    if elapsed < 86400:
        return f"约{elapsed // 3600}小时前"
    return f"约{elapsed // 86400}天前"


async def _list_recent_attachments(db, user_id, args: dict):
    """列出该用户当前暂存区（未过期）的附件，供模型在「刚刚的图/那张图」等模糊指代时反查 attach_id。"""
    from app.core import chat_attach
    staged = await chat_attach.list_staged(user_id)
    if not staged:
        return {"count": 0, "items": [], "note": "暂存区当前没有未过期的附件"}
    items = [{
        "attach_id": m["attach_id"], "name": m.get("name"), "ext": m.get("ext"),
        "kind": m.get("kind"), "platform": m.get("platform"),
        "size_bytes": m.get("size"), "img_width": m.get("img_width"), "img_height": m.get("img_height"),
        "staged_about": _fmt_age(m.get("_ttl"), chat_attach.TTL),
    } for m in staged]
    return {"count": len(items), "items": items}


async def _send_file_from_url(user_id, url: str, title: str):
    """下载一张网络图片（如 image_search 结果的 img_src）暂存为聊天附件，返回 _artifact（attach_id 版）。

    下载用 streaming + 累计限流：不把整个响应读进内存再判大小（否则群成员给一个
    Content-Length 2GB 的 URL 会先把 2GB 全读进 RAM 才触发 15MB 检查，是 DoS 面）。
    有 Content-Length 提前拒绝；chunked/无 Content-Length 在读取过程中累计，超限立即中止。

    生命周期：**最终 response 的完整消费（含 aiter_bytes）必须留在 AsyncClient 的
    async with 块内**——真实 httpx 的 transport 随 client 关闭，若在 __aexit__ 之后
    才读 body，连接已关会抛 ReadError。原则：创建 client → 获取 streaming response →
    完整消费/主动中止 → close response → 最后才 close client。
    """
    import httpx
    from urllib.parse import urljoin
    try:
        # 手动跟随重定向 + 逐跳重新校验：自动 follow 会让公网页 302 跳内网/云元数据绕过校验（SSRF）。
        # stream=True 只读响应头不读 body，避免 redirect 探测阶段就把大 body 读进内存。
        # 每一跳都用 _build_pinned_request 把"校验的地址"和"实际连接的地址"锁定成同一个 IP，
        # 防 DNS rebinding（见该函数文档）。
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0),
            follow_redirects=False,
            # 禁用连接池 keep-alive：pin 到 IP 后，重定向多跳可能解析到同一个 IP（CDN
            # 场景很常见），httpcore 按 origin（这里全是同一个 IP:port）复用连接池——
            # 但 sni_hostname 只在新建 TLS 连接时生效，复用已有连接不会重新握手，会
            # 出现"握手时验证了 A 的证书，之后却拿这条连接发 Host: B 的请求"这种
            # TLS hostname 隔离缺口（code review 发现）。这个下载器最多才 4 跳，
            # 完全没必要为了 keep-alive 收益承担这个风险，禁掉最简单也最彻底。
            limits=httpx.Limits(max_keepalive_connections=0),
        ) as client:
            cur = url
            req, reason = _build_pinned_request(client, "GET", cur)
            if reason:
                return json.dumps({"error": f"这个链接发不了：{reason}"}, ensure_ascii=False)
            resp = await client.send(req, stream=True)
            for _ in range(3):   # 最多跟 3 跳
                if resp.status_code not in (301, 302, 303, 307, 308):
                    break
                loc = resp.headers.get("location")
                await resp.aclose()   # 关闭 3xx 响应连接，再发下一跳
                if not loc:
                    break
                cur = urljoin(cur, loc)
                req, reason = _build_pinned_request(client, "GET", cur)   # 每一跳的目标都重新解析+校验+pin
                if reason:
                    return json.dumps({"error": f"这个链接发不了：{reason}"}, ensure_ascii=False)
                resp = await client.send(req, stream=True)

            # 最终 response 的完整消费留在 client 生命周期内（见 docstring）。
            if resp.status_code != 200:
                await resp.aclose()
                return json.dumps({"error": f"图片下载失败（HTTP {resp.status_code}）"}, ensure_ascii=False)

            ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
            ext = _SEND_URL_IMAGE_EXT.get(ctype)
            if not ext:
                await resp.aclose()
                return json.dumps({"error": f"这个链接返回的不是支持的图片格式（{ctype or '未知类型'}）"}, ensure_ascii=False)
            # Content-Length 提前拒绝：声明体积就超限的，不用读 body。
            clen = resp.headers.get("content-length")
            if clen and clen.isdigit() and int(clen) > _SEND_URL_MAX_BYTES:
                await resp.aclose()
                return json.dumps({"error": f"图片过大（{int(clen) / 1048576:.1f}MB），超过 {_SEND_URL_MAX_BYTES // 1048576}MB 上限"}, ensure_ascii=False)

            # 流式读取 + 累计限流：chunked/无 Content-Length 时在读取过程中累计，超限立即中止，
            # 不把整个响应消费完（防 DoS）。
            total = 0
            chunks: list[bytes] = []
            try:
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    if total > _SEND_URL_MAX_BYTES:
                        return json.dumps({"error": f"图片过大（超过 {_SEND_URL_MAX_BYTES // 1048576}MB 上限）"}, ensure_ascii=False)
                    chunks.append(chunk)
            finally:
                await resp.aclose()
            data = b"".join(chunks)
    except Exception as e:
        return json.dumps({"error": f"图片下载失败（{type(e).__name__}），换一张或换个来源试试"}, ensure_ascii=False)
    if not data:
        return json.dumps({"error": "下载到的内容是空的"}, ensure_ascii=False)

    from app.core import chat_attach
    name = (title or "").strip()[:80] or "图片"
    meta = await chat_attach.stage(user_id, name, ext, ctype, data, kind="image")
    return {
        "ok": True,
        "message": f"已把「{name}」发到对话窗口。",
        "_artifact": {
            "attach_id": meta["attach_id"],
            "name": name,
            "ext": ext,
            "size_bytes": len(data),
            "kind": "image",
            # 带上真实像素尺寸：前端预览窗口直接按此定尺，不用再靠缩略图猜（猜不准会出现
            # 「先弹很大的窗口再缩小」的问题，小图/非4K图尤其明显）
            "img_width": meta.get("img_width"),
            "img_height": meta.get("img_height"),
        },
    }


async def _send_file(db, user_id, args: dict):
    """把文件发到对话窗口（前端渲染可下载卡片）：文件库里的文件用 file_id/file；
    网络图片（如 image_search 搜到的）用 url——下载后暂存成聊天附件，同一套 _artifact 机制；
    之前收到/发过、还在暂存区的附件用 attach_id——直接重发，不重新下载、不进文件库。
    返回 _artifact，core 据此推一个 file 事件给前端；普通字段回给 LLM。

    群成员（member/unknown）只能用 url 发网络图片（搜图配图），不能发文件库文件
    （file/file_id）或重发暂存附件（attach_id）——后两者会读取 Bot 所属账号的私有文件。
    """
    from agent.im import imctx
    im = imctx.get_im()
    is_restricted = bool(im and im.get("im_role") in ("member", "unknown"))

    url = (args.get("url") or "").strip()
    if url:
        return await _send_file_from_url(user_id, url, args.get("title") or "")

    if is_restricted:
        # 群成员只允许发网络图片（url 分支）；file/file_id/attach_id 涉及 owner 私有文件，禁止。
        return json.dumps({"error": "群聊里只能发网络图片（用 url 传图片直链），不能发文件库文件或重发附件"}, ensure_ascii=False)

    attach_id = (args.get("attach_id") or "").strip()
    if attach_id:
        from app.core import chat_attach
        meta, note = await chat_attach.resolve_attach(user_id, attach_id)
        if not meta:
            return json.dumps({"error": "没找到这个附件，可能已经过期了（聊天附件只暂存 7 天）"}, ensure_ascii=False)
        name = f"{meta['name']}.{meta['ext']}" if meta.get("ext") else meta["name"]
        return {
            "ok": True,
            "message": f"已把《{name}》重新发到对话窗口。{note}".strip(),
            "_artifact": {
                "attach_id": meta["attach_id"], "name": meta["name"], "ext": meta.get("ext"),
                "size_bytes": meta.get("size"), "kind": meta.get("kind"),
                "img_width": meta.get("img_width"), "img_height": meta.get("img_height"),
            },
        }

    f, err = await _resolve_file(db, user_id, args)
    if err:
        return err
    name = f"{f.display_name}.{f.ext}"
    return {
        "ok": True,
        "message": f"已把《{name}》发到对话窗口，用户可直接下载。",
        "_artifact": {
            "file_id": f.id,
            "name": f.display_name,
            "ext": f.ext,
            "size_bytes": f.size_bytes,
            "img_width": f.img_width,
            "img_height": f.img_height,
        },
    }


class FilesSkill(BaseSkill):
    name = "files"
    tools = [
        Tool(
            name="list_files", label="查询文件",
            description="查询文件，可按空间(project/mind/asset/personal)、项目、文件夹、扩展名、一个或多个名称关键词（默认 OR）筛选。"
                        "结果含 folder_path（完整文件夹路径）；回给用户时默认按 folder_path 分组，用目录树形式呈现（文件夹一行，文件缩进列出）。"
                        "同名文件按完整路径区分；不要把平铺结果揉成一段话，也不要把未出现在结果中的文件夹判断为空。",
            input_schema={
                "type": "object",
                "properties": {
                    "space": {"type": "string", "enum": ["project", "mind", "asset", "personal"]},
                    "project_id": {"type": "integer"},
                    "folder_id": {"type": "integer", "description": "只查询指定文件夹内的文件"},
                    "folder": {"type": "string", "description": "按文件夹名称筛选；已知 folder_id 时优先使用 id"},
                    "ext": {"type": "string", "description": "扩展名，如 png/md"},
                    "q": {"type": "string", "description": "兼容旧调用的单个名称关键词；优先使用 queries"},
                    "queries": {"type": "array", "items": {"type": "string"},
                                "description": "可选多个名称关键词，默认 OR，最多 8 个"},
                    "mode": {"type": "string", "enum": ["OR", "AND"],
                             "description": "关键词匹配模式，默认 OR"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200,
                              "description": "最多返回多少条，默认 100；查询大文件夹时可提高到 200"},
                },
            },
            handler=_list_files,
        ),
        Tool(
            name="read_file", label="读取文件",
            description="读取文件内容：文本类（md/txt/json/代码等，≤256KB）直接读；PDF/Word/Excel/PPT 自动提取文本；图片可识别图像；音频转写；视频提取代表画面并转写音频（需配置对应模型）。"
                        "读到后按需提炼、别整段复述给用户：大文件挑相关部分讲；JSON/YAML 点出顶层键和关键字段；CSV/TSV 给表头+前几行再总结各列；只回答用户问的那块。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "description": "文件 id（可选）"},
                    "file": {"type": "string", "description": "文件名（推荐：直接用名字，无需 id）"},
                },
                "required": [],
            },
            handler=_read_file,
        ),
        Tool(
            name="edit_file", label="修改文件",
            description="修改文本类文件内容。mode=replace_all 整体替换(content)；append 追加(content)；find_replace 查找替换(find/replace)。"
                        "**要改多个文件用 edits=[{file,mode,...},...] 一次调用全改**（如多文件统一把某词查找替换：每项填同样的 find/replace）。逐项回报成功/失败。",
            input_schema={
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "description": "批量：每项一个独立编辑 {file 或 file_id, mode, content/find/replace}。改多个文件用这个",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string"},
                                "file_id": {"type": "integer"},
                                "mode": {"type": "string", "enum": ["replace_all", "append", "find_replace"]},
                                "content": {"type": "string"},
                                "find": {"type": "string"},
                                "replace": {"type": "string"},
                            },
                            "required": ["mode"],
                        },
                    },
                    "file_id": {"type": "integer", "description": "单个：文件 id"},
                    "file": {"type": "string", "description": "单个：文件名"},
                    "mode": {"type": "string", "enum": ["replace_all", "append", "find_replace"]},
                    "content": {"type": "string", "description": "replace_all/append 用"},
                    "find": {"type": "string", "description": "find_replace 用"},
                    "replace": {"type": "string", "description": "find_replace 用"},
                },
            },
            handler=_edit_file,
            mutates=True,
        ),
        Tool(
            name="create_document", label="生成文档",
            description=(
                "新建一个文件。format 为可编辑文本类型时 content 按原文直接写入；"
                "format=docx 或 pdf 时 content 请提供 HTML（将转换为 Word/PDF）；"
                "format=xlsx 时 content 请提供 CSV（将转换为 Excel）。默认放在个人文件空间。"
                "**未指定 folder_id 且目标空间已有文件夹时，先调用 list_folders 审视一级目录；"
                "命中唯一相关目录后再审视它的子目录，确认无更合适目录才允许保存到根目录。**"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "文件名（可不带扩展名）"},
                    "format": {"type": "string", "enum": sorted(_DOC_MIME), "description": "可编辑文本、docx、pdf 或 xlsx"},
                    "space": {"type": "string", "enum": ["project", "personal"], "description": "默认 personal"},
                    "project_id": {"type": "integer", "description": "space=project 时必填"},
                    "folder_id": {"type": "integer"},
                    "content": {"type": "string", "description": "正文（按 format 见上）"},
                },
                "required": ["name", "format", "content"],
            },
            handler=_create_document,
            mutates=True,
        ),
        Tool(
            name="rename_file", label="重命名文件",
            description="重命名文件（不改位置）。单个：file + new_name。"
                        "**批量改名用 renames=[{file,new_name},...] 一次调用全改**——比如「按顺序编号」时，你自己排好序号（作品01、作品02…）一次传进来，别一个个改。逐项回报成功/失败。"
                        "**可选 format**：传了就同时改后缀（修双后缀 bug：format=\"md\" 把 README.md.markdown 改回 README.md），"
                        "不传沿用原 ext。仅文本类同族（md↔txt↔yaml…）互转允许；二进制约等于当前 ext 才允许。",
            input_schema={
                "type": "object",
                "properties": {
                    "renames": {
                        "type": "array",
                        "description": "批量改名：每项 {file 或 file_id, new_name, format?}。按顺序编号等多文件场景用这个",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string", "description": "文件名"},
                                "file_id": {"type": "integer", "description": "文件 id"},
                                "new_name": {"type": "string", "description": "新名（可不带扩展名）"},
                                "format": {"type": "string", "enum": sorted(_DOC_MIME), "description": "可选：改后缀。文本类同族互转允许；二进制需等于当前 ext。"},
                            },
                            "required": ["new_name"],
                        },
                    },
                    "file_id": {"type": "integer", "description": "单个：文件 id"},
                    "file": {"type": "string", "description": "单个：文件名"},
                    "new_name": {"type": "string", "description": "单个：新文件名（可不带扩展名）"},
                    "format": {"type": "string", "enum": sorted(_DOC_MIME), "description": "单个：可选，改后缀（同 renames 规则）"},
                },
            },
            handler=_rename_file,
            mutates=True,
        ),
        Tool(
            name="move_items", label="移动文件/文件夹",
            description="把一批文件和/或文件夹移到同一个目标位置，**一次调用搞定**——不用一个个移。"
                        "files 填文件名/id 数组，folders 填文件夹名/id 数组（两者可只给其一）。"
                        "**移动文件夹会连同里面的所有文件、子文件夹一起递归搬过去，你不需要知道里面有几个文件**——只表达「把这个文件夹搬到那儿」即可，后端负责展开。"
                        "目标用 target.folder 填目标文件夹名（移到空间根填空串）或 target.folder_id。返回逐项注明落点与成功/失败数。",
            input_schema={
                "type": "object",
                "properties": {
                    "files":   {"type": "array", "items": {"type": "string"},
                                "description": "要移动的文件（名称或 id）数组，可空"},
                    "folders": {"type": "array", "items": {"type": "string"},
                                "description": "要移动的文件夹（名称或 id）数组，可空——整夹连内容递归搬"},
                    "target": {
                        "type": "object",
                        "description": "统一落点，所有文件和文件夹都移到这里",
                        "properties": {
                            "folder": {"type": "string", "description": "目标文件夹名称（移到空间根传空串）"},
                            "folder_id": {"type": "integer", "description": "目标文件夹 id（最准；有就优先用）"},
                            "space": {"type": "string", "enum": ["project", "mind", "asset", "personal"]},
                            "project_id": {"type": "integer", "description": "目标在 project 空间时填"},
                        },
                    },
                },
                "required": ["target"],
            },
            handler=_move_items,
            mutates=True,
        ),
        Tool(
            name="copy_file", label="复制文件",
            description="复制一份文件到目标位置（target.folder 填文件夹名；不填则在原位复制一份）。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "description": "源文件 id（可选）"},
                    "file": {"type": "string", "description": "源文件名（推荐：直接用名字）"},
                    "target": {
                        "type": "object",
                        "properties": {
                            "folder": {"type": "string", "description": "目标文件夹名称"},
                            "space": {"type": "string", "enum": ["project", "mind", "asset", "personal"]},
                            "project_id": {"type": "integer"},
                            "folder_id": {"type": "integer"},
                        },
                    },
                },
            },
            handler=_copy_file,
            mutates=True,
        ),
        Tool(
            name="create_folder", label="新建文件夹",
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
            description="删除文件（移入回收站，30 天内可还原，非永久删除）。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "description": "文件 id（可选）"},
                    "file": {"type": "string", "description": "文件名（推荐：直接用名字，无需 id）"},
                },
                "required": [],
            },
            handler=_delete_file,
            mutates=True,
        ),
        Tool(
            name="list_folders", label="查询文件夹",
            description="列出文件夹，可按项目或父文件夹筛选（不传 project_id 看个人空间文件夹）。"
                        "返回 path（根到叶的完整路径）与 depth，决定新文件落点时据此审视一级和相关二级目录。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "parent_id": {"type": "integer"},
                },
            },
            handler=_list_folders,
        ),
        Tool(
            name="rename_folder", label="重命名文件夹",
            description="重命名文件夹。用 name 指定要改的文件夹名（或用 folder_id）。同名文件夹存在于多个项目时必须传 project_id 避免误操作。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "要重命名的文件夹当前名称"},
                    "folder_id": {"type": "integer", "description": "文件夹 id（已知时可用，优先于 name）"},
                    "project_id": {"type": "integer", "description": "文件夹所在项目 id（按名字查找时用于精确定位，防止跨项目误操作）"},
                    "new_name": {"type": "string", "description": "新名称"},
                },
                "required": ["new_name"],
            },
            handler=_rename_folder,
            mutates=True,
        ),
        Tool(
            name="delete_folder", label="删除文件夹",
            description="删除文件夹。用 name 指定文件夹名（或 folder_id）。文件夹及其内容会整体移入回收站，30 天内可恢复。同名文件夹存在于多个项目时必须传 project_id。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "要删除的文件夹名称"},
                    "folder_id": {"type": "integer", "description": "文件夹 id（已知时可用，优先于 name）"},
                    "project_id": {"type": "integer", "description": "文件夹所在项目 id（按名字查找时用于精确定位，防止跨项目误操作）"},
                },
            },
            handler=_delete_folder,
            mutates=True,
        ),
        Tool(
            name="send_file", label="发送文件",
            description="把一个文件**真正发给用户**（网页显示下载/图片卡片；飞书/QQ 直接把文件发到对方聊天里）。"
                        "三种来源：① 用户文件库里的文件——用 file 指定文件名（如「合同.pdf」）或 file_id；"
                        "② 网络图片——用 url 传图片直链（如 image_search 结果的 img_src），会下载后作为聊天附件发出（不进文件库）；"
                        "③ 之前收到/发过、还在暂存区的附件——用 attach_id 直接重发，不重新下载、不进文件库。"
                        "attach_id 来自当轮上下文「用户上传了文件…(attach_id=X)」的提示；如果用户说「刚刚的图/那张图/X平台发的那个」"
                        "但你不知道 attach_id，先调 list_recent_attachments 查出来再传。"
                        "当用户说「把X发给我/给我那个文件/发过来」时**必须调用本工具**——绝不能只回「正在发送/已发给你」却不调用。"
                        "文件库文件**仅在用户明确要文件时才调**；创建/保存文档后**别自动发**——一句话告诉用户存在哪个目录即可。"
                        "但用 url/attach_id 发图时不受此限——用户要找图/要一张图本身就是要看/要发，搜到/查到后可直接调用，不用再问一句「要不要发」。",
            input_schema={
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "文件名（如 合同.pdf），发文件库文件时用"},
                    "file_id": {"type": "integer", "description": "文件 id（已知时可用），发文件库文件时用"},
                    "url": {"type": "string", "description": "网络图片直链（如 image_search 结果的 img_src），传了则忽略 file/file_id"},
                    "title": {"type": "string", "description": "配合 url 用：给这张图起个名字（可选，不传默认「图片」）"},
                    "attach_id": {"type": "string", "description": "之前暂存过的附件 attach_id（见上下文提示，或先调 list_recent_attachments 查），传了则忽略 file/file_id/url"},
                },
            },
            handler=_send_file,
            mutates=True,
        ),
        Tool(
            name="list_recent_attachments", label="查最近暂存的附件",
            description="列出该用户当前所有还在暂存区、未过期的聊天附件（用户发来的图/文件、机器人搜图发过的图等，暂存 7 天）。"
                        "当用户提到「刚刚的图/那张图/昨天发的那个/X平台那张」但当轮上下文里没有 attach_id 提示时用——"
                        "查到后从返回列表里挑出匹配的（按名称/平台/大约多久前判断），再用 send_file(attach_id=...) 重发，"
                        "或 save_uploaded_file(attach_id=...) 存进文件库。列表按暂存时间从新到旧排。",
            input_schema={"type": "object", "properties": {}},
            handler=_list_recent_attachments,
        ),
        Tool(
            name="save_uploaded_file", label="保存上传文件",
            description="把用户在对话里**上传的附件**保存进文件库。当用户上传文件后说「存一下/保存到文件库/存到某项目」时用。"
                        "**用户一次发了多个附件（如连拍的几张图）要用 attach_ids 传数组一次性存全部**——"
                        "别为每张图分别调用，那样每次没对上 id 都各自回退，容易存漏、甚至存错成不相关的附件。"
                        "单个附件用 attach_id。attach_id(s) 来自上下文「用户上传了文件…(attach_id=X)」的提示——"
                        "抄不准也没关系，系统会尽量容错匹配；但当前暂存区里同时有多种不同类型附件（比如图+语音）"
                        "时无法安全瞎猜，会报错列出候选，需要照着给准。"
                        "要存进某个项目就带上 project_id（不传则进 personal）。"
                        "**未指定 folder_id 且目标空间已有文件夹时，先调用 list_folders 审视一级目录；"
                        "命中唯一相关目录后再审视它的子目录，确认无更合适目录才允许保存到根目录。**",
            input_schema={
                "type": "object",
                "properties": {
                    "attach_id": {"type": "string", "description": "单个附件的 attach_id（见上下文提示；可不填，自动取最近上传的——仅当前暂存区无歧义时有效）"},
                    "attach_ids": {"type": "array", "items": {"type": "string"},
                                   "description": "批量保存多个附件时用（如用户连发的几张图），传所有 attach_id，比逐个调用更可靠"},
                    "project_id": {"type": "integer", "description": "存进哪个项目（不填=personal 个人空间）"},
                    "folder_id": {"type": "integer", "description": "存进哪个文件夹（可选）"},
                },
                "required": [],
            },
            handler=_save_uploaded_file,
            mutates=True,
        ),
    ]


FilesSkill().register()
