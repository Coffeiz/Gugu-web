"""开发环境按需装载 Cython RAG 扩展。"""
from __future__ import annotations

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
