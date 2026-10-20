"""当前对话内撤销咕咕最近一次可撤销操作。"""
from app.services.undo.agent import undo_latest_agent_action
from agent.tools.base import BaseSkill, Tool, current_dispatch_session_id


async def _undo_last_action(db, user_id, _args: dict):
    return await undo_latest_agent_action(
        db, user_id=user_id, session_id=current_dispatch_session_id(),
    )


class UndoSkill(BaseSkill):
    name = "undo"
    tools = [
        Tool(
            name="undo_last_action",
            label="撤销咕咕操作",
            description_short="撤销咕咕在当前对话最近一次可撤销的删除。",
            description=(
                "撤销当前对话中咕咕最近一次可撤销的项目、日历、文件或文件夹删除。"
                "只影响当前对话里由咕咕执行并记录的删除，不会撤销网页或其他对话的修改；"
                "若目标已被后续操作修改，会安全拒绝撤销。无需参数。"
            ),
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            handler=_undo_last_action,
            mutates=True,
        ),
    ]


UndoSkill().register()
