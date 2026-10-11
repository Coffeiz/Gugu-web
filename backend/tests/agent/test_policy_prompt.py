"""静态 system prompt 组装时必须包含用户确认语义。"""

from agent.context.session_system import build_static_prompt


def test_static_prompt_preserves_short_affirmation_as_immediate_consent():
    """简短肯定应被组装进实际发给模型的稳定提示词，防止组装链路漏掉策略。"""
    prompt = build_static_prompt("prompt-name-that-does-not-exist", "测试用户", skills=[])

    assert "简短肯定 = 同意并立即执行" in prompt
    assert "现在就做" in prompt
    assert "回头再说" in prompt
