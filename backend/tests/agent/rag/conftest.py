"""为 RAG 差分回归隔离编译 Cython 内核；生产依赖与仓库目录保持不变。"""
from __future__ import annotations

import atexit
import tempfile

import pyximport


_CYTHON_BUILD = tempfile.TemporaryDirectory(prefix="gugu-rag-pytest-cython-")
pyximport.install(build_dir=_CYTHON_BUILD.name, language_level=3)
atexit.register(_CYTHON_BUILD.cleanup)
