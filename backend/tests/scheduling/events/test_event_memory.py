from agent.memory.event_memory import (
    EVENT_HEADING_PREFIX,
    deduplicate_event_sections,
    event_hash,
    merge_event_memory,
    normalize_event_memory,
    parse_event_sections,
)
from app.services.storage import LocalStorageBackend
import pytest


def test_normalize_event_memory_adds_event_prefix_to_headings():
    text = "## 图片搜索优化\n\n2026-08-24 用户确认结果只用于排序。"

    normalized = normalize_event_memory(text)

    assert normalized.startswith(f"## {EVENT_HEADING_PREFIX}图片搜索优化")
    sections = parse_event_sections(normalized)
    assert len(sections) == 1
    assert "结果只用于排序" in sections[0].body


def test_normalize_legacy_plain_memory_keeps_content_in_event_section():
    normalized = normalize_event_memory("2026-08-23 用户确认保留缓存前缀。")

    assert normalized.startswith(f"## {EVENT_HEADING_PREFIX}2026-08-23")
    assert "保留缓存前缀" in normalized


def test_event_hash_is_stable_for_same_title_and_body():
    assert event_hash("事件 A", "事实") == event_hash("事件 A", "事实")
    assert event_hash("事件 A", "事实") != event_hash("事件 A", "另一事实")


def test_deduplicate_event_sections_merges_same_event_and_drops_exact_duplicate():
    text = (
        "## 记录长期记忆：工具优化\n\n2026-08-20 完成压缩。\n\n"
        "## 记录长期记忆：工具优化\n\n2026-08-20 完成压缩。\n2026-08-21 补充测试。"
    )

    result = deduplicate_event_sections(text)

    assert result.count("## 记录长期记忆：工具优化") == 1
    assert result.count("2026-08-20 完成压缩") == 1
    assert "2026-08-21 补充测试" in result


def test_merge_event_memory_keeps_existing_sections_and_deduplicates_increment():
    result = merge_event_memory(
        "## 记录长期记忆：旧事件\n\n已确认方案。",
        "2026-08-24 成员确认负责测试。",
        fallback_title="成员事件",
    )
    assert "旧事件" in result
    assert "成员事件" in result
    assert result.count("已确认方案") == 1


def test_memory_chunks_keep_event_context_when_long_section_is_split():
    from agent.memory import store

    section = (
        "## 记录长期记忆：长事件\n\n"
        "- 时间：2026-08-20 至 2026-09-02\n"
        "- 类型：项目工作\n"
        "- 状态：进行中\n\n"
        "### 事件经过\n" + "过程记录。" * 180 + "\n\n"
        "### 未解决与后续\n" + "仍需继续处理。" * 80
    )

    chunks = store._memory_chunks(section)

    assert len(chunks) > 1
    assert all(len(chunk) <= store.MEMORY_CHUNK_MAX for chunk in chunks)
    assert all("## 记录长期记忆：长事件" in chunk for chunk in chunks)
    assert all("- 时间：2026-08-20 至 2026-09-02" in chunk for chunk in chunks)
    assert any("### 未解决与后续" in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_memory_vectors_reuse_unchanged_chunks_and_gc_removed_chunks(tmp_path, monkeypatch):
    from agent.memory import embedding, store

    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr(store, "get_storage", lambda: storage)
    monkeypatch.setattr(embedding, "is_enabled", lambda: True)
    monkeypatch.setattr(embedding, "model_tag", lambda: "test-model")
    calls = []

    async def fake_embed(text):
        calls.append(text)
        return [float(len(text))]

    monkeypatch.setattr(embedding, "embed", fake_embed)
    first = "## 记录长期记忆：A\n2026-08-20 事件 A。\n\n## 记录长期记忆：B\n2026-08-21 事件 B。"
    second = "## 记录长期记忆：A\n2026-08-20 事件 A。\n\n## 记录长期记忆：C\n2026-08-22 事件 C。"

    await store.sync_memory_vecs("u1", first)
    first_calls = list(calls)
    await store.sync_memory_vecs("u1", second)

    assert len(first_calls) == 2
    assert len(calls) == 3
    vecs = await store.read_memory_vecs("u1")
    assert len(vecs) == 2
    assert all(item["t"] == "test-model" for item in vecs.values())


@pytest.mark.asyncio
async def test_bailian_multimodal_embedding_uses_text_content(monkeypatch):
    from types import SimpleNamespace
    from agent.memory import embedding

    settings = SimpleNamespace(embedding=SimpleNamespace(
        enabled=True,
        provider="bailian",
        model="tongyi-embedding-vision-flash",
        base_url="https://example.invalid",
        dimensions=0,
        api_key="",
        multimodal=True,
    ))
    calls = []

    async def fake_multimodal(contents, *, enable_fusion=True):
        calls.append((contents, enable_fusion))
        return [0.1, 0.2]

    monkeypatch.setattr(embedding, "get_settings", lambda: settings)
    monkeypatch.setattr(embedding, "embed_multimodal", fake_multimodal)

    result = await embedding.embed("测试文本")

    assert result == [0.1, 0.2]
    assert calls == [([{"text": "测试文本"}], False)]
