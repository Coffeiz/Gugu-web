"""profile/pattern 记忆拆分（2026-07-08）的迁移与核心逻辑测试。

覆盖：
- read_facts_list 的迁移链（pattern.json → 旧 facts.json → 更旧的 facts.md → 空）
- daily.md 新格式读写与旧格式迁移
- profile 的增删（apply_profile_ops）
- pattern 的增删/印证（apply_facts_ops）
- refresh_memory 的多数票复核机制（本身就是今天真实踩过坑的地方，
  单次调用同一份数据删除比例能从 40% 跳到 94%，必须验证投票能收敛）
- refresh_memory 的 cleanup-legacy
"""
import json
from types import SimpleNamespace

import pytest

from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    s = LocalStorageBackend(tmp_path)
    # store.py 已经在模块里 `from ... import get_storage`；refresh_memory._cleanup_legacy
    # 则是函数内临时 `from app.services.storage import get_storage`（每次调用现查），
    # 两处都要打——只打 store.py 那处的话 _cleanup_legacy 会绕过 tmp_path、直接摸到真实存储。
    monkeypatch.setattr("agent.memory.store.get_storage", lambda: s)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: s)
    return s


UID = "test-user"


# ── read_facts_list 迁移链 ──────────────────────────────────────────────

async def test_read_facts_list_prefers_pattern_json(storage):
    from agent.memory import store
    await storage.put(f"{UID}/.agent/pattern.json",
                       json.dumps([{"id": "a1", "text": "新文件里的", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0}]).encode())
    await storage.put(f"{UID}/.agent/facts.json",
                       json.dumps([{"id": "b1", "text": "旧文件里的，不该被读到", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0}]).encode())
    facts = await store.read_facts_list(UID)
    assert len(facts) == 1
    assert facts[0]["text"] == "新文件里的"


async def test_read_facts_list_migrates_legacy_facts_json(storage):
    from agent.memory import store
    await storage.put(f"{UID}/.agent/facts.json",
                       json.dumps([{"id": "b1", "text": "旧 facts.json 内容", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0}]).encode())
    facts = await store.read_facts_list(UID)
    assert len(facts) == 1 and facts[0]["text"] == "旧 facts.json 内容"
    # 迁移是一次性的：内容应该已经落到新文件名，且没丢
    assert await storage.exists(f"{UID}/.agent/pattern.json")
    migrated = json.loads(await storage.get(f"{UID}/.agent/pattern.json"))
    assert migrated == [{"id": "b1", "text": "旧 facts.json 内容", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0}]
    # 旧文件原样保留，不删
    assert await storage.exists(f"{UID}/.agent/facts.json")


async def test_read_facts_list_migrates_ancient_facts_md(storage):
    from agent.memory import store
    await storage.put(f"{UID}/.agent/facts.md", "- 用户喜欢猫\n- 用户住南京\n".encode())
    facts = await store.read_facts_list(UID)
    texts = {f["text"] for f in facts}
    assert texts == {"用户喜欢猫", "用户住南京"}
    assert all(f["kind"] == "observed" for f in facts)   # _migrate_md 判不了 kind，一律 observed


async def test_read_facts_list_empty_when_nothing_exists(storage):
    from agent.memory import store
    assert await store.read_facts_list(UID) == []


# ── daily.md 新格式 / 迁移 ───────────────────────────────────────────────

async def test_read_daily_lines_reads_grouped_daily(storage):
    from agent.memory import store

    await storage.put(
        f"{UID}/.agent/daily.md",
        "## 2026-07-10\n- 第一条\n- 第二条\n\n## 2026-07-09\n- 更早一条\n".encode(),
    )

    lines = await store.read_daily_lines(UID)
    assert lines == [
        "- 2026-07-10 第一条",
        "- 2026-07-10 第二条",
        "- 2026-07-09 更早一条",
    ]


async def test_read_daily_lines_does_not_compat_legacy_daily(storage):
    from agent.memory import store

    await storage.put(
        f"{UID}/.agent/daily.md",
        "- 2026-07-10 老格式一条\n- 2026-07-09 老格式二条\n".encode(),
    )

    assert await store.read_daily_lines(UID) == []


