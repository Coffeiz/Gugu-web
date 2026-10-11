"""文件库 read_file 的文本/视觉边界回归。"""
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_read_file_reads_svg_source_instead_of_rejecting_it(monkeypatch):
    import agent.tools.files as agent_files
    from app.core import doctext

    file = SimpleNamespace(
        id=123,
        display_name="图表",
        ext="svg",
        mime_type="image/svg+xml",
        size_bytes=42,
        size="42 B",
        storage_key="user-a/personal/图表.svg",
    )
    source = '<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>'

    async def resolve_file(db, user_id, args):
        return file, None

    class Storage:
        async def get(self, key):
            assert key == file.storage_key
            return source.encode("utf-8")

    async def extract_text(data, ext):
        assert data == source.encode("utf-8")
        assert ext == "svg"
        return source

    monkeypatch.setattr(agent_files, "_resolve_file", resolve_file)
    monkeypatch.setattr(agent_files, "get_storage", lambda: Storage())
    monkeypatch.setattr(doctext, "extract_text", extract_text)

    result = await agent_files._read_file("db", "user-a", {"file_id": file.id})

    assert result["file_id"] == file.id
    assert result["name"] == "图表.svg"
    assert result["content"] == source
