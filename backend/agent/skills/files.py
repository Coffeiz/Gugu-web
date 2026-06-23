"""文件领域技能：查 / 读 / 改 / 整理 / 生成。

复用 `app.api.v1.files` 的现成 helper（`_build_key`/`_resolve_conflict`/
`_fmt_size`/`_move_to_trash`/`_color`）与存储层 `get_storage()`，整理类工具
复刻 `update_file` 的 key 重建逻辑，不自己拼路径。

读/改仅限文本类（白名单 ext）且 ≤256KB，避免把二进制当文本、撑爆上下文。
生成（create_document）：文本格式直写；docx/pdf 由 HTML、xlsx 由 CSV 经 LibreOffice
转换（系统已装，零新依赖）。
"""
import json
from datetime import datetime

from sqlalchemy import select

from app.models import File, Folder, Project
from app.services.storage import get_storage
from app.api.v1.files import (
    _build_key, _resolve_conflict, _fmt_size, _move_to_trash, _color,
)
from agent.skills.base import BaseSkill, Tool

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
    "md":   "text/markdown",   "txt":  "text/plain",
    "json": "application/json", "csv": "text/csv",
    "yaml": "text/yaml",       "yml":  "text/yaml",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf":  "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


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
    project_name = project_year = project_month = folder_name = ""
    if space == "project" and project_id:
        p = await db.get(Project, project_id)
        if not p or p.user_id != user_id:
            raise ValueError("目标项目不存在")
        project_name = p.name
        date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    if folder_id:
        fo = await db.get(Folder, folder_id)
        if not fo or fo.user_id != user_id:
            raise ValueError("目标文件夹不存在")
        folder_name = fo.name
    key = _build_key(
        uid=user_id, space=space, display_name=display_name, ext=ext,
        project_name=project_name, project_id=project_id or 0,
        project_year=project_year, project_month=project_month,
        folder_name=folder_name,
    )
    return key


def _strip_ext(name: str, ext: str) -> str:
    low = name.lower()
    if low.endswith("." + ext.lower()):
        return name[: -(len(ext) + 1)]
    return name


# ── handlers ──
async def _list_files(db, user_id, args: dict):
    stmt = select(File).where(File.user_id == user_id, File.deleted_at.is_(None))
    if args.get("space"):
        stmt = stmt.where(File.space == args["space"])
    if args.get("project_id"):
        stmt = stmt.where(File.project_id == args["project_id"])
    if args.get("ext"):
        stmt = stmt.where(File.ext == args["ext"].lower().lstrip("."))
    if args.get("q"):
        stmt = stmt.where(File.display_name.ilike(f"%{args['q']}%"))
    stmt = stmt.order_by(File.updated_at.desc()).limit(args.get("limit", 30))
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {"id": f.id, "name": f"{f.display_name}.{f.ext}", "ext": f.ext,
         "space": f.space, "size": f.size, "project_id": f.project_id,
         "folder_id": f.folder_id}
        for f in rows
    ]


async def _read_file(db, user_id, args: dict):
    from app.core import doctext
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    ext = f.ext.lower()
    is_doc = ext in doctext.EXTRACTABLE      # PDF/docx/xlsx/pptx 等，需工具提取文本
    if ext not in TEXT_EXTS and not is_doc:
        return json.dumps({"error": f"不支持读取该类型（{f.ext}），仅支持文本类 + PDF/Office 文档"})
    cap = doctext.EXTRACT_MAX_BYTES if is_doc else READ_MAX_BYTES
    if (f.size_bytes or 0) > cap:
        return json.dumps({"error": f"文件过大（{f.size}），超出可读上限"})
    try:
        data = await get_storage().get(f.storage_key)
        text = await doctext.extract_text(data, ext)   # 文本类直接 decode；文档走 pdftotext/LibreOffice
    except Exception as e:
        return json.dumps({"error": f"读取失败：{str(e)[:80]}"})
    return {"file_id": f.id, "name": f"{f.display_name}.{f.ext}", "content": text}


