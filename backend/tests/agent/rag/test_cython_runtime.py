"""验证应用进程在不依赖 pytest 导入钩子的情况下可按配置装载 Cython RAG。"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


BACKEND = Path(__file__).resolve().parents[3]


def test_selected_cython_backend_loads_native_extensions_in_plain_process(tmp_path):
    script = """
from types import SimpleNamespace
from agent.rag.cython_runtime import ensure_cython_importer
ensure_cython_importer()
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


@pytest.mark.asyncio
async def test_cython_native_first_load_does_not_block_event_loop(monkeypatch):
    """首次 native 导入耗时时，RAG 冷预热不应冻结同进程的 Agent 请求循环。"""
    from agent.rag import cython_runtime

    event_loop_thread = threading.get_ident()
    import_threads = []
    ticks = 0
    finished = asyncio.Event()

    def slow_import(_module_name):
        import_threads.append(threading.get_ident())
        deadline = time.perf_counter() + 0.06
        while time.perf_counter() < deadline:
            pass

    async def heartbeat():
        nonlocal ticks
        while not finished.is_set():
            ticks += 1
            await asyncio.sleep(0.005)

    monkeypatch.setattr(cython_runtime, "ensure_cython_importer", lambda: None)
    monkeypatch.setattr(cython_runtime, "importlib", SimpleNamespace(import_module=slow_import))
    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        await cython_runtime.ensure_cython_native_loaded()
    finally:
        finished.set()
        await heartbeat_task

    assert import_threads and import_threads[0] != event_loop_thread
    assert ticks >= 2
