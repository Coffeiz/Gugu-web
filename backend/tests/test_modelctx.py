"""agent/modelctx.py：透传"这轮真正在跑的模型配置"给工具层。"""
from types import SimpleNamespace

from agent.llm import modelctx


def test_get_model_cfg_defaults_to_none():
    assert modelctx.get_model_cfg() is None


def test_set_and_get_model_cfg_roundtrip():
    ai = SimpleNamespace(provider="minimax", model="abab-m3")
    token = modelctx._model_cfg.set(None)   # 隔离：确保测试间不互相污染
    try:
        modelctx.set_model_cfg(ai)
        assert modelctx.get_model_cfg() is ai
    finally:
        modelctx._model_cfg.reset(token)