async def _edit_file(db, user_id, args: dict):
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    if f.ext.lower() not in TEXT_EXTS:
        return json.dumps({"error": f"不支持修改该类型（{f.ext}），仅支持文本类文件"})
    if (f.size_bytes or 0) > READ_MAX_BYTES:
        return json.dumps({"error": "文件过大，超出可改上限 256KB"})

    storage = get_storage()
    try:
        old = (await storage.get(f.storage_key)).decode("utf-8", errors="replace")
    except Exception as e:
        return json.dumps({"error": f"读取失败：{str(e)[:80]}"})

    mode = args.get("mode", "replace_all")
    if mode == "replace_all":
        new = args.get("content", "")
    elif mode == "append":
        new = old + args.get("content", "")
    elif mode == "find_replace":
        find = args.get("find", "")
        if not find or find not in old:
            return json.dumps({"error": "未找到要替换的内容（find）"})
        new = old.replace(find, args.get("replace", ""))
    else:
        return json.dumps({"error": f"未知 mode: {mode}"})

    data = new.encode("utf-8")
    await storage.put(f.storage_key, data, f.mime_type)
    f.size_bytes = len(data)
    f.size = _fmt_size(len(data))
    f.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "file_id": f.id, "new_size": f.size}


async def _create_document(db, user_id, args: dict):
    fmt = (args.get("format") or "md").lower()
    if fmt not in _DOC_MIME:
        return json.dumps({"error": f"不支持的格式: {fmt}", "supported": list(_DOC_MIME)}, ensure_ascii=False)
    name = (args.get("name") or "").strip()
    if not name:
        return json.dumps({"error": "缺少必填参数 name（文件名）；请带上 name 再调用本工具"}, ensure_ascii=False)
    display_name = _strip_ext(name, fmt)
    space = args.get("space", "personal")
    content = args.get("content", "")

    # 生成二进制内容
    try:
        if fmt in ("docx", "pdf"):
            data = await _libreoffice_convert(content.encode("utf-8"), "html", fmt)
        elif fmt == "xlsx":
            data = await _libreoffice_convert(content.encode("utf-8"), "csv", "xlsx")
        else:  # 文本类直写
            data = content.encode("utf-8")
    except Exception as e:
        return json.dumps({"error": f"生成失败：{str(e)[:120]}"})

    storage = get_storage()
    try:
        base_key = await _resolve_key(
            db, user_id, space, display_name, fmt,
            project_id=args.get("project_id"), folder_id=args.get("folder_id"),
        )
    except ValueError as e:
        return json.dumps({"error": str(e)})
    final_key, final_name = await _resolve_conflict(storage, base_key, display_name, fmt)
    await storage.put(final_key, data, _DOC_MIME[fmt])

    db_file = File(
        user_id=user_id, display_name=final_name, ext=fmt, space=space,
        project_id=args.get("project_id") if space == "project" else None,
        folder_id=args.get("folder_id"), stage_name="",
        storage_key=final_key, size=_fmt_size(len(data)), size_bytes=len(data),
        mime_type=_DOC_MIME[fmt],
    )
    db.add(db_file)
    await db.commit()
    await db.refresh(db_file)
    return {"success": True, "file_id": db_file.id,
            "name": f"{final_name}.{fmt}", "size": db_file.size}


