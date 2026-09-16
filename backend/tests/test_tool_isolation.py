"""工具层越权测试：A 拿着 B 的资源 id 调工具，必须得到「不存在」，绝不能拿到数据。

覆盖策略：不逐一打 60 个工具，而是打它们的**共用资源解析漏斗**——每个领域的
_resolve_* / 带归属校验的 handler。几乎所有按 id 操作的工具都经过这些漏斗，
漏斗安全 = 该领域按 id 的路径安全（按名字定位的路径查询本身就 where user_id，
由各自实现分别保证）。每个领域同时配一条「本人能正常访问」的正向对照，防止
隔离层写得过严把自己人也挡了。

新增领域/工具时：给它的 resolver 补一组 A→B 用例是**默认动作**（商用就绪评审
P0-2 的 CI 红线，scripts/check_ownership.py 静态守卫 + 本文件动态验证成对出现）。
"""
import json
import types

from app.core.tz import now_utc

from app.models import (
    CalendarEvent, Client, ConversationSession, ConversationMessage,
    File, Folder, Project, ScheduledTask, WorkspaceDirectory,
)

from agent.tools.files import _list_dir, _resolve_file, _resolve_key, _resolve_target
from agent.tools.projects import _resolve_project, _update_project
from agent.tools.calendar import _resolve_event, _remove_event_reminder
from agent.tools.clients import _resolve_client
from agent.tools.scheduled_tasks import _resolve_task
from agent.tools.conversations import _read_conversation
from agent.tools.trash import _restore_file, _permanent_delete


def _is_err(res) -> bool:
    """handler 的错误路径返回 JSON 字符串 {"error": ...}。"""
    if isinstance(res, str):
        try:
            return "error" in json.loads(res)
        except Exception:
            return False
    return False


# ── fixtures 辅助：给 owner 造各领域资源 ──────────────────────────────────────

