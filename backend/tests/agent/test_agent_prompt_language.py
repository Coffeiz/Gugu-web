"""Agent 内部守卫的对外措辞约束。

真实性校验仍由循环逻辑负责；这里只防止内部对抗性术语渗入模型回复风格。
"""

from agent.core import _VERIFY_FORCE_PROMPT, _VERIFY_PROMPT
from agent.security.core_guards import _INTENT_NUDGE, _NARRATION_NUDGE


def test_operation_guards_use_neutral_internal_language():
    prompts = (_NARRATION_NUDGE, _INTENT_NUDGE, _VERIFY_PROMPT, _VERIFY_FORCE_PROMPT)
    combined = "\n".join(prompts)

    assert "嘴演" not in combined
    assert "假装操作" not in combined
    assert "真正的工具调用" not in combined
    assert "工具" in combined
    assert "回执" in combined or "查询" in combined


def test_verification_prompt_keeps_user_facing_output_boundary():
    assert "内部步骤" in _VERIFY_PROMPT or "内部核验" in _VERIFY_PROMPT
    assert "最终回复" in _VERIFY_PROMPT
    assert "固定口号" in _VERIFY_PROMPT
