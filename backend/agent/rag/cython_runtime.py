"""开发环境按需装载 Cython RAG 扩展。"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tempfile
import threading
from pathlib import Path


class CythonRuntimeUnavailable(RuntimeError):
    """Cython 扩展运行时依赖不可用。"""


_install_lock = threading.Lock()
_installed = False


def ensure_cython_importer() -> None:
    """安装惰性 `.pyx` 导入器；编译缓存放在仓库外的临时目录。"""
    global _installed
    if _installed:
        return
    with _install_lock:
        if _installed:
            return
        try:
            import pyximport
        except ImportError as error:
            raise CythonRuntimeUnavailable(
                "Cython RAG 已选择，但当前环境未安装 Cython；不会回退到其他后端"
            ) from error

        configured_dir = os.environ.get("GUGU_RAG_CYTHON_BUILD_DIR", "").strip()
        build_dir = Path(configured_dir) if configured_dir else (
            Path(tempfile.gettempdir()) / "gugu-rag-cython" / sys.implementation.cache_tag
        )
        build_dir.mkdir(parents=True, exist_ok=True)
        pyximport.install(build_dir=str(build_dir), language_level=3, inplace=False)
        _installed = True


async def ensure_cython_native_loaded() -> None:
    """优先加载预编译扩展；开发环境缺少扩展时再按需编译。"""
    module_name = "agent.rag.cython_native"
    try:
        await asyncio.to_thread(importlib.import_module, module_name)
        return
    except ModuleNotFoundError as error:
        # 仅目标扩展缺失时才走 pyximport；扩展自身的依赖缺失必须原样暴露。
        if error.name != module_name:
            raise
    await asyncio.to_thread(ensure_cython_importer)
    await asyncio.to_thread(importlib.import_module, module_name)
