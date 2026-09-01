"""汉字/假名罗马音转换，用于拼音/罗马音搜索。

- 中文：pypinyin → 拼音（lazy_pinyin，无声调）
- 日语汉字：SudachiPy → 假名读音
- 日语假名：romkan2 → Hepburn 罗马音
- 语言注册表：按用户 locale 选择主转换器，并保留跨语言候选
- ASCII query 检测 + 子串匹配，让用户用 riqi 搜到「日期」、yorushika 搜到「ヨルシカ」
"""

import re

try:
    from pypinyin import lazy_pinyin as _lazy_pinyin
    _HAS_PINYIN = True
except ImportError:
    _HAS_PINYIN = False

try:
    import romkan2 as _romkan2
    from sudachipy import Dictionary as _SudachiDictionary
    from sudachipy import SplitMode as _SudachiSplitMode

    _sudachi_tokenizer = _SudachiDictionary().create()
    _HAS_JAPANESE_ROMAJI = True
except ImportError:
    _HAS_JAPANESE_ROMAJI = False
    _romkan2 = None
    _SudachiSplitMode = None
    _sudachi_tokenizer = None


def _normalize_romaji(text: str) -> str:
    """统一搜索用罗马音格式，消除不同转换器对分隔符和长音的差异。"""
    return text.replace("'", "").replace("-", "")


def _contains_japanese_kana(text: str) -> bool:
    """用假名判断是否应保留日文原文交给 Sudachi，避免先被中文拼音改写。"""
    return any("\u3040" <= char <= "\u30ff" for char in text)


def _to_chinese_pinyin(text: str) -> str:
    if not _HAS_PINYIN:
        return text
    return "".join(_lazy_pinyin(text, errors="default"))


def _keep_text(text: str) -> str:
    return text


def _to_japanese_romaji(text: str) -> str | None:
    if not (_HAS_JAPANESE_ROMAJI and _romkan2 is not None and _sudachi_tokenizer is not None):
        return None

    readings = (
        token.reading_form() or token.surface()
        for token in _sudachi_tokenizer.tokenize(text, _SudachiSplitMode.C)
    )
    return "".join(_romkan2.to_roma(reading) for reading in readings)


LANGUAGE_REGISTRY = {
    "zh-CN": {
        "primary": _to_chinese_pinyin,
        "fallbacks": (_to_japanese_romaji,),
    },
    "ja-JP": {
        "primary": _to_japanese_romaji,
        "fallbacks": (_to_chinese_pinyin,),
    },
    "en-US": {
        "primary": _keep_text,
        "fallbacks": (_to_chinese_pinyin, _to_japanese_romaji),
    },
}


def _romaji_candidates(text: str, language: str = "zh-CN") -> list[str]:
    """按语言注册表返回主结果和候选结果，处理跨语言文字的歧义。"""
    if not text:
        return []

    profile = LANGUAGE_REGISTRY.get(language, LANGUAGE_REGISTRY["zh-CN"])
    converters = (
        (_to_japanese_romaji,)
        if _contains_japanese_kana(text)
        else (profile["primary"], *profile["fallbacks"])
    )
    candidates = []
    for converter in converters:
        result = converter(text)
        if result is not None:
            candidates.append(result)

    return list(dict.fromkeys(_normalize_romaji(item.lower()) for item in candidates))


def to_romaji(text: str, language: str = "zh-CN") -> str:
    """把文本转为小写罗马音字符串（去空格），用于子串匹配。"""
    return _romaji_candidates(text, language)[0] if text else ""


def is_romaji_query(q: str) -> bool:
    """判断 q 是否为纯 ASCII 字母查询（触发拼音/罗马音搜索）。"""
    stripped = q.replace(" ", "")
    return bool(stripped) and stripped.isascii() and stripped.isalpha()


def romaji_match(text: str, q: str, language: str = "zh-CN") -> bool:
    """text 转罗马音后是否包含 q（去空格子串匹配）。"""
    if not text or not q:
        return False
    normalized_q = q.lower().replace(" ", "")
    return bool(normalized_q) and any(
        normalized_q in candidate.replace(" ", "")
        for candidate in _romaji_candidates(text, language)
    )
