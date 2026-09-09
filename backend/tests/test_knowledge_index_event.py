"""自动反思落库 knowledge 后必须补发 RagIndexUpdated。

反思链路（agent/memory/reflection.py 的 _reflect_knowledge）不经 save_knowledge
工具，没人替它发索引事件时持久索引投影会缺行——主数据里存在的条目检索不到
（knowledge-4156d859 案例根因）。
"""
from agent import events
from agent.knowledge import reflection as knowledge_reflection
from agent.memory import reflection


async def test_publishes_index_event_when_entries_saved(monkeypatch):
    published = []
    monkeypatch.setattr(events, "publish", published.append)
    monkeypatch.setattr(knowledge_reflection, "candidate_request",
                        lambda out: (True, "整理一下"))
    saved_calls = []

    async def fake_reflect(*args, **kwargs):
        saved_calls.append(kwargs.get("save_mode"))
        return 2

    monkeypatch.setattr(knowledge_reflection, "reflect_if_candidate", fake_reflect)

    await reflection._reflect_knowledge(
        "user-1", "今天聊到项目排期了", "好的", object(), {"ops": []}, session_id="s1",
    )

    assert saved_calls == ["automatic"]
    assert len(published) == 1
    evt = published[0]
    assert evt.user_id == "user-1"
    assert evt.source_type == "knowledge"
    assert evt.operation == "upsert"


async def test_no_event_when_nothing_saved(monkeypatch):
    published = []
    monkeypatch.setattr(events, "publish", published.append)
    monkeypatch.setattr(knowledge_reflection, "candidate_request",
                        lambda out: (True, "整理一下"))

    async def fake_reflect(*args, **kwargs):
        return 0

    monkeypatch.setattr(knowledge_reflection, "reflect_if_candidate", fake_reflect)

    await reflection._reflect_knowledge(
        "user-1", "msg", "reply", object(), {}, session_id=None,
    )
    assert published == []


async def test_no_event_when_not_candidate(monkeypatch):
    published = []
    monkeypatch.setattr(events, "publish", published.append)
    monkeypatch.setattr(knowledge_reflection, "candidate_request",
                        lambda out: (False, ""))

    async def fail_reflect(*args, **kwargs):
        raise AssertionError("不应调用 reflect_if_candidate")

    monkeypatch.setattr(knowledge_reflection, "reflect_if_candidate", fail_reflect)

    await reflection._reflect_knowledge("user-1", "msg", "reply", object(), {})
    assert published == []


async def test_reflection_error_swallowed_without_event(monkeypatch):
    published = []
    monkeypatch.setattr(events, "publish", published.append)

    def boom(out):
        raise RuntimeError("llm 输出坏了")

    monkeypatch.setattr(knowledge_reflection, "candidate_request", boom)

    # 不应向上抛：knowledge 反思失败不能拖垮整轮 memory 反思。
    await reflection._reflect_knowledge("user-1", "msg", "reply", object(), {})
    assert published == []
