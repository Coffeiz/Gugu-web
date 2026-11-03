"""跨 TS worker 与迁移期 Python projection 的来源文档契约差分。"""
from __future__ import annotations

import json
import math
import subprocess
import tempfile
from pathlib import Path

from agent.rag.cython_backend import CythonRagEngine
from agent.rag.cython_projection import (
    adapt_source_records,
    project_source_batch,
    project_source_records_from_wire,
)
from agent.rag.delta import chunk_slot_key


_TS_RUNNER = r"""
import { readFileSync } from 'node:fs';
import { buildSourceDocuments } from './backend/ts/workers/rag/src/index-builder.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(buildSourceDocuments(input)));
"""


def _python_documents(batch):
    owner = "projection-owner"
    wire_batch = json.loads(json.dumps(batch, ensure_ascii=False))
    for records in wire_batch.values():
        for record in records:
            record["scope"] = record.pop("_scope")
    output = []
    for document in project_source_batch(owner, wire_batch):
        text_parts = [document.title]
        if document.summary and not document.content.strip().startswith(document.summary):
            text_parts.append(document.summary)
        text_parts.append(document.content)
        wire = {
            "id": chunk_slot_key(document), "text": "\n".join(text_parts),
            "source_type": document.source_type, "source_id": document.source_id,
            "content": document.content, "title": document.title,
            "summary": document.summary, "platform": document.scope.platform,
            "bot_id": document.scope.bot_id, "group_id": document.scope.group_id,
            "scope_type": document.scope.scope_type, "scope_id": document.scope.scope_id,
            "document_version": document.version, "parent_id": document.parent_document_id,
            "chunk_index": document.chunk_index, "chunk_count": document.chunk_count,
            "updated_at": document.updated_at, "metadata": document.metadata,
        }
        if document.source_type == "conversation":
            wire["ranking_text"] = str(document.metadata.get("context_current") or document.content)
            if document.metadata.get("kind") == "message":
                context = document.contextual_content()
                if context:
                    wire["context_text"] = context
        wire = {
            key: value for key, value in wire.items()
            if value is not None and not (key == "metadata" and value == {})
        }
        output.append(wire)
    return output


def test_python_source_projection_matches_ts_worker_for_all_supported_source_families() -> None:
    scope = {"platform": "qq", "bot_id": "bot-1", "group_id": "", "scope_type": "owner", "scope_id": ""}
    batch = {
        "memory": [
            {"id": "m1", "source_type": "memory", "title": "记忆", "content": "记忆正文" * 120,
             "version_parts": ["m1", 7], "metadata": {"confidence": "confirmed"}, "_scope": scope},
            # journal 是 RagSourceType，但 TS builder 将它作为 generic record 携带在 memory batch，
            # 而不是独立的 RagSourceBatch 槽；保持该历史 wire 路径可检索。
            {"id": "j1", "source_type": "journal", "title": "日志", "content": "日志记录",
             "version_parts": ["j1", 2], "_scope": scope},
        ],
        "project": [{"id": "p1", "source_type": "project", "title": "项目", "content": "项目说明。" * 3,
                     "source_id": "source-p1", "parent_id": "parent-p1", "summary": "真实摘要",
                     "version_parts": ["p1", "rev"], "_scope": scope}],
        "note": [{"id": "n1", "title": "便签标题", "content_plain": "便签正文", "content_md": "ignored",
                  "kind": "note", "version_parts": ["n1", 3], "_scope": scope}],
        "canvas": [{"id": "c1", "canvas_id": "canvas-1", "canvas_title": "画布", "node_id": "node-1",
                    "node_title": "节点", "node_type": "text", "content": "节点正文", "group_path": "A/B",
                    "relation_summary": "关联节点", "project_id": 9, "version_parts": ["c1", "rev"],
                    "_scope": scope}],
        "calendar": [{"id": "e1", "title": "活动", "date": "2026-10-30", "time": "14:00",
                      "description": "安排", "project_id": 9, "version_parts": ["e1", 2], "_scope": scope}],
        "scheduled_task": [{"id": "t1", "name": "巡检", "cron": "0 9 * * *", "enabled": True,
                             "payload": "检查状态", "version_parts": ["t1", "rev"], "_scope": scope}],
        "conversations": [{"id": "msg-1", "kind": "message", "session_id": "s1", "role": "user",
                           "content": "当前消息正文。" * 200, "context_before": "前文", "context_after": "后文",
                           "session_source": "qq", "session_updated_at": "2026-10-30T00:00:00Z",
                           "version_parts": ["msg-1", "time", "body"], "_scope": scope}],
        "knowledge": [{"id": "k1", "source_type": "knowledge", "title": "知识", "content": "知识正文",
                       "summary": "知识描述", "version_parts": ["k1", 4], "metadata": {"confidence": "probable"},
                       "_scope": scope}],
    }
    ts_batch = json.loads(json.dumps(batch))
    for records in ts_batch.values():
        for record in records:
            record["scope"] = record.pop("_scope")

    completed = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", _TS_RUNNER],
        input=json.dumps(ts_batch, ensure_ascii=False), text=True, capture_output=True,
        check=True, cwd=Path(__file__).parents[4],
    )
    actual = json.loads(completed.stdout)
    expected = _python_documents(batch)
    owner = "projection-owner"
    wire_batch = json.loads(json.dumps(batch, ensure_ascii=False))
    for records in wire_batch.values():
        for record in records:
            record["scope"] = record.pop("_scope")
    adapted = []
    for batch_key, source_type in (
        ("memory", "memory"), ("project", "project"), ("note", "note"),
        ("canvas", "canvas"), ("calendar", "calendar"),
        ("scheduled_task", "scheduled_task"), ("conversations", "conversation"),
        ("knowledge", "knowledge"),
    ):
        adapted.extend(project_source_records_from_wire(owner, source_type, wire_batch[batch_key]))
    assert project_source_batch(owner, wire_batch) == adapted
    assert len(actual) == len(expected)
    for index, (ts_document, python_document) in enumerate(zip(actual, expected)):
        assert ts_document.keys() == python_document.keys(), (
            f"document[{index}] keys: TS-only={set(ts_document) - set(python_document)}, "
            f"Python-only={set(python_document) - set(ts_document)}"
        )
        for key in ts_document:
            assert ts_document[key] == python_document[key], f"document[{index}].{key}"


