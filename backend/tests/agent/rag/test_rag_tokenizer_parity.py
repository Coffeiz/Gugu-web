"""Cython tokenizer must preserve the checked-in cross-language golden corpus."""
import json
from pathlib import Path

import pytest

from agent.rag.cython_tokenizer import tokenize_raw


ROOT = Path(__file__).parents[3]
FIXTURE = ROOT / "tests" / "fixtures" / "rag_tokenizer_golden.json"


@pytest.mark.parametrize("case", json.loads(FIXTURE.read_text(encoding="utf-8")))
def test_cython_tokenizer_matches_golden_corpus(case):
    assert tokenize_raw(case["text"]) == case["tokens"], case["text"]
