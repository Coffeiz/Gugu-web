"""复刻 TS ``String.localeCompare`` 的固定 en-US RAG 排序契约。"""
from __future__ import annotations

from functools import lru_cache
from threading import Lock
import ctypes
import ctypes.util
import re
import sys


class CythonCollationUnavailable(RuntimeError):
    """当前平台没有可用的 ICU collator，不能保证 TS 排序等价。"""


_ICU_LOCK = Lock()
_COLLATOR: tuple[ctypes.CDLL, int, object] | None = None


def _icu_collator() -> tuple[ctypes.CDLL, int]:
    global _COLLATOR
    with _ICU_LOCK:
        if _COLLATOR is not None:
            return _COLLATOR
        library_name = ctypes.util.find_library("icui18n")
        symbol_suffix = ""
        if library_name:
            match = re.search(r"\.so\.(\d+)$", library_name)
            symbol_suffix = f"_{match.group(1)}" if match else ""
        elif sys.platform == "darwin":
            library_name = ctypes.util.find_library("icucore")
        if not library_name:
            raise CythonCollationUnavailable("RAG 等价排序需要系统 ICU collator")

        try:
            library = ctypes.CDLL(library_name)
            open_collator = getattr(library, f"ucol_open{symbol_suffix}")
            open_collator.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int32)]
            open_collator.restype = ctypes.c_void_p
            status = ctypes.c_int32(0)
            collator = open_collator(b"en_US", ctypes.byref(status))
            if not collator or status.value > 0:
                raise CythonCollationUnavailable("无法初始化 en-US RAG collator")

            get_sort_key = getattr(library, f"ucol_getSortKey{symbol_suffix}")
            get_sort_key.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_uint16),
                ctypes.c_int32,
                ctypes.POINTER(ctypes.c_uint8),
                ctypes.c_int32,
            ]
            get_sort_key.restype = ctypes.c_int32
            _COLLATOR = library, collator, get_sort_key
            return _COLLATOR
        except (AttributeError, OSError) as error:
            raise CythonCollationUnavailable("系统 ICU 不支持 RAG 等价排序") from error


@lru_cache(maxsize=8192)
def locale_sort_key(value: str) -> bytes:
    """返回 ICU en-US sort key，与 TS 显式 en-US ``localeCompare`` 对齐。"""
    _library, collator, get_sort_key = _icu_collator()
    source_bytes = value.encode("utf-16-le", errors="surrogatepass")
    source_length = len(source_bytes) // 2
    source = (ctypes.c_uint16 * max(1, source_length))()
    if source_bytes:
        ctypes.memmove(source, source_bytes, len(source_bytes))
    with _ICU_LOCK:
        required = get_sort_key(collator, source, source_length, None, 0)
        if required <= 0:
            raise CythonCollationUnavailable("ICU 未能生成 RAG sort key")
        output = (ctypes.c_uint8 * required)()
        written = get_sort_key(collator, source, source_length, output, required)
    if written != required:
        raise CythonCollationUnavailable("ICU RAG sort key 长度不一致")
    return bytes(output[:written])


def reverse_locale_sort_key(value: str) -> bytes:
    """反向 ICU 次序，用于复刻 TS 的降序 ``localeCompare``。"""
    return bytes(255 - byte for byte in locale_sort_key(value))
