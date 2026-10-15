"""静态 system prompt 组装时必须包含用户确认语义。"""

from agent.context.session_system import build_static_prompt
from agent.context.session_system import _skills_index_block


def test_static_prompt_preserves_short_affirmation_as_immediate_consent():
    """简短肯定应被组装进实际发给模型的稳定提示词，防止组装链路漏掉策略。"""
    prompt = build_static_prompt("prompt-name-that-does-not-exist", "测试用户", skills=[])

    assert "简短肯定 = 同意并立即执行" in prompt
    assert "现在就做" in prompt
    assert "回头再说" in prompt


def test_static_prompt_encourages_independent_calls_without_bypassing_guards():
    """模型应同轮提出互不依赖的调用，同时保留权限和确认门约束。"""
    prompt = build_static_prompt("prompt-name-that-does-not-exist", "测试用户", skills=[])

    assert "彼此独立、无需前一个结果" in prompt
    assert "同一轮提出这些调用" in prompt
    assert "依赖前置结果" in prompt
    assert "权限和确认要求" in prompt


def test_skill_ids_are_internal_and_user_facing_mentions_use_names():
    """提示词明确区分工具内部 ID 与用户可见技能名，防止把编号当名称回复。"""
    block = _skills_index_block(None)

    assert "Skill ID（S/U 编号）仅用于内部工具调用和上下文管理" in block
    assert "对用户提及技能时一律使用技能名称" in block
