"""Shell Phase 0-2：工作区归属、会话绑定和默认关闭行为。"""

import pytest

from app.core.config import AgentBehaviorSettings
from app.models import ConversationSession, Project
from app.services.workspaces import bind_session, create_workspace, describe_session


@pytest.mark.asyncio
async def test_shell_is_disabled_by_default():
    assert AgentBehaviorSettings().shell_enabled is False


@pytest.mark.asyncio
async def test_workspace_binding_is_owned_and_can_be_cleared(db, user_a, user_b):
    project = Project(user_id=user_a.id, name="测试项目")
    db.add(project)
    await db.flush()
    workspace = await create_workspace(
        db, user_a.id, name="项目工作区", kind="project", project_id=project.id,
    )
    session = ConversationSession(user_id=user_a.id, title="测试会话", source="web")
    db.add(session)
    await db.flush()

    with pytest.raises(LookupError):
        await bind_session(db, user_b.id, session.id, workspace.id)

    await bind_session(db, user_a.id, session.id, workspace.id)
    await db.commit()
    assert (await describe_session(db, user_a.id, session.id)).id == workspace.id

    await bind_session(db, user_a.id, session.id, None)
    await db.commit()
    assert await describe_session(db, user_a.id, session.id) is None
