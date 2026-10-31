"""验证应用进程在不依赖 pytest 导入钩子的情况下可按配置装载 Cython RAG。"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[3]


def test_selected_cython_backend_loads_native_extensions_in_plain_process(tmp_path):
    script = """
from types import SimpleNamespace
from agent.rag.index_cache import _selected_backend
assert _selected_backend(SimpleNamespace(rag_backend='cython')) == 'cython'
from agent.rag.cython_backend import _load_kernel
from agent.rag.cython_tokenizer import tokenize_raw
assert callable(_load_kernel())
assert tokenize_raw('南京天气')
"""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(BACKEND)
    env["GUGU_RAG_CYTHON_BUILD_DIR"] = str(tmp_path / "compiled")

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )

    assert result.returncode == 0, result.stderr
