"""与 TS RAG 词项规则对齐的 jieba-rs tokenizer adapter。

中文分词委托给 rjieba（jieba-rs 的 PyO3 绑定）；ASCII 实体、紧邻字母数字
压缩和日期月份别名保持 TS tokenizer 的投影规则。
"""
from __future__ import annotations

import re
from functools import lru_cache


TOKENIZER_VERSION = "jieba-rs-0.2.2-hmm-off-ts-token-rules-v1"
_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]+")
_ASCII_RE = re.compile(r"^[\x00-\x7f]+$")
_CHINESE_RE = re.compile(r"[\u4e00-\u9fff]")
_CHINESE_MONTHS = (
    ("十二", 12), ("十一", 11), ("十", 10), ("九", 9), ("八", 8), ("七", 7),
    ("六", 6), ("五", 5), ("四", 4), ("三", 3), ("二", 2), ("一", 1),
)
_CHINESE_MONTH_BY_NAME = dict(_CHINESE_MONTHS)
_ENGLISH_MONTHS = (
    ("january", 1), ("jan", 1), ("february", 2), ("feb", 2), ("march", 3),
    ("mar", 3), ("april", 4), ("apr", 4), ("may", 5), ("june", 6),
    ("jun", 6), ("july", 7), ("jul", 7), ("august", 8), ("aug", 8),
    ("september", 9), ("sept", 9), ("sep", 9), ("october", 10), ("oct", 10),
    ("november", 11), ("nov", 11), ("december", 12), ("dec", 12),
)
_ENGLISH_MONTH_BY_NAME = dict(_ENGLISH_MONTHS)
_CHINESE_MONTH_RE = re.compile(
    "(" + "|".join(month for month, _ in _CHINESE_MONTHS) + ")月(?:份)?"
)
_ENGLISH_MONTH_RE = re.compile(
    r"(?<![A-Za-z0-9_])(" + "|".join(month for month, _ in _ENGLISH_MONTHS)
    + r")(?![A-Za-z0-9_])"
)
_ISO_MONTH_RE = re.compile(
    r"(?<![A-Za-z0-9_])\d{4}[-/.](0?[1-9]|1[0-2])(?=[-/.]\d{1,2}(?!\d)|(?![A-Za-z0-9_]))"
)
_NUMERIC_MONTH_RE = re.compile(r"(?<!\d)(0?[1-9]|1[0-2])\s*月(?:份)?")
_COMPACT_RE = re.compile(r"(?<=[a-z])\s+(?=\d)|(?<=\d)\s+(?=[a-z])")


class RagTokenizerUnavailable(RuntimeError):
    """RAG tokenizer 的 native runtime 不可用。"""


@lru_cache(maxsize=1)
def _jieba() -> object:
    try:
        import rjieba
    except ImportError as error:
        raise RagTokenizerUnavailable(
            "RAG tokenizer 需要已安装的 rjieba PyO3 扩展"
        ) from error
    return rjieba


def _month_aliases(text: str) -> list[str]:
    months: list[int] = []
    seen: set[int] = set()

    def add(month: int) -> None:
        if month not in seen:
            seen.add(month)
            months.append(month)

    for match in _ISO_MONTH_RE.finditer(text):
        add(int(match.group(1)))
    for match in _NUMERIC_MONTH_RE.finditer(text):
        add(int(match.group(1)))
    for match in _CHINESE_MONTH_RE.finditer(text):
        add(_CHINESE_MONTH_BY_NAME[match.group(1)])

    for match in _ENGLISH_MONTH_RE.finditer(text):
        month = _ENGLISH_MONTH_BY_NAME[match.group(1)]
        if month in (3, 5):
            before = text[max(0, match.start() - 24):match.start()]
            after = text[match.end():match.end() + 24]
            has_date_context = bool(
                re.search(r"(?:\d{1,4}|\b(?:in|during|since|until|by|from|throughout))\s*$", before)
                or re.match(r"^\s*,?\s*\d{1,4}\b", after)
            )
            if not has_date_context:
                continue
        add(month)

    return [f"month_{month:02d}" for month in months]


@lru_cache(maxsize=8192)
def _segment_chinese(token: str) -> tuple[str, ...]:
    segmenter = _jieba()
    return tuple(
        # TS 的 node-rs Jieba 词项规则采用 HMM=False；统一关闭以避免未登录词
        # 的 HMM 推断改变词项边界。
        word for word in segmenter.cut(token, hmm=False)
        if _CHINESE_RE.search(word)
    )


def tokenize_raw(text: str) -> list[str]:
    """通过编译后的批处理内核复刻 TS `tokenizeRaw` 的词项规则。"""
    try:
        from agent.rag import cython_native
    except ImportError as error:
        raise RagTokenizerUnavailable("Cython RAG 文本内核未构建") from error
    return cython_native.tokenize_raw(str(text or ""))


def tokenize_raw_python_reference(text: str) -> list[str]:
    """Python 参考实现，仅供差分测试与迁移期诊断。"""
    normalized = str(text or "").lower()
    raw = _TOKEN_RE.findall(normalized)
    compact = _COMPACT_RE.sub("", normalized)
    raw_set = set(raw)
    compact_tokens = [token for token in _TOKEN_RE.findall(compact) if token not in raw_set]

    output: list[str] = []
    for token in (*raw, *compact_tokens):
        if _ASCII_RE.fullmatch(token):
            output.append(token)
        else:
            output.extend(_segment_chinese(token))
    for alias in _month_aliases(normalized):
        if alias not in output:
            output.append(alias)
    return output


__all__ = ["RagTokenizerUnavailable", "TOKENIZER_VERSION", "tokenize_raw"]
