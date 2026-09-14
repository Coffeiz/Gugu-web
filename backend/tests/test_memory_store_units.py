"""agent/memory/store.py 单元补测：CAS 写入、迁移链、向量缓存同步、注入切块。

配合 CRAP 治理 P1（覆盖盲区批量补测）：只测纯逻辑与 StorageBackend 打桩路径，
不碰真实 DB / embedding 服务（embedding 一律模块级打桩）。
"""
import json
from types import SimpleNamespace

import pytest

from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    s = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.memory.store.get_storage", lambda: s)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: s)
    return s


UID = "unit-user"


def _pattern(pid: str, text: str, *, kind="observed", conf=0.9, imp=3, ts=100.0):
    return {"id": pid, "text": text, "kind": kind, "conf": conf, "imp": imp, "ts": ts}


def _fake_embedding(monkeypatch, *, vectors=None, tag="t"):
    """打桩 agent.memory.embedding 的模块级函数；embed 按调用序返回 vectors（缺省 [1.0]）。"""
    from agent.memory import embedding as emb

    calls = {"embed": 0}
    seq = list(vectors or [])

    async def fake_embed(_text):
        calls["embed"] += 1
        return seq.pop(0) if seq else [1.0]

    monkeypatch.setattr(emb, "is_enabled", lambda: True)
    monkeypatch.setattr(emb, "model_tag", lambda: tag)
    monkeypatch.setattr(emb, "embed", fake_embed)
    return calls


# ── retrieve_memory_block（纯函数）────────────────────────────────────────

def test_retrieve_memory_block_within_budget_returns_whole():
    from agent.memory import store

    assert store.retrieve_memory_block("短记忆", None, None, budget=100) == "短记忆"


def test_retrieve_memory_block_over_budget_without_vectors_truncates_head():
    from agent.memory import store

    text = "x" * 50
    assert store.retrieve_memory_block(text, None, None, budget=10) == "x" * 10
    assert store.retrieve_memory_block(text, [1.0], {}, budget=10) == "x" * 10


def test_retrieve_memory_block_low_vector_coverage_falls_back_to_head():
    from agent.memory import store

    text = "## 记录长期记忆：A\n内容甲\n\n## 记录长期记忆：B\n内容乙"
    # 两个块只有 0 个有向量 → 覆盖不足，退回开头预算内容而不是乱挑
    out = store.retrieve_memory_block(text, [1.0], {}, budget=8)
    assert out == text[:8].rstrip()


def test_retrieve_memory_block_picks_relevant_chunk_and_keeps_budget():
    from agent.memory import store

    text = "## 记录长期记忆：天气\n聊到下雨\n\n## 记录长期记忆：猫\n聊到橘猫吃饭"
    chunks = store._memory_chunks(text)
    vec_map = {store._chunk_key(c): [1.0] for c in chunks}
    vec_map[store._chunk_key(chunks[1])] = [0.0]   # 「猫」块与 query 正交，只有天气块相关
    out = store.retrieve_memory_block(text, [1.0], vec_map, budget=12)
    assert "天气" in out
    assert "猫" not in out
    assert len(out) <= 12


def test_retrieve_memory_block_first_chunk_truncated_to_hard_budget():
    from agent.memory import store

    text = "y" * 30
    vec_map = {store._chunk_key(text): [1.0]}
    assert store.retrieve_memory_block(text, [1.0], vec_map, budget=10) == "y" * 10


def test_split_memory_block_sentence_and_hard_split():
    from agent.memory import store

    # 短段落原样保留
    assert store._split_memory_block("第一段\n\n第二段", limit=20) == ["第一段", "第二段"]
    # 长段落按句子边界拆
    para = "句子甲内容哦。句子乙内容哦。" * 2
    out = store._split_memory_block(para, limit=10)
    assert all(len(c) <= 10 for c in out)
    assert "".join(out).replace(" ", "") == para
    # 无句边界的超长单句硬切
    hard = "z" * 25
    assert store._split_memory_block(hard, limit=10) == ["z" * 10, "z" * 10, "z" * 5]


# ── stance / summary / misread ────────────────────────────────────────────

async def test_read_write_stance_roundtrip_and_bad_payloads(storage):
    from agent.memory import store

    assert await store.read_stance(UID) == (None, None)          # 文件不存在
    await store.write_stance(UID, "")                             # 空 stance 不写
    assert await store.read_stance(UID) == (None, None)

    await store.write_stance(UID, "闲聊")
    stance, ts = await store.read_stance(UID)
    assert stance == "闲聊" and isinstance(ts, float)

    await storage.put(f"{UID}/.agent/stance.json", b'{"stance": "", "ts": 1.5}')
    assert await store.read_stance(UID) == (None, 1.5)            # 空 stance 仍有 ts

    await storage.put(f"{UID}/.agent/stance.json", b'{"stance": "x", "ts": null}')
    assert await store.read_stance(UID) == ("x", None)

    await storage.put(f"{UID}/.agent/stance.json", b"not json{")
    assert await store.read_stance(UID) == (None, None)