async def _save_uploaded_file(db, user_id, args: dict):
    """把用户聊天里上传的暂存附件保存进文件库（personal 空间）。"""
    from app.core import chat_attach
    aid = (args.get("attach_id") or "").strip()
    if not aid:
        return json.dumps({"error": "需提供 attach_id（来自用户上传的附件）"}, ensure_ascii=False)
    meta = await chat_attach.get_meta(user_id, aid)
    if not meta:
        return json.dumps({"error": "附件不存在或已过期（聊天附件暂存 6 小时）"}, ensure_ascii=False)
    try:
        data = await chat_attach.read_bytes(meta)
    except Exception as e:
        return json.dumps({"error": f"读取附件失败：{str(e)[:80]}"}, ensure_ascii=False)
    ext = meta.get("ext") or "bin"
    display_name = meta.get("name") or "上传文件"
    storage = get_storage()
    try:
        base_key = await _resolve_key(db, user_id, "personal", display_name, ext)
    except ValueError as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)
    final_key, final_name = await _resolve_conflict(storage, base_key, display_name, ext)
    await storage.put(final_key, data, meta.get("mime") or "application/octet-stream")
    db_file = File(
        user_id=user_id, display_name=final_name, ext=ext, space="personal",
        project_id=None, folder_id=None, stage_name="",
        storage_key=final_key, size=_fmt_size(len(data)), size_bytes=len(data),
        mime_type=meta.get("mime") or "",
    )
    db.add(db_file)
    await db.commit()
    await db.refresh(db_file)
    return {"success": True, "file_id": db_file.id,
            "name": f"{final_name}.{ext}", "space": "personal", "size": db_file.size}


async def _rename_file(db, user_id, args: dict):
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    new_display = _strip_ext(args["new_name"], f.ext)
    try:
        new_key = await _resolve_key(
            db, user_id, f.space, new_display, f.ext,
            project_id=f.project_id, folder_id=f.folder_id,
        )
    except ValueError as e:
        return json.dumps({"error": str(e)})
    storage = get_storage()
    if new_key != f.storage_key:
        new_key, new_display = await _resolve_conflict(storage, new_key, new_display, f.ext)
        await storage.rename_file(f.storage_key, new_key)
        f.storage_key = new_key
    f.display_name = new_display
    f.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "file_id": f.id, "name": f"{new_display}.{f.ext}"}


async def _resolve_file(db, user_id, args):
    """按 file_id 或文件名 file 定位（仅未删除文件）；返回 (File|None, 错误JSON|None)。"""
    fid = args.get("file_id")
    if fid:
        f = await db.get(File, fid)
        if not f or str(f.user_id) != str(user_id) or f.deleted_at is not None:
            return None, json.dumps({"error": "文件不存在"})
        return f, None
    name = args.get("file")
    if name:
        name = str(name).strip()
        base = name.rsplit(".", 1)[0] if "." in name else name
        base_stmt = select(File).where(File.user_id == user_id, File.deleted_at.is_(None))
        rows = (await db.execute(base_stmt.where(File.display_name == base))).scalars().all()
        if not rows:
            rows = (await db.execute(base_stmt.where(File.display_name.ilike(f"%{base}%")))).scalars().all()
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
    stmt = select(Folder).where(Folder.user_id == user_id, Folder.name == name)
    if space == "project" and project_id:
        stmt = stmt.where(Folder.project_id == project_id)
    elif space and space != "project":
        stmt = stmt.where(Folder.project_id.is_(None))
    rows = (await db.execute(stmt)).scalars().all()
    if not rows:
        avail = (await db.execute(select(Folder.name).where(Folder.user_id == user_id))).scalars().all()
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