async def test_migrate_legacy_daily_rewrites_grouped_format(storage):
    from agent.memory import store

    await storage.put(
        f"{UID}/.agent/daily.md",
        "- 2026-07-10 第一条\n- 2026-07-10 第二条\n- 2026-07-09 更早一条\n".encode(),
    )

    result = await store.migrate_legacy_daily(UID, dry_run=False)
    assert result["migrated"] == 3

    text = (await storage.get(f"{UID}/.agent/daily.md")).decode()
    assert text == "## 2026-07-10\n- 第一条\n- 第二条\n\n## 2026-07-09\n- 更早一条\n"


# ── profile 增删 ────────────────────────────────────────────────────────

async def test_apply_profile_ops_add_and_dedupe(storage):
    from agent.memory import store
    # 相似判定阈值刻意保守（_fact_similar：较短≥6字且是较长的子串，或 bigram Jaccard≥0.7），
    # 短句稍微改个说法就判不到同一条——这里选一对真的满足「短的是长的前缀子串」的例子。
    profile = store.apply_profile_ops([], ["用户是自由创作者"], [])
    assert len(profile) == 1
    profile2 = store.apply_profile_ops(profile, ["用户是自由创作者，从事插画和动画"], [])
    assert len(profile2) == 1
    assert "插画" in profile2[0]["text"]   # 采用更具体的文本
    # profile 没有 kind/conf 字段
    assert "kind" not in profile2[0] and "conf" not in profile2[0]


async def test_apply_profile_ops_remove(storage):
    from agent.memory import store
    profile = store.apply_profile_ops([], ["用户是自由创作者", "用户住南京"], [])
    # 删除同样受相似度阈值约束，传的字符串要跟原文足够接近才能匹配到
    profile = store.apply_profile_ops(profile, [], ["用户住南京"])
    assert len(profile) == 1
    assert profile[0]["text"] == "用户是自由创作者"


async def test_render_profile_no_relevance_filtering(storage):
    from agent.memory import store
    profile = [{"id": "1", "text": "条目一", "ts": 1.0}, {"id": "2", "text": "条目二", "ts": 2.0}]
    rendered = store.render_profile(profile)
    assert "条目一" in rendered and "条目二" in rendered   # 全量注入，不做衰减/退休/相关性挑选


def test_reflection_splits_temporal_profile_into_daily():
    from agent.memory import reflection

    profile_adds, staged = reflection._split_profile_adds([
        "用户最近刚换了新空调",
        "用户住南京",
        "用户目前在集中处理引用消息识别",
    ])

    assert profile_adds == ["用户住南京"]
    assert staged == ["用户最近刚换了新空调", "用户目前在集中处理引用消息识别"]
    assert reflection._merge_daily_note("本轮确认了微信引用能力边界", staged) == (
        "本轮确认了微信引用能力边界；用户最近刚换了新空调；用户目前在集中处理引用消息识别"
    )


# ── pattern 增删/印证 ───────────────────────────────────────────────────

async def test_apply_facts_ops_add_observed_and_inferred(storage):
    from agent.memory import store
    out = store.apply_facts_ops([], [
        {"text": "用户偏好先讨论再要清单", "kind": "observed", "importance": 4},
    ], [])
    assert len(out) == 1
    assert out[0]["kind"] == "observed"
    assert out[0]["conf"] == store._FACT_DEFAULT_CONF["observed"]


async def test_apply_facts_ops_reinforce_upgrades_kind(storage):
    from agent.memory import store
    out = store.apply_facts_ops([], [{"text": "用户可能喜欢简洁回复", "kind": "inferred", "importance": 3}], [])
    assert out[0]["kind"] == "inferred"
    conf_before = out[0]["conf"]
    # 用户亲述同一条 → 应该把 inferred 升级成 observed，且置信度上升
    out2 = store.apply_facts_ops(out, [{"text": "用户可能喜欢简洁回复", "kind": "observed", "importance": 3}], [])
    assert len(out2) == 1
    assert out2[0]["kind"] == "observed"
    assert out2[0]["conf"] > conf_before