async def test_read_summary_doc_migrates_legacy_md_and_ts(storage):
    from agent.memory import store

    # 无任何文件 → 空状态
    assert await store._read_summary_doc(UID) == {"text": "", "ts": None}

    # 旧 summary.md + summary.ts → 一次性迁移并写回 summary.json
    await storage.put(f"{UID}/.agent/summary.md", "在写代码".encode())
    await storage.put(f"{UID}/.agent/summary.ts", b"123.5")
    doc = await store._read_summary_doc(UID)
    assert doc == {"text": "在写代码", "ts": 123.5}
    migrated = json.loads((await storage.get(f"{UID}/.agent/summary.json")).decode())
    assert migrated == {"text": "在写代码", "ts": 123.5}
    # 迁移后直接命中新文件（旧文件内容变化不再回读）
    await storage.put(f"{UID}/.agent/summary.md", "别的".encode())
    assert (await store._read_summary_doc(UID))["text"] == "在写代码"

    # 非法 ts 字符串 → None
    await storage.put(f"{UID}/.agent/summary.json", b"")  # 空文件走迁移分支但不覆盖（text 空）
    await storage.delete(f"{UID}/.agent/summary.json")
    await storage.put(f"{UID}/.agent/summary.ts", b"abc")
    await storage.delete(f"{UID}/.agent/summary.json")
    assert (await store._read_summary_doc(UID))["ts"] is None

    # summary.json 坏 JSON → 落回旧文件迁移
    await storage.put(f"{UID}/.agent/summary.json", b"{bad json")
    await storage.put(f"{UID}/.agent/summary.md", "正文".encode())
    assert (await store._read_summary_doc(UID))["text"] == "正文"

    # 合法 summary.json 短路返回
    await storage.put(f"{UID}/.agent/summary.json", json.dumps({"text": "新", "ts": 9}).encode())
    assert await store.read_summary(UID) == "新"


async def test_append_misread_prepends_caps_and_never_raises(storage, monkeypatch):
    from agent.memory import store

    await store.append_misread("   ")            # 空条目 no-op
    await store.append_misread("第一条")
    await store.append_misread("第二条")
    text = await store.read_misread()
    assert text.startswith("第二条")
    assert "第一条" in text

    monkeypatch.setattr(store, "_MISREAD_MD_CAP", 2)
    await store.append_misread("第三条")
    text = await store.read_misread()
    assert "第三条" in text and "第一条" not in text   # 超上限裁最老

    # 存储异常被吞掉，不影响调用方
    class BoomStorage:
        async def get(self, _key):
            raise RuntimeError("boom")

        async def put(self, *_a, **_k):
            raise RuntimeError("boom")

        async def exists(self, _key):
            raise RuntimeError("boom")

    monkeypatch.setattr("agent.memory.store.get_storage", lambda: BoomStorage())
    await store.append_misread("第四条")          # 不抛


# ── CAS 写入（pattern / profile）──────────────────────────────────────────

async def test_write_pattern_list_if_unchanged_cas_semantics(storage):
    from agent.memory import store

    current = [_pattern("a", "旧模式")]
    await store.write_pattern_list(UID, current)
    good_digest = store.pattern_list_digest(current)

    assert await store.write_pattern_list_if_unchanged(UID, good_digest, [_pattern("b", "新模式")]) is True
    texts = [p["text"] for p in await store.read_pattern_list(UID)]
    assert texts == ["新模式"]

    # 快照过期 → 拒写
    stale = store.pattern_list_digest([_pattern("zzz", "过期快照")])
    assert await store.write_pattern_list_if_unchanged(UID, stale, []) is False
    assert [p["text"] for p in await store.read_pattern_list(UID)] == ["新模式"]

    # 现文件坏 JSON → 拒写
    await storage.put(f"{UID}/.agent/pattern.json", b"{broken")
    assert await store.write_pattern_list_if_unchanged(UID, good_digest, []) is False