async def _move_file(db, user_id, args: dict):
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    target = args.get("target", {})
    space = target.get("space", f.space)
    project_id = target.get("project_id", f.project_id)
    folder_id = target.get("folder_id", f.folder_id)

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

    # 无变动 → 明确报错，而不是假成功（避免咕咕误报"已移动"）
    cur_pid = f.project_id
    new_pid = project_id if space == "project" else None
    if folder_id == f.folder_id and space == f.space and new_pid == cur_pid:
        return json.dumps({"error": "未指定有效目标或文件已在该位置，未移动。"
                                    "请用 target.folder 指定目标文件夹名，或先用 list_folders 确认。",
                           "current_folder_id": f.folder_id})

    try:
        new_key = await _resolve_key(
            db, user_id, space, f.display_name, f.ext,
            project_id=project_id, folder_id=folder_id,
        )
    except ValueError as e:
        return json.dumps({"error": str(e)})
    storage = get_storage()
    new_display = f.display_name
    if new_key != f.storage_key:
        new_key, new_display = await _resolve_conflict(storage, new_key, f.display_name, f.ext)
        try:
            await storage.rename_file(f.storage_key, new_key)
        except Exception as e:
            return json.dumps({"error": f"移动失败（物理文件可能已丢失）：{str(e)[:80]}"})
        f.storage_key = new_key
    f.display_name = new_display
    f.space = space
    f.project_id = new_pid
    f.folder_id = folder_id
    if "stage_name" in target:
        f.stage_name = target["stage_name"]
    f.updated_at = datetime.utcnow()
    await db.commit()

    folder_name = "（根目录）"
    if folder_id:
        fo = await db.get(Folder, folder_id)
        folder_name = fo.name if fo else "（根目录）"
    return {"success": True, "file_id": f.id, "name": f"{f.display_name}.{f.ext}",
            "moved_to": folder_name, "folder_id": f.folder_id}


async def _create_folder(db, user_id, args: dict):
    if args.get("project_id"):
        p = await db.get(Project, args["project_id"])
        if not p or p.user_id != user_id:
            return json.dumps({"error": "项目不存在"})
    if args.get("parent_id"):
        par = await db.get(Folder, args["parent_id"])
        if not par or par.user_id != user_id:
            return json.dumps({"error": "父文件夹不存在"})
    fo = Folder(
        user_id=user_id, name=args["name"],
        project_id=args.get("project_id"), parent_id=args.get("parent_id"),
    )
    db.add(fo)
    await db.commit()
    await db.refresh(fo)
    return {"success": True, "folder_id": fo.id, "name": fo.name}


async def _delete_file(db, user_id, args: dict):
    # 软删进回收站，30 天可还原 —— 非不可逆，无需二次确认
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    fid = f.id; fname = f"{f.display_name}.{f.ext}"
    await _move_to_trash(get_storage(), f)
    f.deleted_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "file_id": fid, "name": fname,
            "note": "已移入回收站，30 天内可还原"}


async def _list_folders(db, user_id, args: dict):
    stmt = select(Folder).where(Folder.user_id == user_id)
    if args.get("project_id") is not None:
        stmt = stmt.where(Folder.project_id == args["project_id"])
    if args.get("parent_id") is not None:
        stmt = stmt.where(Folder.parent_id == args["parent_id"])
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {"id": f.id, "name": f.name, "project_id": f.project_id, "parent_id": f.parent_id}
        for f in rows
    ]


async def _find_folder(db, user_id, args: dict):
    """按 folder_id 或文件夹名定位；返回 Folder 或错误 JSON 字符串（含可选项）。"""
    fid = args.get("folder_id")
    if fid:
        fo = await db.get(Folder, fid)
        if not fo or fo.user_id != user_id:
            return json.dumps({"error": "文件夹不存在"})
        return fo
    name = args.get("name") or args.get("folder")
    if name:
        fo, err = await _folder_by_name(db, user_id, name)
        return err if err else fo
    return json.dumps({"error": "需提供 folder_id 或文件夹名 name"})


async def _rename_folder(db, user_id, args: dict):
    fo = await _find_folder(db, user_id, args)
    if isinstance(fo, str):
        return fo
    fo.name = args["new_name"]
    await db.commit()
    return {"success": True, "folder_id": fo.id, "name": fo.name}


async def _delete_folder(db, user_id, args: dict):
    fo = await _find_folder(db, user_id, args)
    if isinstance(fo, str):
        return fo
    # 与后端一致：内部文件移到根（folder_id=None，文件不删），再删文件夹记录
    files = (await db.execute(
        select(File).where(File.folder_id == fo.id, File.user_id == user_id)
    )).scalars().all()
    moved = len(files)
    fid = fo.id
    fname = fo.name
    for f in files:
        f.folder_id = None
    await db.delete(fo)
    await db.commit()
    note = (f"文件夹「{fname}」已删除；原有 {moved} 个文件已移至根目录（未删除、仍在文件库根目录，不进回收站）"
            if moved else f"空文件夹「{fname}」已删除")
    return {"success": True, "deleted_folder_id": fid, "note": note}


