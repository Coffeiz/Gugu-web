"""压缩摘要的稳定 wire 格式。

摘要会在当前 run 的内存历史和下一轮从数据库恢复的历史之间流转。
两条路径必须使用完全相同的文本包装，否则 provider 会把摘要边界视为
新的前缀，导致跨 run cache 从摘要之前直接断开。
"""
from __future__ import annotations


SUMMARY_OPEN = "<compacted-summary>"
SUMMARY_CLOSE = "</compacted-summary>"


def format_compacted_summary(value: str) -> str:
    """把摘要正文规范化为唯一的 provider-facing 文本。"""
    text = str(value or "").strip()
    if text.startswith(SUMMARY_OPEN) and text.endswith(SUMMARY_CLOSE):
        inner = text[len(SUMMARY_OPEN):-len(SUMMARY_CLOSE)].strip()
        text = inner
    return f"{SUMMARY_OPEN}\n{text}\n{SUMMARY_CLOSE}"
