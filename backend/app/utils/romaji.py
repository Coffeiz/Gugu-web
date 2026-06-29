"""汉字/假名罗马音转换，用于拼音/罗马音搜索。

- 中文：pypinyin → 拼音（lazy_pinyin，无声调）
- 日语假名：pykakasi → Hepburn 罗马音
- ASCII query 检测 + 子串匹配，让用户用 riqi 搜到「日期」、yorushika 搜到「ヨルシカ」
"""

import re

try:
    from pypinyin import lazy_pinyin as _lazy_pinyin
    _HAS_PINYIN = True
except ImportError:
    _HAS_PINYIN = False

try:
    import pykakasi as _pykakasi
    _kks = _pykakasi.kakasi()
    _HAS_KAKASI = True
except ImportError:
    _HAS_KAKASI = False
    _kks = None


def to_romaji(text: str) -> str:
    """把文本转为小写罗马音字符串（去空格），用于子串匹配。"""
    if not text:
        return ""

    # Step 1: pypinyin 把汉字转为拼音，非汉字字符原样保留
    if _HAS_PINYIN:
        parts = _lazy_pinyin(text, errors="default")
        interim = "".join(parts)
    else:
        interim = text

    # Step 2: pykakasi 把假名转为 Hepburn 罗马音，ASCII/拼音字母原样保留
    if _HAS_KAKASI and _kks is not None:
        items = _kks.convert(interim)
        result = "".join(item["hepburn"] for item in items)
    else:
        result = interim

    return result.lower()


def is_romaji_query(q: str) -> bool:
    """判断 q 是否为纯 ASCII 字母查询（触发拼音/罗马音搜索）。"""
    stripped = q.replace(" ", "")
    return bool(stripped) and stripped.isascii() and stripped.isalpha()


def romaji_match(text: str, q: str) -> bool:
    """text 转罗马音后是否包含 q（去空格子串匹配）。"""
    if not text or not q:
        return False
    r = to_romaji(text).replace(" ", "")
    normalized_q = q.lower().replace(" ", "")
    return bool(normalized_q) and normalized_q in r
