"""写路径移交第一步：Python record 管线与 TS 适配器投影逐字段等价。

同一份来源记录分别走 Python ``record_documents``（经 ``_wire_document``）与真
worker 的 ``adapt`` op（TS 适配器 + ``buildDocuments``），两侧产出必须在 wire
域逐字段全等（含 document_version 的 sha256 计算、分块切分与头部方言）。这是
写路径移交 TS 的等价基线（PRD-RAG-7 Phase 4 遗留第一步）。
"""
from pathlib import Path

import pytest

from agent.rag.index_builder import (
    calendar_record,
    canvas_record,
    conversation_message_record,
    conversation_summary_record,
    file_record,
    note_record,
    record_documents,
    scheduled_task_record,
)
from agent.rag.models import Scope
from agent.rag.ts_sidecar import TsSidecarClient, _wire_document

OWNER = "projection-owner"
OWNER_SCOPE = Scope(OWNER)
GROUP_SCOPE = Scope(OWNER, platform="qq", bot_id="bot1", group_id="g1",
                    scope_type="group", scope_id="g1")
WIRE_SCOPE = {"scope_type": "owner", "scope_id": "",
              "platform": "", "bot_id": "", "group_id": ""}


def _worker_command() -> str:
    worker = Path(__file__).parents[1] / "ts" / "workers" / "rag" / "src" / "index.ts"
    return f"node --experimental-strip-types {worker}"


def _wire_expected(records, scope) -> list[dict]:
    """Python 期望：record 管线 → IndexDocument → wire 文档。"""
    documents = []
    for record in records:
        documents.extend(record_documents(OWNER, record, scope))
    return [_wire_document(document) for document in documents]


def _normalize(wire_documents: list[dict]) -> list[dict]:
    """JSON 往返会把 TS 侧 undefined 字段省略；剔除 None 值键后对齐两侧键集。"""
    return [{key: value for key, value in document.items() if value is not None}
            for document in wire_documents]


async def _worker_actual(client, source_type: str, records) -> list[dict]:
    batch_key = {"file": "files", "conversation": "conversations"}.get(source_type, source_type)
    payload_records = [{
        **record,
        "scope": {**WIRE_SCOPE,
                  **({"scope_type": "group", "scope_id": "g1",
                      "platform": "qq", "bot_id": "bot1", "group_id": "g1"}
                     if scope_is_group else {})},
    } for record, scope_is_group in records]
    response = await client._request({"op": "adapt", "source_type": source_type,
                                      "records": payload_records})
    return list(response.response["documents"])


async def _assert_equivalent(records_by_source: dict[str, list[tuple[dict, bool]]], tmp_path):
    client = TsSidecarClient(OWNER, command=_worker_command(),
                             index_dir=str(tmp_path / "index"))
    try:
        for source_type, records in records_by_source.items():
            scope = GROUP_SCOPE if any(is_group for _record, is_group in records) else OWNER_SCOPE
            expected = _normalize(_wire_expected([record for record, _ in records], scope))
            actual = _normalize(await _worker_actual(client, source_type, records))
            assert len(expected) == len(actual), source_type
            for index, (left, right) in enumerate(zip(expected, actual, strict=True)):
                assert left == right, (
                    f"{source_type}[{index}] 字段 {set(left) ^ set(right) or ''} 不等：\n"
                    f"python={left}\nts={right}")
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_file_projection_equivalent(tmp_path):
    body = "这是文件正文，包含部署结论。"
    full = file_record(SimpleNamespaceRow(
        id=7, display_name="方案.md", ext="md", mime_type="text/markdown",
        project_id=3, folder_id=9, space="项目A", stage_name="评审",
        version="v3", updated_at=_dt(2026, 9, 9),
    ), body)
    minimal = file_record(SimpleNamespaceRow(
        id=8, display_name="零", ext="", mime_type=None, project_id=None,
        folder_id=None, space="", stage_name="", version=None, updated_at=None,
    ), "")
    long = file_record(SimpleNamespaceRow(
        id=9, display_name="长文.txt", ext="txt", mime_type="text/plain",
        project_id=None, folder_id=None, space="", stage_name="",
        version="v1", updated_at=_dt(2026, 9, 1),
    ), "字" * 3000)
    # 非 BMP 字符（emoji）按码点计数：单块不误切、切块窗口逐位对齐。
    emoji_single = file_record(SimpleNamespaceRow(
        id=10, display_name="表情.md", ext="md", mime_type="text/markdown",
        project_id=None, folder_id=None, space="", stage_name="",
        version="v1", updated_at=None,
    ), "a" * 1300 + "\U0001f600" * 60)
    emoji_split = file_record(SimpleNamespaceRow(
        id=11, display_name="长表情.md", ext="md", mime_type="text/markdown",
        project_id=None, folder_id=None, space="", stage_name="",
        version="v1", updated_at=None,
    ), "字" * 1380 + "\U0001f600" * 40)
    await _assert_equivalent({"file": [
        (full, False), (minimal, False), (long, False),
        (emoji_single, False), (emoji_split, False),
    ]}, tmp_path)