async def _copy_file(db, user_id, args: dict):
    f, _err = await _resolve_file(db, user_id, args)
    if _err:
        return _err
    target = args.get("target", {})
    space = target.get("space", f.space)
    project_id = target.get("project_id", f.project_id)
    folder_id = target.get("folder_id", f.folder_id)
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
    try:
        base_key = await _resolve_key(db, user_id, space, f.display_name, f.ext,
                                      project_id=project_id, folder_id=folder_id)
    except ValueError as e:
        return json.dumps({"error": str(e)})
    storage = get_storage()
    new_key, new_display = await _resolve_conflict(storage, base_key, f.display_name, f.ext)
    try:
        data = await storage.get(f.storage_key)
    except Exception as e:
        return json.dumps({"error": f"复制失败（源文件可能已丢失）：{str(e)[:80]}"})
    await storage.put(new_key, data, f.mime_type)
    new_file = File(
        user_id=user_id, display_name=new_display, ext=f.ext, space=space,
        project_id=project_id if space == "project" else None, folder_id=folder_id,
        stage_name=f.stage_name, storage_key=new_key, size=f.size,
        size_bytes=f.size_bytes, mime_type=f.mime_type,
    )
    db.add(new_file)
    await db.commit()
    await db.refresh(new_file)
    return {"success": True, "file_id": new_file.id, "name": f"{new_display}.{f.ext}"}


async def _send_file(db, user_id, args: dict):
    """把用户文件库里的文件发到对话窗口（前端渲染可下载卡片）。
    返回 _artifact，core 据此推一个 file 事件给前端；普通字段回给 LLM。"""
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
        },
    }


