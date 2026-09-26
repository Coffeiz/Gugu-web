"""agent/tools/files/documents.py 单元补测（CRAP 治理 P1）。

覆盖：create_file 批量校验、read_file 类型分流、edit 单/批量模式矩阵、
rename 单/批量（含 format 修双后缀）、save_uploaded_file 暂存附件入库。
DB 走 conftest 内存库，storage 用 LocalStorageBackend 多点接线（先例 test_grep_tool）。
"""
import json

import pytest

from agent.tools.files.documents import (
    _create_file,
    _edit_file,
    _read_file,
    _rename_file,
    _save_uploaded_file,
)
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService


@pytest.fixture
def storage(tmp_path, monkeypatch):
    s = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.tools.files.get_storage", lambda: s)
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: s)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: s)
    return s


async def _mk_file(db, user, storage, name="笔记.md", content="第一行\n第二行\n第三行\n", **kw):
    result = await FileService(db, storage=storage).create_file(
        user.id,
        space=kw.get("space", "personal"), project_id=kw.get("project_id"),
        folder_id=kw.get("folder_id"), stage_name="", mind_map_id=None,
        display_name=name.rsplit(".", 1)[0], ext=name.rsplit(".", 1)[1],
        mime_type=kw.get("mime_type", "text/markdown"),
        data=content.encode("utf-8"),
    )
    await db.commit()
    return result.file


# ── _create_file：批量校验与逐项失败隔离 ───────────────────────────────────

async def test_create_file_batch_validations_and_isolation(db, user_a, storage):
    bad_args = await _create_file(db, user_a.id, {"files": "not-a-list"})
    assert "files 数组" in bad_args["error"]
    bad_args = await _create_file(db, user_a.id, {"files": []})
    assert "files 数组" in bad_args["error"]
    bad_args = await _create_file(db, user_a.id, {"files": [{"name": "a.md", "content": "x"}] * 21})
    assert "最多创建 20 个" in bad_args["error"]
    bad_args = await _create_file(db, user_a.id, {"files": [{"name": "a.md", "content": "x"}], "target": "x"})
    assert "target 必须是对象" in bad_args["error"]

    result = await _create_file(db, user_a.id, {"files": [
        {"name": "好文件.md", "content": "# 标题"},
        "不是对象",
        {"name": "无扩展名", "content": "x"},
        {"name": "内容.md", "content": 123},
        {"name": "文档.pdf", "content": "x"},
        {"name": "超大.md", "content": "字" * (256 * 1024 + 1)},
        {"name": "围栏.md", "content": "x", "space": "workspace"},   # 未绑定工作区 → 落点被拒
    ]})
    assert result["created_count"] == 1 and result["failed_count"] == 6
    by_index = {f["index"]: f for f in result["failed"]}
    assert "每项必须是对象" in by_index[1]["error"]
    assert "扩展名" in by_index[2]["error"]
    assert "content 必须是字符串" in by_index[3]["error"]
    assert "不能直接生成 pdf" in by_index[4]["error"]
    assert "单文件上限 256KB" in by_index[5]["error"]
    assert "space=workspace" in by_index[6]["error"]
    assert result["created"][0]["name"] == "好文件.md"


# ── _read_file：类型分流 ──────────────────────────────────────────────────

async def test_read_file_text_branch_and_guards(db, user_a, storage, monkeypatch):
    from agent.tools.files.documents import _read_file

    f = await _mk_file(db, user_a, storage)
    result = await _read_file(db, user_a.id, {"file_id": f.id})
    assert result["file_id"] == f.id and result["name"] == "笔记.md"
    assert "第二行" in result["content"]
    assert result["line_range"]["start"] == 1

    rng = await _read_file(db, user_a.id, {"file_id": f.id, "target_lines": "2"})
    assert rng["line_range"] == {"start": 2, "end": 2}
    assert "第二行" in rng["content"] and "第一行" not in rng["content"]

    bad = json.loads(await _read_file(db, user_a.id, {"file_id": f.id, "target_lines": "3-2"}))
    assert "error" in bad

    binary = await _mk_file(db, user_a, storage, name="数据.bin", content="\x00\x01",
                            mime_type="application/octet-stream")
    unsupported = json.loads(await _read_file(db, user_a.id, {"file_id": binary.id}))
    assert "不支持读取该类型" in unsupported["error"]

    big = await _mk_file(db, user_a, storage, name="大文件.md", content="字" * (256 * 1024 + 1))
    oversize = json.loads(await _read_file(db, user_a.id, {"file_id": big.id}))
    assert "超出可读上限" in oversize["error"]


