"""站内搜索的关键词解析、条件构建和基础相关性评分。"""

from collections.abc import Sequence

from sqlalchemy import and_, case, or_

MAX_SEARCH_QUERIES = 8
MAX_SEARCH_QUERY_LENGTH = 64
SEARCH_MODES = {"OR", "AND"}


def normalize_queries(
    q: str | None = None,
    queries: Sequence[str] | None = None,
) -> list[str]:
    """规范化搜索词；旧的单字符串入口作为一个完整短语保留。"""
    values = list(queries) if queries else ([q] if q is not None else [])
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value).strip()
        if not text:
            continue
        text = text[:MAX_SEARCH_QUERY_LENGTH]
        if text.casefold() in seen:
            continue
        seen.add(text.casefold())
        result.append(text)
        if len(result) >= MAX_SEARCH_QUERIES:
            break
    return result


def normalize_mode(mode: str | None) -> str:
    normalized = str(mode or "OR").upper()
    return normalized if normalized in SEARCH_MODES else "OR"


def keyword_condition(columns: Sequence, queries: Sequence[str], mode: str = "OR"):
    """构建“每个关键词命中任意字段”的 OR/AND 条件。"""
    terms = [or_(*(column.ilike(f"%{query}%") for column in columns)) for query in queries]
    if not terms:
        return None
    return and_(*terms) if normalize_mode(mode) == "AND" else or_(*terms)


def keyword_score(columns: Sequence, queries: Sequence[str]):
    """按命中关键词数量生成可解释的 SQL 排序分数。"""
    return sum(
        case((or_(*(column.ilike(f"%{query}%") for column in columns)), 1), else_=0)
        for query in queries
    )
