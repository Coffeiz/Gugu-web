"""create_file 显式 workspace 空间与工具名污染兜底回归。

真实故障链：MiniMax 偶发把 XML 参数片段拼进工具名（未知工具），随后按
run_script 的词汇把 create_file 的 space 传成 workspace 又被 schema enum 拒掉，
绕到 personal 再被绑定守卫拒，模型据此误判「环境死锁」。
"""
import json

import pytest

from agent.tools.base import SkillRegistry, Tool
from agent.tools.files import _resolve_create_location
from app.models import ConversationSession, WorkspaceDirectory
from app.services.workspaces import create_workspace
from agent.tools.base import reset_dispatch_session, set_dispatch_session


async def _bind_directory_workspace(db, user_a, name="兜底工作区"):
    directory = WorkspaceDirectory(
        user_id=user_a.id, name=name, directory_name=f"workspace-{user_a.id.hex}")
    db.add(directory)
    await db.flush()
    workspace = await create_workspace(
        db, user_a.id, name=name, kind="directory", directory_id=directory.id)
    session = ConversationSession(user_id=user_a.id, title=name, source="web")
    session.workspace_id = workspace.id
    db.add(session)
    await db.flush()
    return directory, session


@pytest.mark.asyncio
async def test_create_location_explicit_workspace_uses_bound_directory(db, user_a):
    """绑定工作区会话里显式 space=workspace：落点必须带绑定目录 id，等价于省略目标。"""
    directory, session = await _bind_directory_workspace(db, user_a)
    token = set_dispatch_session(session.id, session, "test-explicit-workspace")
    try:
        space, project_id, folder_id, ws_dir_id, err = await _resolve_create_location(
            db, user_a.id, {"space": "workspace"})
        await db.commit()
    finally:
        reset_dispatch_session(token)
    assert err is None
    assert (space, project_id, folder_id) == ("workspace", None, None)
    assert ws_dir_id == directory.id


@pytest.mark.asyncio
async def test_create_location_explicit_workspace_without_binding_errors(db, user_a):
    """未绑定会话显式 space=workspace：给可行动的错误，而不是落到 service 层报「Workspace 不存在」。"""
    space, project_id, folder_id, ws_dir_id, err = await _resolve_create_location(
        db, user_a.id, {"space": "workspace"})
    assert err is not None
    assert "space=workspace 需要会话绑定工作区" in err


def test_create_file_schema_enum_accepts_workspace():
    """schema enum 与业务能力一致：space=workspace 不再被 schema 挡在业务层之前。"""
    from agent.tools import registry
    schemas = registry.openai_schemas(["create_file"])
    assert schemas, "create_file 必须在注册表里"
    schema = schemas[0]["function"]["parameters"] if "function" in schemas[0] else schemas[0]
    raw = json.dumps(schema)
    assert '"workspace"' in raw.split("create_file", 1)[-1]


@pytest.mark.asyncio
async def test_dispatch_salvages_polluted_tool_name():
    """工具名被 XML 片段污染时按前缀精确命中注册表，正常执行；真未知工具仍报错。"""
    reg = SkillRegistry()
    captured = {}

    async def handler(db, user_id, args):
        captured["args"] = args
        return {"ok": True}

    reg.add(Tool(
        name="create_file", description="test", label="创建文件",
        input_schema={"type": "object", "properties": {}, "additionalProperties": True},
        handler=handler,
    ))
    polluted = 'create_file"><target><space>personal</space></target>'
    result, _artifact = await reg.dispatch("user-1", polluted, {"content": "x"})
    assert json.loads(result).get("ok") is True
    assert captured["args"] == {"content": "x"}

    unknown, _ = await reg.dispatch("user-1", "totally_unknown_tool", {})
    assert "未知工具" in unknown