class FilesSkill(BaseSkill):
    name = "files"
    tools = [
        Tool(
            name="list_files", label="查询文件",
            description="查询文件，可按空间(project/mind/asset/personal)、项目、扩展名、名称关键词筛选。",
            input_schema={
                "type": "object",
                "properties": {
                    "space": {"type": "string", "enum": ["project", "mind", "asset", "personal"]},
                    "project_id": {"type": "integer"},
                    "ext": {"type": "string", "description": "扩展名，如 png/md"},
                    "q": {"type": "string", "description": "名称模糊匹配"},
                },
            },
            handler=_list_files,
        ),
        Tool(
            name="read_file", label="读取文件",
            description="读取文件内容：文本类（md/txt/json/代码等，≤256KB）直接读；PDF/Word/Excel/PPT 会自动提取文本。图片/视频/音频等仍不可读。",
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
            description="修改文本类文件内容。mode=replace_all 整体替换(content)；append 追加(content)；find_replace 查找替换(find/replace)。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "description": "文件 id（可选）"},
                    "file": {"type": "string", "description": "文件名（推荐：直接用名字）"},
                    "mode": {"type": "string", "enum": ["replace_all", "append", "find_replace"]},
                    "content": {"type": "string", "description": "replace_all/append 用"},
                    "find": {"type": "string", "description": "find_replace 用"},
                    "replace": {"type": "string", "description": "find_replace 用"},
                },
                "required": ["mode"],
            },
            handler=_edit_file,
        ),
        Tool(
            name="create_document", label="生成文档",
            description=(
                "新建一个文件。format 为 md/txt/json/csv 时 content 为对应纯文本直接写入；"
                "format=docx 或 pdf 时 content 请提供 HTML（将转换为 Word/PDF）；"
                "format=xlsx 时 content 请提供 CSV（将转换为 Excel）。默认放在个人文件空间。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "文件名（可不带扩展名）"},
                    "format": {"type": "string", "enum": ["md", "txt", "json", "csv", "yaml", "docx", "pdf", "xlsx"]},
                    "space": {"type": "string", "enum": ["project", "personal"], "description": "默认 personal"},
                    "project_id": {"type": "integer", "description": "space=project 时必填"},
                    "folder_id": {"type": "integer"},
                    "content": {"type": "string", "description": "正文（按 format 见上）"},
                },
                "required": ["name", "format", "content"],
            },
            handler=_create_document,
        ),
        Tool(
            name="rename_file", label="重命名文件",
            description="重命名文件（不改变所在位置）。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "description": "文件 id（可选）"},
                    "file": {"type": "string", "description": "文件名（推荐：直接用名字）"},
                    "new_name": {"type": "string", "description": "新文件名（可不带扩展名）"},
                },
                "required": ["new_name"],
            },
            handler=_rename_file,
        ),
        Tool(
            name="move_file", label="移动文件",
            description="把文件移动到目标位置。移动到文件夹用 target.folder 填文件夹名称即可（无需知道 id）；移回根目录填空字符串。返回会注明移到了哪。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "description": "文件 id（可选）"},
                    "file": {"type": "string", "description": "文件名（推荐：直接用名字）"},
                    "target": {
                        "type": "object",
                        "properties": {
                            "folder": {"type": "string", "description": "目标文件夹名称（推荐用法；移回根目录传空串）"},
                            "space": {"type": "string", "enum": ["project", "mind", "asset", "personal"]},
                            "project_id": {"type": "integer"},
                            "folder_id": {"type": "integer", "description": "目标文件夹 id（已知时可用，否则用 folder 名称）"},
                            "stage_name": {"type": "string"},
                        },
                    },
                },
                "required": ["target"],
            },
            handler=_move_file,
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
        ),
        Tool(
            name="list_folders", label="查询文件夹",
            description="列出文件夹，可按项目或父文件夹筛选（不传 project_id 看个人空间文件夹）。",
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
            description="重命名文件夹。用 name 指定要改的文件夹名（或用 folder_id）。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "要重命名的文件夹当前名称"},
                    "folder_id": {"type": "integer", "description": "文件夹 id（已知时可用）"},
                    "new_name": {"type": "string", "description": "新名称"},
                },
                "required": ["new_name"],
            },
            handler=_rename_folder,
        ),
        Tool(
            name="delete_folder", label="删除文件夹",
            description="删除文件夹。用 name 指定文件夹名（或 folder_id）。注意：夹内文件不会被删除，会移动到根目录（仍在文件库，不进回收站）——请如实告知用户，别说成文件被删/可还原。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "要删除的文件夹名称"},
                    "folder_id": {"type": "integer", "description": "文件夹 id（已知时可用）"},
                },
            },
            handler=_delete_folder,
        ),
        Tool(
            name="send_file", label="发送文件",
            description="把用户文件库里的一个文件**真正发给用户**（网页显示下载卡片；飞书/QQ 直接把文件发到对方聊天里）。当用户说「把X发给我/给我那个文件/发过来」时**必须调用本工具**——绝不能只回「正在发送/已发给你」却不调用。用 file 指定文件名（如「合同.pdf」）或 file_id。",
            input_schema={
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "文件名（如 合同.pdf）"},
                    "file_id": {"type": "integer", "description": "文件 id（已知时可用）"},
                },
            },
            handler=_send_file,
        ),
        Tool(
            name="save_uploaded_file", label="保存上传文件",
            description="把用户在对话里**上传的附件**保存进文件库（personal 空间）。当用户上传文件后说「存一下/保存到文件库/帮我存起来」时用。attach_id 来自上下文里「用户上传了文件…(attach_id=X)」的提示。",
            input_schema={
                "type": "object",
                "properties": {
                    "attach_id": {"type": "string", "description": "上传附件的 attach_id（见上下文提示）"},
                },
                "required": ["attach_id"],
            },
            handler=_save_uploaded_file,
        ),
    ]


FilesSkill().register()
