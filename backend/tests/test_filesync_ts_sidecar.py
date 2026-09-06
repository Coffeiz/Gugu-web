import asyncio
import shutil
from pathlib import Path

import pytest

from app.services.filesync.ts_sidecar import FileSyncSidecar


def test_ts_sidecar_default_artifact_is_in_backend_bin():
    sidecar = FileSyncSidecar()
    assert Path(sidecar.command[-1]) == Path(__file__).parents[1] / "bin/gugu-filesync-ts-worker.cjs"


@pytest.mark.asyncio
async def test_ts_sidecar_reports_file_and_folder_events(tmp_path):
    source = Path(__file__).parents[1] / "ts/packages/filesync-watcher/src/index.ts"
    sidecar = FileSyncSidecar(command=[
        shutil.which("node") or "node",
        "--experimental-strip-types",
        str(source),
    ])
    await sidecar.start()
    try:
        await sidecar.watch(1, tmp_path)
        await asyncio.sleep(0.05)
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