async def test_apply_facts_ops_remove(storage):
    from agent.memory import store
    out = store.apply_facts_ops([], [
        {"text": "用户决定项目推迟到 8/31", "kind": "observed", "importance": 3},
        {"text": "用户喜欢简洁回复", "kind": "observed", "importance": 4},
    ], [])
    out = store.apply_facts_ops(out, [], ["用户决定项目推迟到 8/31"])
    assert len(out) == 1
    assert out[0]["text"] == "用户喜欢简洁回复"


# ── refresh_memory：多数票复核（今天真实踩过的坑：单次调用结果不稳定）──

async def test_review_facts_majority_vote_keeps_only_consensus(storage, monkeypatch):
    """3 次独立调用里，只有第 0 条被 3 次都判定删除；第 1 条只被判 1 次；模拟今天遇到的
    「单次调用不可信」场景——验证只有过半数的才会被真的删掉，单次的分歧会被保留。"""
    from agent.memory import store as mem_store
    import scripts.refresh_memory as rm

    facts = [
        {"id": "a", "text": "一次性的项目执行细节", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0},
        {"id": "b", "text": "有争议、只有一次被判删的条目", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0},
        {"id": "c", "text": "该保留的稳定模式", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0},
    ]
    await mem_store.write_facts_list(UID, facts)

    calls = {"n": 0}
    vote_sequences = [{0}, {0, 1}, {0}]   # 索引 0 三次全中；索引 1 只中一次；索引 2 从不中

    async def fake_complete_json(sys_prompt, user, settings, max_tokens=800, temperature=0.1):
        idx = calls["n"]
        calls["n"] += 1
        return {"remove": list(vote_sequences[idx])}

    monkeypatch.setattr("agent.memory._llm.complete_json", fake_complete_json)

    result = await rm._review_facts(UID, settings=object(), dry_run=False, trials=3, temperature=0.1)

    assert result["removed"] == 1                 # 只有索引 0 过半数（3/3）
    assert result["removed_texts"] == ["一次性的项目执行细节"]
    assert result["unstable"].get(1) == 1          # 索引 1 的单次分歧被记录、但没被删

    remaining = await mem_store.read_facts_list(UID)
    remaining_texts = {f["text"] for f in remaining}
    assert remaining_texts == {"有争议、只有一次被判删的条目", "该保留的稳定模式"}


async def test_review_facts_all_trials_fail_to_parse_skips_user(storage, monkeypatch):
    from agent.memory import store as mem_store
    import scripts.refresh_memory as rm

    await mem_store.write_facts_list(UID, [{"id": "a", "text": "x", "kind": "observed", "conf": 0.9, "imp": 3, "ts": 1.0}])

    async def fake_complete_json(*a, **kw):
        return {}   # 解析不出 remove 字段

    monkeypatch.setattr("agent.memory._llm.complete_json", fake_complete_json)

    result = await rm._review_facts(UID, settings=object(), dry_run=False, trials=3, temperature=0.1)
    assert result["removed"] == 0
    assert "error" in result
    # 没删任何东西
    assert len(await mem_store.read_facts_list(UID)) == 1


# ── refresh_memory：cleanup-legacy ──────────────────────────────────────

async def test_cleanup_legacy_removes_old_files_once_migrated(storage):
    import scripts.refresh_memory as rm

    await storage.put(f"{UID}/.agent/pattern.json", b"[]")
    await storage.put(f"{UID}/.agent/facts.json", b"[]")
    await storage.put(f"{UID}/.agent/facts.md", b"- old\n")
    await storage.put(f"{UID}/.agent/facts_vec.json", b"{}")   # 向量缓存改名前的旧文件，也该清

    result = await rm._cleanup_legacy(UID, settings=object(), dry_run=False)
    assert result["removed"] == 3
    assert not await storage.exists(f"{UID}/.agent/facts.json")
    assert not await storage.exists(f"{UID}/.agent/facts.md")
    assert not await storage.exists(f"{UID}/.agent/facts_vec.json")
    assert await storage.exists(f"{UID}/.agent/pattern.json")   # 新文件不受影响


async def test_cleanup_legacy_noop_before_migration(storage):
    import scripts.refresh_memory as rm

    await storage.put(f"{UID}/.agent/facts.json", b"[]")   # 还没迁移过，没有 pattern.json
    result = await rm._cleanup_legacy(UID, settings=object(), dry_run=False)
    assert result["removed"] == 0
    assert await storage.exists(f"{UID}/.agent/facts.json")   # 没动


