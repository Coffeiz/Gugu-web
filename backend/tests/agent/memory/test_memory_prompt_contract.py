"""保护 owner 日常经历从对话反思到长期记忆沉淀的提示词契约。"""

from agent.memory import memory_compress, reflection


def test_reflection_prompt_keeps_confirmed_daily_life_facts_and_distinguishes_plans():
    prompt = reflection._load_sys()

    assert "用户的生活经历和工作进展同样值得考虑" in prompt
    assert "不要求它必须特别、强烈或带有明显情绪" in prompt
    assert "计划、建议、候选选项与实际发生的结果" in prompt
    assert "助手的建议、搜索结果和用户提问本身都不能证明用户实际做过" in prompt


def test_compaction_prompt_preserves_recall_worthy_daily_outcomes():
    prompt = memory_compress._load_sys()

    assert "必须重大、罕见或情绪强烈" in prompt
    assert "只要未来可能有回顾价值，也可以沉淀" in prompt
    assert "同一事件后来有明确结果时，记录结果" in prompt
    assert "计划、他人建议、搜索到的选项不等于用户实际采取" in prompt
