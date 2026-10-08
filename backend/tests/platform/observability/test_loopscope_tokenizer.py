import json
import sys
import types

from agent.runtime.loopscope_trace import utils


def test_tokenizer_path_uses_model_prefix(monkeypatch, tmp_path):
    tokenizer_path = tmp_path / "qwen-tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("LOOPSCOPE_TOKENIZER_MAP", json.dumps({"qwen": str(tokenizer_path)}))
    monkeypatch.delenv("LOOPSCOPE_TOKENIZER_PATH", raising=False)

    assert utils._tokenizer_path("Qwen3.5-Flash") == (str(tokenizer_path), "huggingface:qwen")


def test_tokenizer_failure_falls_back_without_breaking(monkeypatch):
    class BrokenTokenizer:
        @staticmethod
        def from_file(_path):
            raise OSError("invalid tokenizer")

    monkeypatch.setenv("LOOPSCOPE_TOKENIZER_PATH", "/missing/tokenizer.json")
    monkeypatch.setattr(
        sys,
        "modules",
        {**sys.modules, "tokenizers": types.SimpleNamespace(Tokenizer=BrokenTokenizer)},
    )
    utils._TOKENIZER_CACHE.clear()
    utils._TOKENIZER_FAILURES.clear()

    assert utils._estimate_tokens("中文测试") > 0
