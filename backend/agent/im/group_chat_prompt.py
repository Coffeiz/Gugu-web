"""IM 群聊通用固定提示词。"""
from pathlib import Path


_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "im" / "group_chat.md"


def group_chat_system_prompt() -> str:
    """读取所有 IM 群聊 run 共用的通用提示词。"""
    return _PROMPT_PATH.read_text(encoding="utf-8").strip()