async def test_write_profile_list_if_unchanged_cas_semantics(storage):
    from agent.memory import store

    await store.write_profile_list(UID, [{"type": "name", "text": "小北", "ts": 1.0}])
    digest = store.profile_list_digest([{"type": "name", "text": "小北", "ts": 1.0}])

    # 命中：新列表里的字符串条目按 note 兼容归一
    assert await store.write_profile_list_if_unchanged(UID, digest, ["喜欢猫"]) is True
    items = await store.read_profile_list(UID)
    assert items == [{"type": "note", "text": "喜欢猫", "ts": None}]

    stale = store.profile_list_digest([{"type": "name", "text": "过期", "ts": 2.0}])
    assert await store.write_profile_list_if_unchanged(UID, stale, []) is False
    assert (await store.read_profile_list(UID))[0]["text"] == "喜欢猫"

    await storage.put(f"{UID}/.agent/profile.json", b"[not json")
    assert await store.write_profile_list_if_unchanged(UID, digest, []) is False


# ── 向量缓存读取与同步 ─────────────────────────────────────────────────────

async def test_read_pattern_and_memory_vecs_bad_payloads(storage):
    from agent.memory import store

    assert await store.read_pattern_vecs(UID) == {}
    assert await store.read_memory_vecs(UID) == {}
    await storage.put(f"{UID}/.agent/pattern_vec.json", b"[1,2]")
    await storage.put(f"{UID}/.agent/memory_vec.json", b"{oops")
    assert await store.read_pattern_vecs(UID) == {}      # 非 dict → {}
    assert await store.read_memory_vecs(UID) == {}       # 坏 JSON → {}


async def test_sync_pattern_vecs_incremental_gc_force_and_strict(storage, monkeypatch):
    from agent.memory import store

    assert await store.sync_pattern_vecs(UID, []) == 0   # embedding 未启用 → no-op

    calls = _fake_embedding(monkeypatch)
    patterns = [_pattern("p1", "模式一"), _pattern("p2", "模式二")]
    # 预置：p1 已有当前 tag 向量（跳过）、p2 缺（补）、dead 是已删模式（GC）
    await store.write_pattern_vecs(UID, {
        "p1": {"v": [0.5], "t": "t"},
        "dead": {"v": [0.1], "t": "t"},
    })
    written = await store.sync_pattern_vecs(UID, patterns)
    assert written == 1
    assert calls["embed"] == 1
    vecs = await store.read_pattern_vecs(UID)
    assert set(vecs) == {"p1", "p2"}
    assert vecs["p1"]["v"] == [0.5]                      # 未动的保留旧向量

    # force → 全部重算
    calls["embed"] = 0
    written = await store.sync_pattern_vecs(UID, patterns, force=True)
    assert written == 2 and calls["embed"] == 2

    # embed 返回 None：普通路径 best-effort 不计失败；strict 抛 RuntimeError
    monkeypatch.setattr("agent.memory.embedding.embed", _null_embed)
    assert await store.sync_pattern_vecs(UID, [_pattern("p3", "新模式")]) == 0
    with pytest.raises(RuntimeError):
        await store.sync_pattern_vecs(UID, [_pattern("p4", "严格模式")], strict=True)

    # embed 直接抛异常：非 strict 吞掉返 0，strict 原样抛
    async def boom(_text):
        raise ValueError("embedding down")

    monkeypatch.setattr("agent.memory.embedding.embed", boom)
    assert await store.sync_pattern_vecs(UID, patterns) == 0
    with pytest.raises(ValueError):
        await store.sync_pattern_vecs(UID, patterns, strict=True)


async def _null_embed(_text):
    return None


async def test_sync_memory_vecs_chunk_gc_and_force(storage, monkeypatch):
    from agent.memory import store

    calls = _fake_embedding(monkeypatch)
    memory_text = "段落甲的内容\n\n段落乙的内容"
    chunks = store._memory_chunks(memory_text)
    assert len(chunks) == 2
    stale_key = "deadbeef0000"
    await store.write_memory_vecs(UID, {
        chunks[0] and store._chunk_key(chunks[0]): {"v": [0.3], "t": "t"},
        stale_key: {"v": [0.1], "t": "t"},
    })
    written = await store.sync_memory_vecs(UID, memory_text)
    assert written == 1                                  # 只有段落乙需要补
    vecs = await store.read_memory_vecs(UID)
    assert set(vecs) == {store._chunk_key(c) for c in chunks}   # 消失块被 GC

    calls["embed"] = 0
    assert await store.sync_memory_vecs(UID, memory_text, force=True) == 2
    assert calls["embed"] == 2

    monkeypatch.setattr("agent.memory.embedding.embed", _null_embed)
    with pytest.raises(RuntimeError):
        await store.sync_memory_vecs(UID, "全新内容", strict=True)


# ── read_pattern_list：空文件规范化 + 迁移链尾部 ──────────────────────────