@pytest.mark.asyncio
async def test_note_projection_equivalent(tmp_path):
    titled = note_record(SimpleNamespaceRow(
        id=3, title="采购结论", content_plain="纯文本优先", content_md="**md**",
        kind="note", version="v1", indexed_hash="abc", updated_at=_dt(2026, 9, 8),
    ))
    anonymous = note_record(SimpleNamespaceRow(
        id=4, title="", content_plain="", content_md="回退md", kind="suggestion",
        version=None, indexed_hash="", updated_at=None,
    ))
    await _assert_equivalent({"note": [(titled, False), (anonymous, False)]}, tmp_path)


@pytest.mark.asyncio
async def test_canvas_projection_equivalent(tmp_path):
    full = canvas_record(
        SimpleNamespaceRow(id=21, data_json='{"group_path":"后端"}', version=None,
                           updated_at=_dt(2026, 9, 7)),
        SimpleNamespaceRow(id=2, title="发布规划", project_id=4),
        SimpleNamespaceRow(id=9, title="接口", kind="canvas_note",
                           content_plain="接口说明", content_md=None, version="v2"),
        relation_summary="接口 → 测试；测试 ← 接口", group_path="后端",
    )
    bare = canvas_record(
        SimpleNamespaceRow(id=22, data_json=None, version="v9", updated_at=None),
        SimpleNamespaceRow(id=2, title="", project_id=None),
        SimpleNamespaceRow(id=10, title="", kind="note", content_plain=None,
                           content_md="md正文", version="v1"),
        relation_summary="", group_path="",
    )
    await _assert_equivalent({"canvas": [(full, False), (bare, False)]}, tmp_path)


@pytest.mark.asyncio
async def test_calendar_and_task_projection_equivalent(tmp_path):
    events = [calendar_record(SimpleNamespaceRow(
        id=9, title="发布会", date="2026-09-10", time="14:00", description="线上直播",
        project_id=3, version="v1",
    )), calendar_record(SimpleNamespaceRow(
        id=10, title="全天事件", date="2026-09-11", time="", description="",
        project_id=None, version=None,
    ))]
    tasks = [scheduled_task_record(SimpleNamespaceRow(
        id=5, name="日报", cron="0 9 * * *", enabled=True, payload="汇总",
        updated_at=_dt(2026, 9, 6),
    )), scheduled_task_record(SimpleNamespaceRow(
        id=6, name="巡检", cron="*/5 * * * *", enabled=False, payload="",
        updated_at=None,
    ))]
    await _assert_equivalent({"calendar": [(event, False) for event in events],
                              "scheduled_task": [(task, False) for task in tasks]}, tmp_path)


@pytest.mark.asyncio
async def test_conversation_projection_equivalent(tmp_path):
    class _Session:
        id = 1
        title = "部署会话"
        source = "qq"
        summary = "讨论了部署"
        updated_at = _dt(2026, 9, 9, 1)
        baseline_message_id = 3

    class _Message:
        id = 12
        role = "user"
        content = "怎么部署"
        created_at = _dt(2026, 9, 9, 0, 30)
        sent_at = _dt(2026, 9, 9, 0, 31)

    summary = conversation_summary_record(_Session())
    message = conversation_message_record(_Session(), _Message())
    await _assert_equivalent(
        {"conversation": [(summary, True), (message, True)]}, tmp_path)


class SimpleNamespaceRow:
    """宽松字段行：只承载投影纯函数读取的字段，不依赖 ORM。"""

    def __init__(self, **fields):
        for name, value in fields.items():
            setattr(self, name, value)


def _dt(year: int, month: int, day: int, hour: int = 0, minute: int = 0):
    import datetime

    return datetime.datetime(year, month, day, hour, minute)
