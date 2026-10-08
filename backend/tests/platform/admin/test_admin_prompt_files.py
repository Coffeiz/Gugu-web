"""Admin 提示词 tab → 文件名映射回归测试。

「记忆压缩」tab 名为 compress，但运行时消费方读取的是 memory_compress.md；
映射错位曾导致该 tab 永远显示空、保存落到无人读取的 compress.md。
"""

import pytest
from fastapi import HTTPException

from app.api.v1 import agent_admin


def test_compress_tab_maps_to_memory_compress_file(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_admin, "PROMPTS_DIR", tmp_path)
    assert agent_admin._prompt_path("compress") == tmp_path / "memory_compress.md"


def test_other_special_prompts_keep_same_name_file(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_admin, "PROMPTS_DIR", tmp_path)
    for name in ("persona", "skills", "policy", "reflection"):
        assert agent_admin._prompt_path(name) == tmp_path / f"{name}.md"


def test_unknown_profile_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_admin, "PROMPTS_DIR", tmp_path)
    with pytest.raises(HTTPException) as exc:
        agent_admin._prompt_path("nope")
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_get_prompt_compress_reads_memory_compress_content(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_admin, "PROMPTS_DIR", tmp_path)
    (tmp_path / "memory_compress.md").write_text("记忆压缩提炼词正文", encoding="utf-8")

    result = await agent_admin.get_prompt("compress")

    assert result == {"profile": "compress", "content": "记忆压缩提炼词正文"}


@pytest.mark.asyncio
async def test_list_prompts_reports_memory_compress_file_state(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_admin, "PROMPTS_DIR", tmp_path)
    (tmp_path / "memory_compress.md").write_text("正文", encoding="utf-8")

    data = await agent_admin.list_prompts()

    compress = next(p for p in data["profiles"] if p["profile"] == "compress")
    assert compress["exists"] is True
    assert compress["size"] == len("正文".encode("utf-8"))
