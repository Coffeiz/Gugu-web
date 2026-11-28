"""跨语言共享合成样例，保护选词、Unicode定位、片段和空白的Python基准。"""

from pathlib import Path
import json

import pytest

from app.api.v1.search import _snippet_for_queries


_FIXTURE = Path(__file__).resolve().parents[4] / "packages/core/tests/fixtures/search-snippet.json"
_EXAMPLES = json.loads(_FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("example", _EXAMPLES, ids=lambda value: value["name"])
def test_search_snippet_preserves_python_business_behavior(example):
    assert _snippet_for_queries(example["text"], example["queries"]) == example["expected"]
