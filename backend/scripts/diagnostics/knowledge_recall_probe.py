#!/usr/bin/env python3
"""Knowledge 召回场景探针。

使用临时 Markdown 存储构造脱敏 mock 数据，调用真实 KnowledgeAdapter，覆盖：
事实、流程、术语、重复、冲突、无命中和 scope 隔离。输出只包含标题、来源类型、
可信度、分数和召回诊断，不输出知识正文。

运行：
    cd backend
    PYTHONPATH=. .venv/bin/python scripts/diagnostics/knowledge_recall_probe.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
import time
from pathlib import Path

from app.services.storage import LocalStorageBackend
from agent.knowledge.models import KnowledgeEntry, KnowledgeScope, KnowledgeSource
from agent.knowledge.store import KnowledgeStore
from agent.rag.adapters.knowledge import KnowledgeAdapter
from agent.rag.models import RecallCandidate, Scope
from agent.rag.scoring import filter_confidence


USER_ID = "mock-user"
GROUP_SCOPE = Scope(
    owner_user_id=USER_ID, platform="mock", bot_id="mock-bot",
    group_id="group-1", scope_type="group", scope_id="group-1",
)
OWNER_SCOPE = Scope(owner_user_id=USER_ID, scope_type="owner")


def mock_entries() -> list[KnowledgeEntry]:
    def entry(title: str, topic: str, content: str, source: str = "user",
              confidence: str = "confirmed", scope: KnowledgeScope | None = None):
        return KnowledgeEntry.create(
            title=title, topic=topic, content=content,
            scope=scope or KnowledgeScope(owner_user_id=USER_ID),
            source=KnowledgeSource(source, label=f"mock-{source}"),
            confidence=confidence,  # type: ignore[arg-type]
        )

    owner = KnowledgeScope(owner_user_id=USER_ID)
    group = KnowledgeScope(
        owner_user_id=USER_ID, type="group", platform="mock",
        bot_id="mock-bot", group_id="group-1", scope_id="group-1",
    )
    return [
        entry("Runtime 版本锁定规则", "Runtime 接入",
              "Gugu-web 接入 Runtime 时，业务仓库必须锁定经过验证的 Runtime commit，避免本地 checkout 与 CI 依赖版本不一致。"),
        entry("配置消费链排查流程", "配置排查",
              "当配置值已经确认传入但行为仍不一致时，优先沿配置定义和消费链检查各生命周期阶段是否实际读取该配置；若配置没有传入，先检查上游组装。", confidence="probable"),
        entry("Knowledge RAG 作用", "知识系统",
              "Knowledge RAG 是被动上下文检索，用于补充项目私有规则和流程，不代表 Agent 拥有可主动执行的 Skill。"),
        entry("词法召回缓存", "RAG 性能",
              "词法召回应复用现有索引缓存和 TTL，不应在业务侧为同一用户维护第二套预热生命周期。", source="derived", confidence="probable"),
        entry("词法召回缓存（外部资料）", "RAG 性能",
              "词法索引每次查询都应重新构建索引，避免缓存导致结果过期。", source="web", confidence="conflict"),
        entry("群聊测试规则", "群聊约定",
              "Mock 群聊中的测试知识只允许在当前群 scope 内召回。", scope=group),
        entry("无关知识", "天气",
              "这是一个与配置和 RAG 无关的 mock 天气事实。", scope=owner),
    ]


SCENARIOS = (
    ("事实召回", OWNER_SCOPE, "Runtime commit CI 版本锁定"),
    ("流程召回", OWNER_SCOPE, "配置传入后如何排查消费链"),
    ("术语召回", OWNER_SCOPE, "Knowledge RAG 是不是 Skill"),
    ("语义重复", OWNER_SCOPE, "Runtime 接入时如何锁定版本"),
    ("冲突主题", OWNER_SCOPE, "RAG 召回缓存和 TTL"),
    ("无命中", OWNER_SCOPE, "数据库迁移颜色主题"),
    ("群 scope 隔离", GROUP_SCOPE, "群聊测试规则"),
)


async def seed(store: KnowledgeStore) -> None:
    for item in mock_entries():
        await store.save(item)


def result_view(result) -> dict:
    document = result.document
    score = getattr(result, "score", getattr(result, "confidence", 0.0))
    return {
        "title": document.title,
        "topic": document.metadata.get("topic", ""),
        "source_type": document.metadata.get("source_type", ""),
        "confidence": document.metadata.get("confidence", ""),
        "score": round(float(score), 6),
    }


def quality_view(query: str, results, top_k: int) -> tuple[list[dict], dict]:
    candidates = [
        RecallCandidate.from_result(item, rank=index)
        for index, item in enumerate(results, start=1)
    ]
    accepted, stats = filter_confidence(query, candidates, limit=top_k)
    return [result_view(item) for item in accepted], stats


async def run_probe(top_k: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="gugu-knowledge-probe-") as directory:
        import agent.knowledge.store as store_module

        storage = LocalStorageBackend(Path(directory))
        store_module.get_storage = lambda: storage
        store = KnowledgeStore(USER_ID)
        await seed(store)
        adapter = KnowledgeAdapter(USER_ID)
        output = []
        for label, scope, query in SCENARIOS:
            started = time.perf_counter()
            batch = await adapter.retrieve(
                query, scope=scope, strategy="bm25", candidate_limit=top_k,
            )
            engine = str(batch.metadata.get("engine") or "typescript")
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            accepted, quality = quality_view(query, batch.results, top_k)
            output.append({
                "scenario": label,
                "query": query,
                "scope": scope.scope_type,
                "elapsed_ms": elapsed_ms,
                "candidate_count": batch.candidate_count,
                "fallback_reason": batch.fallback_reason,
                "engine": batch.metadata.get("engine", engine),
                "metadata": batch.metadata,
                "results": [result_view(item) for item in batch.results[:top_k]],
                "accepted_results": accepted,
                "quality": quality,
            })
        return {
            "engine": "knowledge-adapter",
            "mock_entry_count": len(await store.list()),
            "scenario_count": len(output),
            "scenarios": output,
        }


async def main() -> None:
    parser = argparse.ArgumentParser(description="运行 Knowledge mock 召回场景")
    parser.add_argument("--top-k", type=int, choices=range(1, 11), default=5)
    args = parser.parse_args()
    print(json.dumps(await run_probe(args.top_k), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
