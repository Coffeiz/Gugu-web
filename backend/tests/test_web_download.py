from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest


def test_download_filename_prefers_explicit_name_and_infers_extension():
    from agent.tools.web import _download_filename

    assert _download_filename("报告.pdf", "https://example.test/file", "application/octet-stream") == ("报告", "pdf")
    assert _download_filename(None, "https://example.test/assets/photo", "image/png") == ("photo", "png")
    assert _download_filename("../unsafe/name", "https://example.test/file", "text/plain") == ("name", "txt")


@pytest.mark.asyncio
async def test_web_download_saves_to_personal_root_by_default():
    from agent.tools import web

    file_row = SimpleNamespace(
        id=7,
        display_name="readme",
        ext="md",
        size="1 KB",
        size_bytes=5,
        mime_type="text/markdown",
        space="personal",
        project_id=None,
        folder_id=None,
    )
    fake_result = SimpleNamespace(file=file_row)
    fake_service = SimpleNamespace(create_file=AsyncMock(return_value=fake_result))
    db = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock())

    with (
        patch.object(web, "_download_bytes", new=AsyncMock(return_value=(200, {"content-type": "text/markdown"}, b"hello"))),
        patch.object(web, "FileService", return_value=fake_service),
    ):
        result = await web._web_download(
            db,
            "user-1",
            {"url": "example.test/readme.md"},
        )

    assert result["success"] is True
    assert result["source_url"] == "https://example.test/readme.md"
    fake_service.create_file.assert_awaited_once()
    assert fake_service.create_file.await_args.kwargs["space"] == "personal"
    assert fake_service.create_file.await_args.kwargs["project_id"] is None
    assert fake_service.create_file.await_args.kwargs["folder_id"] is None


@pytest.mark.asyncio
async def test_web_download_rejects_conflicting_location():
    from agent.tools import web

    result = await web._web_download(
        SimpleNamespace(),
        "user-1",
        {"url": "https://example.test/a.bin", "space": "personal", "project_id": 3},
    )

    assert result == {"error": "space=personal 不能同时指定 project_id"}
