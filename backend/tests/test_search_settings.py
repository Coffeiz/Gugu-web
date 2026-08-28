import pytest

from app.core.config import SearchSettings


def test_rag_auto_sources_are_enabled_by_default():
    settings = SearchSettings()

    assert settings.rag_auto_sources == [
        "memory",
        "knowledge",
        "project",
        "file",
        "canvas",
        "conversation",
    ]


def test_rag_index_ttl_has_safe_default_and_bounds():
    settings = SearchSettings()

    assert settings.ts_sidecar_index_ttl_seconds == 30 * 24 * 3600
    assert SearchSettings(ts_sidecar_index_ttl_seconds=7 * 24 * 3600)
    with pytest.raises(ValueError):
        SearchSettings(ts_sidecar_index_ttl_seconds=24 * 3600)
