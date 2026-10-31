"""保护 Cython RAG tokenizer 与 TS 词项契约的稳定行为。"""
from __future__ import annotations

import pytest

from agent.rag.cython_backend import build_text_index
from agent.rag.cython_tokenizer import tokenize_raw, tokenize_raw_python_reference


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "群消息分词测试 用户工作区 RAG 2026-10-29",
            ["群", "消息", "分词", "测试", "用户", "工作", "区", "rag", "2026", "10", "29", "rag2026", "month_10"],
        ),
        (
            "2026-09-01 记录了这件事",
            ["2026", "09", "01", "记录", "了", "这件", "事", "month_09"],
        ),
        ("9月", ["9", "月", "month_09"]),
        ("九月份", ["九月份", "month_09"]),
        ("September", ["september", "month_09"]),
        ("May 2026", ["may", "2026", "may2026", "month_05"]),
        ("you may want to check", ["you", "may", "want", "to", "check"]),
        ("March 2026", ["march", "2026", "march2026", "month_03"]),
        ("we march forward", ["we", "march", "forward"]),
        ("v2.0 与GPT-4o的检索", ["v2", "0", "与", "gpt", "4o", "的", "检索"]),
    ],
)
def test_tokenizer_preserves_ts_jieba_ascii_compaction_and_date_aliases(text, expected):
    assert tokenize_raw(text) == expected


def test_text_index_uses_identical_tokenization_for_documents_and_query():
    """索引和查询复用同一词项函数，防止只升级一侧造成召回断层。"""
    index = build_text_index(
        ["记录了2026-09-01的工作区状态", "记录了2026-08-01的工作区状态"],
        document_keys=["sept", "aug"],
    )

    assert index.document_keys == ("sept", "aug")
    assert "month_09" in index.term_ids
    assert "month_08" in index.term_ids
    assert "工作" in index.term_ids


@pytest.mark.parametrize(
    "text",
    [
        "",
        "RAG2026 与 2026-10-30 的检索问题",
        "用户工作区里的文档需要按 BM25/Hybrid 排序",
        "May 2026 和 2026-05-01 是同一个月份",
        "mixed-case ASCII plus 中文与数字123",
        "九月份、10月份、September 2026",
    ],
)
def test_compiled_tokenizer_matches_python_reference(text):
    """编译分词批处理必须逐词保持迁移参考契约，防止文本召回悄然漂移。"""
    assert tokenize_raw(text) == tokenize_raw_python_reference(text)
