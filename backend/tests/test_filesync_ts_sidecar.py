import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.filesync.ts_sidecar import FileSyncSidecar


def test_ts_sidecar_default_artifact_is_in_backend_bin():
    sidecar = FileSyncSidecar()
    assert Path(sidecar.command[-1]) == Path(__file__).parents[1] / "bin/gugu-filesync-ts-worker.cjs"


@pytest.mark.asyncio
async def test_ts_sidecar_built_artifact_reports_file_and_folder_events(tmp_path):
    """验证部署实际使用的固定 bundle 可启动、注册监听并投递路径事件。"""
    sidecar = FileSyncSidecar()
    await sidecar.start()
    try:
        await sidecar.watch(1, tmp_path)
        for _ in range(100):
            event = await sidecar.next_event(timeout=0.1)
            if event and event.get("event") == "ready":
                break
        else:
            pytest.fail("监听未就绪")
        (tmp_path / "reports").mkdir()
        (tmp_path / "reports" / "today.txt").write_text("today", encoding="utf-8")

        events = []
        for _ in range(100):
            event = await sidecar.next_event(timeout=0.1)
            if event is not None:
                events.append(event)
            if any(item.get("relative_path") == "reports/today.txt" for item in events):
                break

        changes = [item for item in events if item.get("event") == "change"]
        assert any(item.get("relative_path") == "reports" and item.get("object_type") == "folder" for item in changes)
        assert any(item.get("relative_path") == "reports/today.txt" and item.get("operation") == "create" for item in changes)
    finally:
        await sidecar.close()


@pytest.mark.asyncio
async def test_overflow_preserves_accepted_events_and_sticky_recovery_signal():
    """连续溢出不能清空已收到的删除事件，也不能吞掉手动核对提示。"""
    sidecar = FileSyncSidecar()
    reader = asyncio.StreamReader()
    sidecar._events = asyncio.Queue(maxsize=2)
    sidecar._process = SimpleNamespace(stdout=reader, returncode=None)
    for index in range(6):
        reader.feed_data((json.dumps({
            "kind": "event", "event": "change", "operation": "delete",
            "relative_path": f"synthetic-{index}.txt",
        }) + "\n").encode())
    reader.feed_eof()
    await sidecar._read_loop()
    assert (await sidecar.next_event())["code"] == "python_event_queue_overflow"
    assert (await sidecar.next_event())["relative_path"] == "synthetic-0.txt"
    assert (await sidecar.next_event())["relative_path"] == "synthetic-1.txt"
    assert await sidecar.next_event() is None


@pytest.mark.asyncio
async def test_reader_exit_does_not_report_process_as_healthy():
    """协议输出已断开时，即使 OS 尚未回收进程也不能继续宣称可用。"""
    sidecar = FileSyncSidecar()
    reader = asyncio.StreamReader()
    sidecar._process = SimpleNamespace(stdout=reader, returncode=None)
    sidecar._reader_task = asyncio.create_task(sidecar._read_loop())
    assert sidecar.running
    reader.feed_eof()
    await sidecar._reader_task
    assert not sidecar.running
