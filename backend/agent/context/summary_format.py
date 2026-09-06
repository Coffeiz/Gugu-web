"""压缩摘要的稳定 wire 格式。

摘要会在当前 run 的内存历史和下一轮从数据库恢复的历史之间流转。
两条路径必须使用完全相同的文本包装，否则 provider 会把摘要边界视为
新的前缀，导致跨 run cache 从摘要之前直接断开。
"""
from __future__ import annotations


SUMMARY_OPEN = "<compacted-summary>"
SUMMARY_CLOSE = "</compacted-summary>"


def unwrap_compacted_summary(value: str) -> str:
    """去除摘要的统一外层包装，返回可继续合并的正文。"""
    text = str(value or "").strip()
    # 兼容旧版本把包装与“已有摘要：”等前缀拼在一起的脏数据；fallback
    # 需要的是正文，不能让任意残留标记再次触发候选校验失败。
    return text.replace(SUMMARY_OPEN, "").replace(SUMMARY_CLOSE, "").strip()


def format_compacted_summary(value: str) -> str:
    """把摘要正文规范化为唯一的 provider-facing 文本。"""
    text = unwrap_compacted_summary(value)
    return f"{SUMMARY_OPEN}\n{text}\n{SUMMARY_CLOSE}"