def test_adapt_operation_matches_ts_file_unknown_and_supported_source_contracts() -> None:
    """适配协议保持 file 拒绝、未知来源空成功及已知来源投影三种结果。"""
    cases = [
        ("file", [{"id": "f1"}]),
        ("future-source", [{"id": "x1"}]),
        ("journal", [{"id": "j1", "source_type": "journal", "title": "记录",
                      "content": "正文", "version_parts": ["j1", 1],
                      "scope": {"platform": "", "bot_id": "", "group_id": "",
                                "scope_type": "owner", "scope_id": "owner-fixture"}}]),
        ("memory", [{"id": "m1", "source_type": "memory", "title": "缓存策略",
                      "content": "保留最近修改", "version_parts": ["m1", 1],
                      "scope": {"platform": "", "bot_id": "", "group_id": "",
                                "scope_type": "owner", "scope_id": "owner-fixture"}}]),
    ]
    for source_type, records in cases:
        request = {"op": "adapt", "source_type": source_type, "records": records}
        with tempfile.TemporaryDirectory() as index_dir:
            completed = subprocess.run(
                ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
                input=json.dumps(request, ensure_ascii=False) + "\n",
                text=True, capture_output=True, check=True,
                cwd=Path(__file__).parents[4], timeout=30,
            )
        expected = json.loads(completed.stdout.strip().splitlines()[-1])
        actual = adapt_source_records("owner-fixture", source_type, records)
        assert actual == expected, source_type


