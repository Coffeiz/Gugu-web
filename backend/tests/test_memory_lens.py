"""agent/memory/lens.py 单元补测（CRAP 治理 P1）。

覆盖：解读镜片的读取渲染（话术分档/退休过滤/条数上限）、observe 学习闸门、
候选复现提拔与规则印证、维护清理（陈旧候选/低效规则）。
storage 用 LocalStorageBackend 接线，时间衰减用真实 decay（last_seen 控制新旧）。
"""
import json
import time

import pytest

from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    s = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.memory.lens.get_storage", lambda: s)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: s)
    return s


UID = "lens-user"
NOW = time.time()


async def _seed(storage, rules=(), candidates=()):
    await storage.put(f"{UID}/.agent/lens.json", json.dumps(
        {"rules": list(rules), "candidates": list(candidates)}, ensure_ascii=False).encode())


# ── read_block：渲染与分档 ────────────────────────────────────────────────

async def test_read_block_empty_and_tiers(storage):
    from agent.memory import lens

    assert await lens.read_block(UID) == ""                       # 无文件 → 空串

    await _seed(storage, rules=[
        {"rule": "笃定规则", "confidence": 0.8, "last_seen": NOW},
        {"rule": "多半规则", "confidence": 0.5, "last_seen": NOW},
        {"rule": "也许规则", "confidence": 0.3, "last_seen": NOW},
        {"rule": "退休规则", "confidence": 0.2, "last_seen": NOW},   # eff < RETIRE_EFF 不注入
        {"rule": "  ", "confidence": 0.9, "last_seen": NOW},        # 空文本跳过
    ])
    block = await lens.read_block(UID)
    assert block.startswith("## 怎么读懂 TA")
    assert "- 笃定规则" in block
    assert "-（多半）多半规则" in block
    assert "-（也许，留意但别笃定）也许规则" in block
    assert "退休规则" not in block
    # 按 effective 降序：笃定在最前
    assert block.index("笃定规则") < block.index("多半规则") < block.index("也许规则")


async def test_read_block_caps_at_max_rules(storage):
    from agent.memory import lens

    rules = [{"rule": f"规则{i}", "confidence": 0.6, "last_seen": NOW} for i in range(15)]
    await _seed(storage, rules=rules)
    block = await lens.read_block(UID)
    assert block.count("\n-") == lens.MAX_RULES


# ── observe：学习闸门与永不抛 ─────────────────────────────────────────────

async def test_observe_candidate_promotion_and_confirm(storage):
    from agent.memory import lens

    hint = "「随便」其实有偏好，要追问具体想吃什么"
    await lens.observe(UID, hint)
    d = json.loads((await storage.get(f"{UID}/.agent/lens.json")).decode())
    assert len(d["candidates"]) == 1 and d["candidates"][0]["count"] == 1

    await lens.observe(UID, hint)                                  # 复现 → 提拔
    d = json.loads((await storage.get(f"{UID}/.agent/lens.json")).decode())
    assert d["candidates"] == [] and len(d["rules"]) == 1
    assert d["rules"][0]["confidence"] == lens.NEW_RULE_CONF and d["rules"][0]["hits"] == 1

    await lens.observe(UID, hint)                                  # 再命中 → 印证
    d = json.loads((await storage.get(f"{UID}/.agent/lens.json")).decode())
    assert d["rules"][0]["confidence"] == pytest.approx(lens.NEW_RULE_CONF + lens.CONFIRM_STEP)
    assert d["rules"][0]["hits"] == 2

    # 空 hint / 过短 hint 只做维护不新增
    await lens.observe(UID, None)
    await lens.observe(UID, "嗯")
    d = json.loads((await storage.get(f"{UID}/.agent/lens.json")).decode())
    assert len(d["rules"]) == 1 and d["candidates"] == []


async def test_observe_swallows_storage_failure(monkeypatch):
    from agent.memory import lens

    class Boom:
        async def get(self, _key):
            raise RuntimeError("down")

        async def put(self, *a, **k):
            raise RuntimeError("down")

    monkeypatch.setattr("agent.memory.lens.get_storage", lambda: Boom())
    await lens.observe(UID, "「还行」通常是不太行")                   # 不抛


# ── _ingest / _maintain：纯逻辑 ───────────────────────────────────────────

def test_ingest_promotion_prunes_rules_beyond_cap():
    from agent.memory import lens

    d = {"rules": [{"rule": f"旧规则{i}", "confidence": 0.3, "last_seen": NOW}
                   for i in range(lens.MAX_RULES)],
         "candidates": [{"rule": "候选规则", "count": lens.PROMOTE_AT - 1, "last_seen": NOW}]}
    assert lens._ingest(d, "候选规则") is True                      # 达阈值提拔
    assert len(d["rules"]) == lens.MAX_RULES                        # 超上限剪最低 eff
    assert d["candidates"] == []
    assert any(r["rule"] == "候选规则" for r in d["rules"])


def test_ingest_new_candidate_and_trigger_matching():
    from agent.memory import lens

    d = {"rules": [], "candidates": []}
    lens._ingest(d, "「没事」其实是有点事")
    assert len(d["candidates"]) == 1 and d["candidates"][0]["count"] == 1
    # 触发语相同（含跨引号格式）→ 视为同条，印证候选而不是新增
    lens._ingest(d, "『没事』其实是有事的意思")
    # count 1→2 达 PROMOTE_AT：同触发语复现即提拔成正式规则，候选清空
    assert d["candidates"] == [] and len(d["rules"]) == 1
    assert d["rules"][0]["rule"] == "「没事」其实是有点事"


def test_maintain_retires_and_sweeps_candidates():
    from agent.memory import lens

    stale_days = (lens.CAND_TTL_DAYS + 5) * 86400
    d = {
        "rules": [
            {"rule": "还有效", "confidence": 0.6, "last_seen": NOW},
            {"rule": "早衰减完", "confidence": 0.5, "last_seen": NOW - 400 * 86400},
        ],
        "candidates": [
            {"rule": "新鲜候选", "count": 1, "last_seen": NOW},
            {"rule": "陈旧候选", "count": 1, "last_seen": NOW - stale_days},
        ],
    }
    assert lens._maintain(d) is True
    assert [r["rule"] for r in d["rules"]] == ["还有效"]
    assert [c["rule"] for c in d["candidates"]] == ["新鲜候选"]

    assert lens._maintain({"rules": [], "candidates": []}) is False   # 无变动