async def test_read_file_image_and_media_branches(db, user_a, storage, monkeypatch):
    from agent.tools.files import documents
    from app.core import chat_attach

    png = await _mk_file(db, user_a, storage, name="图.png", content="\x89PNG",
                         mime_type="image/png")
    monkeypatch.setattr(chat_attach, "vision_ready", lambda *a: False)
    no_vision = json.loads(await documents._read_file(db, user_a.id, {"file_id": png.id}))
    assert "无法识别图像内容" in no_vision["error"]

    monkeypatch.setattr(chat_attach, "vision_ready", lambda *a: True)
    monkeypatch.setattr(chat_attach, "vision_block", lambda data, ext: {"type": "image"})
    block = await documents._read_file(db, user_a.id, {"file_id": png.id})
    assert block["_vision_image"] == {"type": "image"} and "已打开图片" in block["note"]

    async def fake_read_media(f, **kwargs):
        return {"media": f.id}

    monkeypatch.setattr("agent.tools.media_reader.read_media", fake_read_media)
    audio = await _mk_file(db, user_a, storage, name="语音.mp3", content="x",
                           mime_type="audio/mpeg")
    assert await documents._read_file(db, user_a.id, {"file_id": audio.id}) == {"media": audio.id}

    # SVG 走文本源码路径，不伪装成图片块
    svg = await _mk_file(db, user_a, storage, name="矢量.svg",
                         content="<svg><circle r='1'/></svg>", mime_type="image/svg+xml")
    svg_result = await documents._read_file(db, user_a.id, {"file_id": svg.id})
    assert "<svg>" in svg_result["content"]


# ── _edit_file / _edit_one：模式矩阵与防护 ────────────────────────────────

async def test_edit_file_single_modes_and_guards(db, user_a, storage):
    from agent.tools.files.documents import _edit_file

    f = await _mk_file(db, user_a, storage, content="hello world\n")

    unknown = await _edit_file(db, user_a.id, {"file_id": f.id, "mode": "nope"})
    assert "未知 mode" in unknown["error"]

    miss = await _edit_file(db, user_a.id, {"file_id": f.id, "mode": "find_replace",
                                            "find": "不存在", "replace": "x"})
    assert "未找到要替换的内容" in miss["error"]

    rep = await _edit_file(db, user_a.id, {"file_id": f.id, "mode": "find_replace",
                                           "find": "world", "replace": "gugu"})
    assert rep["success"] and "替换 1 处" in rep["change"]

    app = await _edit_file(db, user_a.id, {"file_id": f.id, "mode": "append", "content": "尾部"})
    assert "末尾追加" in app["change"]

    stored = (await storage.get(f.storage_key)).decode()
    assert stored == "hello gugu\n尾部"

    line_edit = await _edit_file(db, user_a.id, {
        "file_id": f.id, "mode": "line_edit",
        "line_edits": [{"target_lines": "1", "expected": "hello gugu", "content": "第一行"}]})
    assert line_edit["success"] and "按行修改 1 行" in line_edit["change"]

    bad_line = await _edit_file(db, user_a.id, {
        "file_id": f.id, "mode": "line_edit", "line_edits": []})
    assert "line_edits 不能为空" in bad_line["error"]


async def test_edit_file_shrink_warning_and_oversize(db, user_a, storage):
    from agent.tools.files.documents import _edit_file

    f = await _mk_file(db, user_a, storage, content="长" * 400)
    shrunk = await _edit_file(db, user_a.id, {"file_id": f.id, "mode": "replace", "content": "短"})
    assert "明显变短" in shrunk["warning"]

    huge = await _edit_file(db, user_a.id, {"file_id": f.id, "mode": "replace",
                                            "content": "字" * (256 * 1024 + 1)})
    assert "修改后文件过大" in huge["error"]

    binary = await _mk_file(db, user_a, storage, name="图.png", content="x", mime_type="image/png")
    not_text = await _edit_file(db, user_a.id, {"file_id": binary.id, "mode": "append", "content": "x"})
    assert "不支持修改该类型" in not_text["error"]


async def test_edit_file_batch_reports_per_item(db, user_a, storage):
    from agent.tools.files.documents import _edit_file

    f1 = await _mk_file(db, user_a, storage, name="甲.md", content="AAA\n")
    f2 = await _mk_file(db, user_a, storage, name="乙.md", content="BBB\n")
    result = await _edit_file(db, user_a.id, {"edits": [
        {"file_id": f1.id, "mode": "replace", "content": "改好的甲"},
        "不是对象",
        {"file_id": 987654, "mode": "append", "content": "x"},
        {"file_id": f2.id, "mode": "find_replace", "find": "BBB", "replace": "改好的乙"},
    ]})
    assert result["edited_count"] == 2 and result["failed_count"] == 2
    assert result["edited"][0]["name"] == "甲.md"
    assert result["failed"][0]["error"] == "每项需是 {file, mode, ...}"
    assert result["failed"][1]["error"] == "没找到这个文件"


# ── _rename_file：单/批量与 format 修正 ───────────────────────────────────