async def test_cleanup_legacy_dry_run_does_not_delete(storage):
    import scripts.refresh_memory as rm

    await storage.put(f"{UID}/.agent/pattern.json", b"[]")
    await storage.put(f"{UID}/.agent/facts.json", b"[]")
    result = await rm._cleanup_legacy(UID, settings=object(), dry_run=True)
    assert result["removed"] == 1
    assert await storage.exists(f"{UID}/.agent/facts.json")   # dry-run 不应该真删


async def test_migrate_daily_reports_preview_lines(storage):
    import scripts.refresh_memory as rm

    await storage.put(
        f"{UID}/.agent/daily.md",
        "- 2026-07-10 第一条\n- 2026-07-09 第二条\n".encode(),
    )

    result = await rm._migrate_daily(UID, settings=object(), dry_run=True)
    assert result["migrated"] == 2
    assert result["migrated_texts"] == ["2026-07-10 第一条", "2026-07-09 第二条"]


async def test_migrate_profile_events_moves_temporal_profile_to_memory(storage):
    import scripts.refresh_memory as rm
    from agent.memory import store

    await store.write_profile_list(UID, [
        {"id": "p1", "text": "用户最近刚换了新空调", "ts": 1.0},
        {"id": "p2", "text": "用户住南京", "ts": 2.0},
    ])
    await store.write_memory_doc(UID, "## 既有长期记忆\n- 用户最近在折腾网关接入")

    result = await rm._migrate_profile_events(UID, settings=object(), dry_run=False)
    assert result["migrated"] == 1
    assert result["moved_texts"] == ["用户最近刚换了新空调"]
    assert result["memory_appended_texts"] == ["用户最近刚换了新空调"]

    profile = await store.read_profile_list(UID)
    assert [p["text"] for p in profile] == ["用户住南京"]
    memory = await store.read_memory_doc(UID)
    assert "## 画像迁移补记" in memory
    assert "- 用户最近刚换了新空调" in memory


async def test_migrate_profile_events_dedupes_existing_memory(storage):
    import scripts.refresh_memory as rm
    from agent.memory import store

    await store.write_profile_list(UID, [
        {"id": "p1", "text": "用户最近刚换了新空调", "ts": 1.0},
    ])
    await store.write_memory_doc(UID, "用户最近刚换了新空调")

    result = await rm._migrate_profile_events(UID, settings=object(), dry_run=False)
    assert result["migrated"] == 1
    assert result["memory_appended_texts"] == []
    assert await store.read_memory_doc(UID) == "用户最近刚换了新空调"


async def test_compress_includes_profile_and_pattern_context(storage, monkeypatch):
    from agent.memory import compress, store

    for i in range(store.DAILY_COMPACT_AT):
        date = "2026-07-10" if i < store.DAILY_KEEP_RECENT else "2026-07-09"
        await store.append_daily(UID, date, f"第{i}条")
    await store.write_profile_list(UID, [{"id": "p1", "text": "用户住南京", "ts": 1.0}])
    await store.write_facts_list(UID, [
        {"id": "f1", "text": "用户做决定前会先核实事实", "kind": "observed", "conf": 0.9, "imp": 4, "ts": 1.0},
    ])

    captured = {}

    async def fake_complete_json(sys_prompt, user, settings, max_tokens=1500, temperature=0.3):
        captured["user"] = user
        return {"memory": "保留事件背景，不复写稳定结论"}

    async def fake_sync_memory_vecs(user_id, memory_text, force=False):
        captured["synced"] = (user_id, memory_text, force)

    monkeypatch.setattr("agent.memory.compress.complete_json", fake_complete_json)
    monkeypatch.setattr("agent.memory.store.sync_memory_vecs", fake_sync_memory_vecs)

    ok = await compress.compact(UID, SimpleNamespace())
    assert ok is True
    assert "已结构化的用户画像" in captured["user"]
    assert "用户住南京" in captured["user"]
    assert "已结构化的行为模式" in captured["user"]
    assert "用户做决定前会先核实事实" in captured["user"]
    assert "别在长期记忆里原句复写" in captured["user"]