async def _mk(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


# ── files ─────────────────────────────────────────────────────────────────────

async def test_file_resolve_cross_user(db, user_a, user_b):
    f = await _mk(db, File(user_id=user_b.id, display_name="secret", ext="md", storage_key="k"))
    got, err = await _resolve_file(db, user_a.id, {"file_id": f.id})
    assert got is None and _is_err(err)


async def test_file_resolve_owner_ok(db, user_b):
    f = await _mk(db, File(user_id=user_b.id, display_name="mine", ext="md", storage_key="k"))
    got, err = await _resolve_file(db, user_b.id, {"file_id": f.id})
    assert err is None and got.id == f.id


async def test_resolve_key_cross_user_project(db, user_a, user_b):
    p = await _mk(db, Project(user_id=user_b.id, name="B的项目"))
    import pytest
    with pytest.raises(ValueError):
        await _resolve_key(db, user_a.id, "project", "doc", "md", project_id=p.id)


async def test_resolve_key_uses_nested_folder_path(db, user_a):
    project = await _mk(db, Project(user_id=user_a.id, name="资料项目"))
    root = await _mk(db, Folder(user_id=user_a.id, project_id=project.id, name="资料"))
    child = await _mk(db, Folder(user_id=user_a.id, project_id=project.id, parent_id=root.id, name="会议纪要"))
    key = await _resolve_key(
        db, user_a.id, "project", "doc", "md",
        project_id=project.id, folder_id=child.id,
    )
    assert key.endswith("/资料/会议纪要/doc.md")


async def test_resolve_key_rejects_folder_from_other_space(db, user_a):
    project = await _mk(db, Project(user_id=user_a.id, name="项目 A"))
    personal_folder = await _mk(db, Folder(user_id=user_a.id, name="个人资料"))
    import pytest
    with pytest.raises(ValueError):
        await _resolve_key(
            db, user_a.id, "project", "doc", "md",
            project_id=project.id, folder_id=personal_folder.id,
        )


async def test_list_dir_returns_full_folder_path(db, user_a):
    root = await _mk(db, Folder(user_id=user_a.id, name="咕咕开发"))
    child = await _mk(db, Folder(user_id=user_a.id, parent_id=root.id, name="方案"))
    file = await _mk(db, File(
        user_id=user_a.id, display_name="ReAct 对比", ext="md",
        folder_id=child.id, storage_key="k",
    ))
    result = await _list_dir(db, user_a.id, {"q": "ReAct"})
    result = next(item for item in result["files"] if item["id"] == file.id)
    assert result["folder_path"] == "咕咕开发/方案"


async def test_list_dir_filters_by_folder_id(db, user_a):
    target = await _mk(db, Folder(user_id=user_a.id, name="原神"))
    other = await _mk(db, Folder(user_id=user_a.id, name="星穹铁道"))
    inside = await _mk(db, File(
        user_id=user_a.id, display_name="原神图片", ext="png",
        folder_id=target.id, storage_key="inside",
    ))
    await _mk(db, File(
        user_id=user_a.id, display_name="星穹图片", ext="png",
        folder_id=other.id, storage_key="other",
    ))

    result = await _list_dir(db, user_a.id, {"folder": target.id})

    assert result["total"] == 1
    assert [item["id"] for item in result["files"]] == [inside.id]


async def test_list_dir_shown_total_reveals_truncation(db, user_a):
    """shown/total 契约：被 limit 截断时必须暴露真实总数，不能让调用方把前 N 条当全量。

    真实漏判案例：根目录清理时模型按更新时间倒序只拿前 20 条，两条排在截断线外的
    文件被当成「不存在」。
    """
    folder = await _mk(db, Folder(user_id=user_a.id, name="截图"))
    for i in range(3):
        await _mk(db, File(
            user_id=user_a.id, display_name=f"shot-{i}", ext="png",
            folder_id=folder.id, storage_key=f"k{i}",
        ))

    result = await _list_dir(db, user_a.id, {"folder": folder.id, "limit": 2})

    assert result["total"] == 3
    assert result["shown"] == 2
    assert len(result["files"]) == 2

    full = await _list_dir(db, user_a.id, {"folder": folder.id, "limit": 200})
    assert full["total"] == 3 and full["shown"] == 3


async def test_list_dir_offset_pagination_covers_all(db, user_a):
    """offset+sort=name 翻页：任意大目录都能确定性拉全，且页间不漏不重。"""
    folder = await _mk(db, Folder(user_id=user_a.id, name="大目录"))
    names = ["a", "b", "c", "d", "e"]
    for name in names:
        await _mk(db, File(
            user_id=user_a.id, display_name=name, ext="md",
            folder_id=folder.id, storage_key=f"k-{name}",
        ))
    seen: list[str] = []
    offset = 0
    while True:
        page = await _list_dir(db, user_a.id, {
            "folder": folder.id, "kind": "file", "sort": "name",
            "limit": 2, "offset": offset,
        })
        seen.extend(item["name"].rsplit(".", 1)[0] for item in page["files"])
        if offset + page["shown"] >= page["total"]:
            break
        offset += page["shown"]
    assert seen == names
    assert page["total"] == 5

async def test_list_dir_accepts_folder_name_without_integer_sql_error(db, user_a):
    target = await _mk(db, Folder(user_id=user_a.id, name="咕咕开发"))
    inside = await _mk(db, File(
        user_id=user_a.id, display_name="方案", ext="md",
        folder_id=target.id, storage_key="inside",
    ))

    result = await _list_dir(db, user_a.id, {"folder": "咕咕开发", "space": "personal"})

    assert [item["id"] for item in result["files"]] == [inside.id]


async def test_list_dir_resolves_slash_path(db, user_a):
    """「/个人文件/参考素材/方案」式路径：逐级解析到叶子目录再列举。"""
    root = await _mk(db, Folder(user_id=user_a.id, name="参考素材"))
    child = await _mk(db, Folder(user_id=user_a.id, parent_id=root.id, name="方案"))
    inside = await _mk(db, File(
        user_id=user_a.id, display_name="草稿", ext="md",
        folder_id=child.id, storage_key="draft",
    ))
    sibling_file = await _mk(db, File(
        user_id=user_a.id, display_name="直属于参考素材", ext="md",
        folder_id=root.id, storage_key="direct",
    ))

    result = await _list_dir(db, user_a.id, {"folder": "/个人文件/参考素材/方案"})

    assert [item["id"] for item in result["files"]] == [inside.id]

    # 两级路径：列 root 本身，应含直属文件与子文件夹（带 file_count）
    root_view = await _list_dir(db, user_a.id, {"folder": "个人文件/参考素材"})
    assert [item["id"] for item in root_view["files"]] == [sibling_file.id]
    assert [item["name"] for item in root_view["folders"]] == ["方案"]
    assert root_view["folders"][0]["file_count"] == 1

    # 未知路径：报错带同层可用目录，模型可自我纠正
    miss = json.loads(await _list_dir(db, user_a.id, {"folder": "个人文件/参考素材/不存在"}))
    assert "路径解析失败" in miss["error"]
    assert miss["available_folders"] == ["方案"]


async def test_list_dir_path_ambiguous_segment_reports_candidates(db, user_a):
    root = await _mk(db, Folder(user_id=user_a.id, name="素材"))
    await _mk(db, Folder(user_id=user_a.id, parent_id=root.id, name="图"))
    await _mk(db, Folder(user_id=user_a.id, parent_id=root.id, name="图"))

    miss = json.loads(await _list_dir(db, user_a.id, {"folder": "素材/图"}))
    assert "多个同名文件夹" in miss["error"]
    assert len(miss["candidates"]) == 2


async def test_list_dir_path_first_segment_resolves_from_root_only(db, user_a):
    """路径第一级只认根目录（P2 边界）：嵌套同名目录不参与第一级解析。

    素材/（根）下有 方案/，同时 其他/素材/ 嵌套同名——「素材/方案」的路径语义
    已明确从根出发，应直达根「素材」的「方案」，而不是误报「多个同名文件夹」。
    """
    root = await _mk(db, Folder(user_id=user_a.id, name="素材"))
    plan = await _mk(db, Folder(user_id=user_a.id, parent_id=root.id, name="方案"))
    inside = await _mk(db, File(
        user_id=user_a.id, display_name="路线图", ext="md",
        folder_id=plan.id, storage_key="plan",
    ))
    other = await _mk(db, Folder(user_id=user_a.id, name="其他"))
    await _mk(db, Folder(user_id=user_a.id, parent_id=other.id, name="素材"))

    result = await _list_dir(db, user_a.id, {"folder": "素材/方案"})

    assert [item["id"] for item in result["files"]] == [inside.id]


async def test_list_dir_does_not_inherit_bound_workspace_directory(db, user_a, monkeypatch):
    workspace = await _mk(db, WorkspaceDirectory(
        user_id=user_a.id, name="F1 工作区", directory_name="f1-list",
    ))
    personal_folder = await _mk(db, Folder(user_id=user_a.id, name="影视"))
    personal_file = await _mk(db, File(
        user_id=user_a.id, display_name="已看", ext="md",
        folder_id=personal_folder.id, storage_key="personal-watched",
    ))
    await _mk(db, File(
        user_id=user_a.id, display_name="工作区记录", ext="md", space="workspace",
        workspace_directory_id=workspace.id, storage_key="workspace-note",
    ))

    import agent.tools.files.documents as file_documents

    async def bound_workspace(*_args, **_kwargs):
        return {
            "space": "workspace",
            "project_id": None,
            "folder_id": None,
            "workspace_directory_id": workspace.id,
        }

    monkeypatch.setattr(file_documents, "_bound_workspace_target", bound_workspace)

    result = await _list_dir(db, user_a.id, {"queries": ["已看"]})

    assert [item["id"] for item in result["files"]] == [personal_file.id]


async def test_resolve_target_cross_user_folder(db, user_a, user_b):
    fo = await _mk(db, Folder(user_id=user_b.id, name="B的文件夹"))
    space, pid, fid, workspace_directory_id, err = await _resolve_target(
        db, user_a.id, {"folder_id": fo.id}
    )
    assert err is not None and "error" in err


# ── projects ──────────────────────────────────────────────────────────────────

async def test_project_resolve_cross_user(db, user_a, user_b):
    p = await _mk(db, Project(user_id=user_b.id, name="B的项目"))
    got, err = await _resolve_project(db, user_a.id, {"project_id": p.id})
    assert got is None and _is_err(err)


async def test_project_resolve_owner_ok(db, user_b):
    p = await _mk(db, Project(user_id=user_b.id, name="我的项目"))
    got, err = await _resolve_project(db, user_b.id, {"project_id": p.id})
    assert err is None and got.id == p.id


async def test_project_update_tool_persists_name(db, user_a):
    project = await _mk(db, Project(user_id=user_a.id, name="原项目", stages_json="[]"))

    result = await _update_project(db, user_a.id, {"project_id": project.id, "name": "新项目"})

    assert result["success"] is True
    await db.refresh(project)
    assert project.name == "新项目"


# ── calendar ──────────────────────────────────────────────────────────────────

async def test_event_resolve_cross_user(db, user_a, user_b):
    e = await _mk(db, CalendarEvent(user_id=user_b.id, title="B的活动", date="2026-07-02"))
    got, err = await _resolve_event(db, user_a.id, {"event_id": e.id})
    assert got is None and _is_err(err)


async def test_event_resolve_owner_ok(db, user_b):
    e = await _mk(db, CalendarEvent(user_id=user_b.id, title="我的活动", date="2026-07-02"))
    got, err = await _resolve_event(db, user_b.id, {"event_id": e.id})
    assert err is None and got.id == e.id


async def test_remove_event_reminder_cross_user(db, user_a, user_b):
    t = await _mk(db, ScheduledTask(user_id=user_b.id, event_id=1, name="B的提醒", cron="0 9 * * *"))
    res = await _remove_event_reminder(db, user_a.id, {"reminder_id": t.id})
    assert _is_err(res)
    assert await db.get(ScheduledTask, t.id) is not None   # B 的提醒必须还在


# ── clients ───────────────────────────────────────────────────────────────────

async def test_client_resolve_cross_user(db, user_a, user_b):
    c = await _mk(db, Client(user_id=user_b.id, name="B的客户"))
    got, err = await _resolve_client(db, user_a.id, {"client_id": c.id})
    assert got is None and _is_err(err)


async def test_client_resolve_owner_ok(db, user_b):
    c = await _mk(db, Client(user_id=user_b.id, name="我的客户"))
    got, err = await _resolve_client(db, user_b.id, {"client_id": c.id})
    assert err is None and got.id == c.id


# ── scheduled_tasks ───────────────────────────────────────────────────────────

async def test_task_resolve_cross_user(db, user_a, user_b):
    t = await _mk(db, ScheduledTask(user_id=user_b.id, name="B的任务", cron="0 9 * * *"))
    got, err = await _resolve_task(db, user_a.id, {"task_id": t.id})
    assert got is None and _is_err(err)


async def test_task_resolve_owner_ok(db, user_b):
    t = await _mk(db, ScheduledTask(user_id=user_b.id, name="我的任务", cron="0 9 * * *"))
    got, err = await _resolve_task(db, user_b.id, {"task_id": t.id})
    assert err is None and got.id == t.id


# ── conversations ─────────────────────────────────────────────────────────────

async def test_read_conversation_cross_user(db, user_a, user_b):
    s = await _mk(db, ConversationSession(user_id=user_b.id, title="B的私聊"))
    await _mk(db, ConversationMessage(session_id=s.id, role="user", content="B的秘密"))
    res = await _read_conversation(db, user_a.id, {"session_id": s.id})
    assert _is_err(res)
    assert "B的秘密" not in str(res)   # 内容一个字都不能漏


async def test_read_conversation_owner_ok(db, user_b):
    s = await _mk(db, ConversationSession(user_id=user_b.id, title="我的对话"))
    await _mk(db, ConversationMessage(session_id=s.id, role="user", content="hello"))
    res = await _read_conversation(db, user_b.id, {"session_id": s.id})
    assert not _is_err(res)


# ── trash ─────────────────────────────────────────────────────────────────────

async def test_restore_cross_user(db, user_a, user_b):
    from datetime import datetime
    f = await _mk(db, File(user_id=user_b.id, display_name="del", ext="md",
                           storage_key="k", deleted_at=now_utc()))
    res = await _restore_file(db, user_a.id, {"file_id": f.id})
    assert _is_err(res)
    await db.refresh(f)
    assert f.deleted_at is not None   # B 的文件必须还在回收站，没被 A 动过


async def test_permanent_delete_cross_user(db, user_a, user_b):
    from datetime import datetime
    f = await _mk(db, File(user_id=user_b.id, display_name="del", ext="md",
                           storage_key="k", deleted_at=now_utc()))
    res = await _permanent_delete(db, user_a.id, {"file_id": f.id, "confirm": True})
    assert _is_err(res)
    assert await db.get(File, f.id) is not None   # 即便带了 confirm 也删不掉别人的


async def test_permanent_delete_folder_uses_folder_id_and_removes_folder(db, user_a):
    folder = await _mk(db, Folder(
        user_id=user_a.id, name="待清理目录", deleted_at=now_utc()))

    blocked = await _permanent_delete(db, user_a.id, {"folder_id": folder.id})
    payload = json.loads(blocked)
    assert payload.get("needs_confirm") is True

    from agent.interactions import confirmations
    confirmations.redeem_confirmation(user_a.id, payload["confirm_code"])

    result = await _permanent_delete(db, user_a.id, {"folder_id": folder.id})
    assert result["success"] is True
    assert result["deleted_folder_id"] == folder.id
    assert await db.get(Folder, folder.id) is None


async def test_resolve_key_supports_workspace_folder(db, user_a):
    """rename 等 key 解析必须支持 workspace：文件夹校验带 directory id，
    key 前缀带 directory_name——之前漏传导致 workspace 文件一改名就报
    「目标文件夹不存在，或不属于指定的项目/个人空间」。"""
    directory = await _mk(db, WorkspaceDirectory(user_id=user_a.id, name="测试工作区", directory_name="workspace-1"))
    folder = await _mk(db, Folder(user_id=user_a.id, workspace_directory_id=directory.id, name="脚本"))
    key = await _resolve_key(
        db, user_a.id, "workspace", "天气周报v1", "py",
        folder_id=folder.id, workspace_directory_id=directory.id,
    )
    assert key == f"{user_a.id}/workspace-1/脚本/天气周报v1.py"


async def test_resolve_key_rejects_workspace_folder_with_wrong_directory(db, user_a):
    directory = await _mk(db, WorkspaceDirectory(user_id=user_a.id, name="测试工作区", directory_name="workspace-1"))
    folder = await _mk(db, Folder(user_id=user_a.id, workspace_directory_id=directory.id, name="脚本"))
    import pytest
    with pytest.raises(ValueError):
        await _resolve_key(
            db, user_a.id, "workspace", "天气周报v1", "py",
            folder_id=folder.id, workspace_directory_id=None,
        )


async def test_rename_one_rejects_binary_to_text_format_change(db, user_a, monkeypatch):
    """图片等二进制后缀（不在 _DOC_MIME）不允许借 rename 变成 .py 等文本格式——
    改后缀不重写内容，只会产出内容对不上的坏文件。"""
    from app.models import File as FileModel
    from agent.tools.files import documents

    f = await _mk(db, FileModel(user_id=user_a.id, display_name="weather_week_南京_2026-09-10",
                                ext="png", mime_type="image/png", storage_key="k"))
    monkeypatch.setattr(documents, "get_storage", lambda: types.SimpleNamespace(rename_file=None))
    r = await documents._rename_one(db, user_a.id, f, "天气周报v1", "py")
    assert r.get("error") and "跨文本/二进制" in r["error"]