async def test_rename_file_single_batch_and_format(db, user_a, storage):
    from agent.tools.files.documents import _rename_file

    f = await _mk_file(db, user_a, storage, name="旧名.md")

    no_name = json.loads(await _rename_file(db, user_a.id, {"file_id": f.id}))
    assert "需要 new_name" in no_name["error"]

    result = await _rename_file(db, user_a.id, {"file_id": f.id, "new_name": "新名字.md"})
    assert result["success"] and result["name"] == "新名字.md"
    assert result["old_name"] == "旧名.md"

    # format 修正双后缀：markdown → md，mime 跟规范 ext 走
    double = await _mk_file(db, user_a, storage, name="说明.markdown", content="x")
    fixed = await _rename_file(db, user_a.id, {"file_id": double.id,
                                               "new_name": "说明", "format": "md"})
    assert fixed["name"] == "说明.md"

    # 二进制家族转换被拒
    denied = await _rename_file(db, user_a.id, {"file_id": double.id,
                                                "new_name": "试一下", "format": "docx"})
    assert "不能跨文本/二进制格式" in denied["error"]
    denied = await _rename_file(db, user_a.id, {"file_id": double.id,
                                                "new_name": "试一下", "format": "png9"})
    assert "不支持的格式" in denied["error"]

    f2 = await _mk_file(db, user_a, storage, name="批量甲.md", content="x")
    f3 = await _mk_file(db, user_a, storage, name="批量乙.md", content="x")
    batch = await _rename_file(db, user_a.id, {"renames": [
        {"file_id": f2.id, "new_name": "序号一.md"},
        {"new_name": "缺文件"},
        {"file_id": f3.id},
    ]})
    assert batch["renamed_count"] == 1 and batch["failed_count"] == 2


# ── _save_uploaded_file / _save_one_attach：暂存附件入库 ──────────────────

def _fake_attach(monkeypatch, metas, data=b"attach-bytes", fail_read=False):
    from app.core import chat_attach

    async def fake_resolve(user_id, attach_id):
        meta = metas.get(attach_id)
        return (meta, "") if meta else (None, "")

    async def fake_read_bytes(meta):
        if fail_read:
            raise RuntimeError("物理字节丢了")
        return data

    monkeypatch.setattr(chat_attach, "resolve_attach", fake_resolve)
    monkeypatch.setattr(chat_attach, "read_bytes", fake_read_bytes)


async def test_save_uploaded_file_guards_and_single(db, user_a, storage, monkeypatch):
    from agent.tools.files.documents import _save_uploaded_file

    err = await _save_uploaded_file(db, user_a.id, {"source": "attach_id"})
    assert err == {"error": "source=attach_id 时必须提供 attach_id"}
    err = await _save_uploaded_file(db, user_a.id, {"source": "attach_ids"})
    assert err == {"error": "source=attach_ids 时必须提供 attach_ids"}

    _fake_attach(monkeypatch, {})
    miss = json.loads(await _save_uploaded_file(db, user_a.id, {"attach_id": "gone"}))
    assert "没找到可保存的附件" in miss["error"]

    meta = {"attach_id": "a1", "name": "截图", "ext": "png",
            "mime": "image/png", "storage_key": "u/.chat_staging/a1.png"}
    # source=latest 会把 attach_id 清空再解析（等价「最近上传」），空键也要能解析到
    _fake_attach(monkeypatch, {"a1": meta, "": meta})
    result = await _save_uploaded_file(db, user_a.id, {"attach_id": "a1"})
    assert result["file_id"] and result["name"] == "截图.png"
    latest = await _save_uploaded_file(db, user_a.id, {"source": "latest"})
    assert latest["file_id"] and latest["name"].startswith("截图")     # source=latest 也走解析落库

    _fake_attach(monkeypatch, {"a1": meta}, fail_read=True)
    read_fail = json.loads(await _save_uploaded_file(db, user_a.id, {"attach_id": "a1"}))
    assert "读取附件失败" in read_fail["error"]


async def test_save_uploaded_file_batch_mixed(db, user_a, storage, monkeypatch):
    from agent.tools.files.documents import _save_uploaded_file

    not_list = json.loads(await _save_uploaded_file(db, user_a.id, {"attach_ids": "a1"}))
    assert "attach_ids 需要是数组" in not_list["error"]

    metas = {"ok1": {"attach_id": "ok1", "name": "甲", "ext": "txt", "mime": "text/plain"},
             "ok2": {"attach_id": "ok2", "name": "乙", "ext": "txt", "mime": "text/plain"}}
    _fake_attach(monkeypatch, metas)
    result = await _save_uploaded_file(db, user_a.id, {"attach_ids": ["ok1", "gone", "ok2"]})
    assert result["success"] and result["saved_count"] == 2 and result["failed_count"] == 1
    assert result["failed"][0]["attach_id"] == "gone"
    assert {item["name"] for item in result["saved"]} == {"甲.txt", "乙.txt"}
