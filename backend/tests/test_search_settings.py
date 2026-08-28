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