def test_sparse_and_rejected_source_records_match_ts_projection_boundaries() -> None:
    """来源字段缺省/空正文/缺关键键时，Python 与 TS 保持相同的接受和省略行为。"""
    scope = {"platform": "", "bot_id": "", "group_id": "", "scope_type": "owner", "scope_id": ""}
    batch = {
        "memory": [
            {"id": "m", "source_type": "memory", "title": "记忆", "content": "短正文", "_scope": scope},
            {"id": "empty", "source_type": "memory", "title": "空", "content": "  ", "_scope": scope},
            {"id": "bad", "source_type": "memory", "content": "缺标题", "_scope": scope},
        ],
        "project": [
            {"id": "p", "source_type": "project", "title": "项目", "content": "正文", "_scope": scope},
            {"id": "bad", "source_type": "project", "title": "", "content": "忽略", "_scope": scope},
        ],
        "note": [
            {"id": "n", "title": "", "content_plain": "", "content_md": "Markdown 正文", "_scope": scope},
            {"title": "缺 ID", "content_plain": "忽略", "_scope": scope},
        ],
        "canvas": [
            {"id": "c", "canvas_id": "c1", "node_id": "n1", "content": "节点正文", "_scope": scope},
            {"id": "bad", "node_id": "n2", "content": "缺 canvas_id", "_scope": scope},
        ],
        "calendar": [
            {"id": "e", "title": "", "date": "", "_scope": scope},
            {"id": "bad", "title": "缺日期", "_scope": scope},
        ],
        "scheduled_task": [
            {"id": "t", "name": "巡检", "cron": "", "enabled": False, "_scope": scope},
            {"id": "bad", "name": "缺 cron", "enabled": True, "_scope": scope},
        ],
        "conversations": [
            {"id": "s", "kind": "summary", "summary": "会话摘要", "_scope": scope},
            {"id": "empty", "kind": "message", "role": "user", "content": "  ", "_scope": scope},
            {"id": "bad", "kind": "message", "content": "缺 role", "_scope": scope},
        ],
        "knowledge": [
            {"id": "k", "source_type": "knowledge", "title": "知识", "content": "有效正文", "_scope": scope},
        ],
    }
    wire_batch = json.loads(json.dumps(batch, ensure_ascii=False))
    for records in wire_batch.values():
        for record in records:
            record["scope"] = record.pop("_scope")
    completed = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", _TS_RUNNER],
        input=json.dumps(wire_batch, ensure_ascii=False), text=True, capture_output=True,
        check=True, cwd=Path(__file__).parents[4],
    )
    actual = json.loads(completed.stdout)
    expected = _python_documents(batch)
    assert len(actual) == len(expected)
    for index, (ts_document, python_document) in enumerate(zip(actual, expected)):
        # TS JSON transport omits undefined document_version；Python IndexDocument
        # 的正式 wire encoder 会把同一缺省值规范化为空串。
        ts_document.setdefault("document_version", "")
        assert ts_document.keys() == python_document.keys(), (
            f"sparse document[{index}] keys: TS-only={set(ts_document) - set(python_document)}, "
            f"Python-only={set(python_document) - set(ts_document)}"
        )
        for key in ts_document:
            assert ts_document[key] == python_document[key], f"sparse document[{index}].{key}"


def test_projected_source_batch_installs_and_searches_like_ts_build_and_index() -> None:
    """来源投影与索引安装组合后，lexical 查询仍与 TS worker 一致。"""
    owner = "projection-owner"
    scope = {"platform": "qq", "bot_id": "bot-1", "group_id": "",
             "scope_type": "owner", "scope_id": ""}
    batch = {
        "memory": [{"id": "m1", "source_type": "memory", "title": "缓存偏好",
                    "content": "偏好使用缓存策略 alpha 以降低重复计算。",
                    "version_parts": ["m1", 1], "scope": scope}],
        "project": [{"id": "p1", "source_type": "project", "title": "缓存项目计划",
                     "content": "缓存策略 alpha 用于项目索引构建。",
                     "version_parts": ["p1", 1], "scope": scope}],
    }
    revision = "projection-install-rev"
    query = "缓存策略 alpha"
    requests = [
        {"op": "build_and_index", "revision": revision, "batch": batch},
        {"op": "search", "revision": revision, "query": query,
         "source_types": ["memory", "project"], "limit": 10},
    ]
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(request, ensure_ascii=False) + "\n" for request in requests),
            text=True, capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    ts_responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert [response["status"] for response in ts_responses] == ["ok", "ok"]
    ts_search = ts_responses[-1]

    cython_docs = project_source_batch(owner, batch)
    engine = CythonRagEngine()
    engine.replace(cython_docs, revision)
    cython_results, diagnostics = engine.query(
        query, revision=revision, limit=10, source_types={"memory", "project"},
    )
    assert [(chunk_slot_key(result.document), result.document.source_type) for result in cython_results] == [
        (result["id"], result["source_type"]) for result in ts_search["results"]
    ]
    for actual, expected in zip(cython_results, ts_search["results"]):
        assert math.isclose(actual.score, expected["score"], rel_tol=0, abs_tol=1e-12)
    for name in ("candidate_count", "eligible_count", "filtered_count",
                 "source_filter_applied", "scope_filter_applied"):
        assert getattr(diagnostics, name) == ts_search["diagnostics"][name]
