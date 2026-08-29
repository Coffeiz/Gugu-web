"""验证动态上下文中的日期使用用户时区。"""
from datetime import datetime
from zoneinfo import ZoneInfo

from agent.context import builder
from agent.context.session_snapshot import date_boundary_note
from app.core.tz import LOCAL_TZ


def test_build_today_uses_user_tz():
    sh = ZoneInfo("Asia/Shanghai")
    _, dynamic, now_str = builder.build_split("default", "u", [], [], user_tz=sh)
    today = datetime.now(sh).strftime("%Y-%m-%d")
    assert today in now_str
    assert today not in dynamic


def test_build_default_falls_back_to_server_tz():
    _, dynamic, now_str = builder.build_split("default", "u", [], [])
    today = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    assert today in now_str
    assert today not in dynamic


def test_build_split_includes_default_profile_policy_in_static_prompt():
    static, dynamic, _ = builder.build_split("default", "u", [], [])
    assert "当前、最新、最近" in static
    assert "先用搜索核实" in static
    assert "当前、最新、最近" not in dynamic


def test_night_date_boundary_note_is_neutral():
    note = date_boundary_note(2)
    assert "日出前时段" in note
    assert "今天" in note and "明天" in note
    assert all(word not in note for word in ("未眠", "睡觉", "早点睡", "休息"))
    assert date_boundary_note(4) == ""


def test_files_block_is_personal_library_only():
    block = builder._files_block({
        "total": 20,
        "trash": 1,
        "folders": [{"name": "工作", "path": "工作", "file_count": 4}],
        "files": [{"name": "方案.md", "folder": "工作", "space": "personal"}],
    })
    assert "个人文件库共 20 个活跃文件" in block
    assert "一级目录：工作（文件数 4）" in block
    assert "最近文件" in block
    assert "各空间" not in block


def test_project_root_folder_is_rendered():
    class Folder:
        parent_id = None
        deleted_at = None
        name = "项目资料"

    class Project:
        folders = [Folder()]

    assert builder._project_root_folders(Project()) == "项目资料"


def test_recent_notes_are_rendered_as_snapshot_context():
    dynamic = builder.build_split(
        "default", "u", [], [], notes=[{
            "title": "今天的记录", "content": "完成了上下文整理",
            "captured_at": datetime(2026, 8, 22),
        }],
    )[1]
    assert "## 笔记" in dynamic
    assert "今天的记录" in dynamic
    assert "完成了上下文整理" in dynamic
    assert "画布便签" not in dynamic
