"""在 devserver 真实索引 chunk 上生成 Rust lexical 核心基准输入。"""
from __future__ import annotations

import asyncio
import statistics
import subprocess
import time
from pathlib import Path

from sqlalchemy import func, select

from agent.rag.tokenizer import tokenize
from agent.rag.models import IndexDocument, Scope
from app.db.session import get_db
from app.models import KnowledgeIndexEntry


ROOT = Path(__file__).resolve().parent
RUST_SOURCE = ROOT / "rust_bm25_bench.rs"
CORPUS = Path("/tmp/gugu-rag-bm25-corpus.tsv")
QUERIES = Path("/tmp/gugu-rag-bm25-queries.txt")
RUST_BINARY = Path("/tmp/gugu-rag-bm25-bench")
QUERY_TEXTS = ["项目计划", "文件资料", "会议记录", "设计方案", "工作安排"]


async def load_documents() -> list[IndexDocument]:
    async for db in get_db():
        owner = (
            await db.execute(
                select(KnowledgeIndexEntry.owner_user_id)
                .where(KnowledgeIndexEntry.deleted_at.is_(None))
                .group_by(KnowledgeIndexEntry.owner_user_id)
                .order_by(func.count(KnowledgeIndexEntry.id).desc())
                .limit(1)
            )
        ).scalar_one()
        rows = (
            await db.execute(
                select(KnowledgeIndexEntry)
                .where(
                    KnowledgeIndexEntry.owner_user_id == owner,
                    KnowledgeIndexEntry.deleted_at.is_(None),
                )
                .order_by(KnowledgeIndexEntry.id)
            )
        ).scalars().all()
        return [
            IndexDocument(
                document_id=row.document_id,
                source_type=row.source_type,
                source_id=row.source_id,
                scope=Scope(owner_user_id=str(owner)),
                title=row.title or "",
                summary=row.summary or "",
                content=row.content or "",
                version=row.document_version or "",
                chunk_index=row.chunk_index,
                chunk_count=row.chunk_count,
            )
            for row in rows
        ]
    return []


def write_pretokenized_inputs(documents: list[IndexDocument]) -> None:
    with CORPUS.open("w", encoding="utf-8") as corpus:
        for index, document in enumerate(documents):
            text = f"{document.title}\n{document.summary}\n{document.content}"
            corpus.write(f"{index}\t{' '.join(tokenize(text))}\n")
    with QUERIES.open("w", encoding="utf-8") as queries:
        for query in QUERY_TEXTS:
            queries.write(f"{' '.join(tokenize(query))}\n")


def percentile(values: list[float], fraction: float) -> float:
    values = sorted(values)
    return values[round((len(values) - 1) * fraction)]


async def main() -> None:
    documents = await load_documents()
    write_pretokenized_inputs(documents)
    subprocess.run(["rustc", "-O", str(RUST_SOURCE), "-o", str(RUST_BINARY)], check=True)
    subprocess.run([str(RUST_BINARY), str(CORPUS), str(QUERIES)], check=True)


if __name__ == "__main__":
    asyncio.run(main())