async def test_read_pattern_list_normalizes_empty_file_and_clears_orphan_vectors(storage):
    from agent.memory import store

    await storage.put(f"{UID}/.agent/pattern.json", b"")
    await storage.put(f"{UID}/.agent/pattern_vec.json", b'{"orphan": {"v": [1.0], "t": "t"}}')

    assert await store.read_pattern_list(UID) == []
    assert (await storage.get(f"{UID}/.agent/pattern.json")).decode() == "[]"
    assert (await storage.get(f"{UID}/.agent/pattern_vec.json")).decode() == "{}"


async def test_read_pattern_list_falls_through_corrupt_facts_json_to_md(storage):
    from agent.memory import store

    await storage.put(f"{UID}/.agent/facts.json", b"{broken")
    await storage.put(f"{UID}/.agent/facts.md", "- 旧模式甲\n- 旧模式乙".encode())

    patterns = await store.read_pattern_list(UID)
    assert [p["text"] for p in patterns] == ["旧模式甲", "旧模式乙"]
    assert all(p["kind"] == "observed" and p["conf"] == 0.75 for p in patterns)
    # 迁移结果落到 pattern.json，下次直接命中
    assert [p["text"] for p in await store.read_pattern_list(UID)] == ["旧模式甲", "旧模式乙"]


async def test_read_pattern_list_filters_items_without_text(storage):
    from agent.memory import store

    await storage.put(f"{UID}/.agent/pattern.json", json.dumps([
        _pattern("a", "有效"),
        {"id": "b", "text": "  "},
        "not-a-dict",
    ]).encode())
    assert [p["text"] for p in await store.read_pattern_list(UID)] == ["有效"]


# ── read_memory 聚合（含向量分支）─────────────────────────────────────────

async def test_read_memory_returns_all_sections_without_vector_path(storage, monkeypatch):
    from agent.memory import store

    async def fake_lens(_uid):
        return "镜片段落"

    monkeypatch.setattr("agent.memory.lens.read_block", fake_lens)
    await store.write_profile_list(UID, [{"type": "name", "text": "小北", "ts": 1.0}])
    await store.write_pattern_list(UID, [_pattern("p1", "喜欢猫", ts=100.0),
                                         _pattern("p2", "夜猫子", kind="inferred", ts=50.0)])
    await store.write_memory_doc(UID, "长期记忆正文")
    await store.write_summary(UID, "在写代码")
    await store.write_stance(UID, "闲聊")
    await store.append_daily(UID, "2026-09-14", "今天聊了猫")

    result = await store.read_memory(UID)                # 无 query → 不走向量
    assert result["profile"] == "- 小北"
    assert "喜欢猫" in result["pattern"]
    assert result["memory"] == "长期记忆正文"
    assert "今天聊了猫" in result["daily"]
    assert result["summary"] == "在写代码" and isinstance(result["summary_ts"], float)
    assert result["stance"] == "闲聊" and isinstance(result["stance_ts"], float)
    assert result["first_ts"] == 50.0                    # 最早 pattern 的时间锚点
    assert result["lens"] == "镜片段落"


async def test_read_memory_vector_branch_embeds_query_once(storage, monkeypatch):
    from agent.memory import store

    calls = _fake_embedding(monkeypatch)
    monkeypatch.setattr(store, "PATTERN_INJECT_MAX", 1)   # 2 条 pattern → 超上限

    async def fake_lens(_uid):
        return ""

    monkeypatch.setattr("agent.memory.lens.read_block", fake_lens)
    patterns = [_pattern("p1", "喜欢猫"), _pattern("p2", "夜猫子")]
    await store.write_pattern_list(UID, patterns)
    await store.write_pattern_vecs(UID, {"p1": {"v": [1.0], "t": "t"}})
    # 长期记忆超过 MEMORY_INJECT_CHARS(2000) 预算 → 触发按向量挑块
    #（retrieve_memory_block 的 budget 是 def 时绑定的默认值，不能靠 patch 常量缩小）
    memory_text = "甲" * 1100 + "\n\n" + "乙" * 1100
    await store.write_memory_doc(UID, memory_text)
    await store.write_memory_vecs(UID, {
        store._chunk_key(c): {"v": [1.0], "t": "t"} for c in store._memory_chunks(memory_text)
    })

    result = await store.read_memory(UID, query="猫")
    assert calls["embed"] == 1                            # query 只 embed 一次、两边共用
    assert "喜欢猫" in result["pattern"] and "夜猫子" in result["pattern"]  # 重要度保底全保
    # 向量挑块生效：注入按预算截断而不是整篇（整篇 2202 字）
    assert len(result["memory"]) <= 2000 < len(memory_text)
