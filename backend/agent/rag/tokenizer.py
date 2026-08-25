"""RAG 统一分词边界。

词法索引实现已经迁移到 Rust；这里暂时保留 Jieba 分词，确保迁移前后的
中文召回语义一致。该模块不负责评分、倒排或索引生命周期。
"""
from __future__ import annotations

import re

import jieba


_TOKEN = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]+")


def tokenize(text: str) -> list[str]:
    normalized = (text or "").lower()
    raw = _TOKEN.findall(normalized)
    # 产品名/版本号常见写法会在空格处断开（GTA 6 / GTA6、F1 2026 等）。
    # 保留原 token，同时补一个紧凑实体 token，让查询和记忆正文使用同一词法边界。
    compact = re.sub(r"(?<=[a-z])\s+(?=\d)|(?<=\d)\s+(?=[a-z])", "", normalized)
    compact_tokens = [token for token in _TOKEN.findall(compact) if token not in raw]
    raw.extend(compact_tokens)
    output: list[str] = []
    for token in raw:
        if token.isascii():
            output.append(token)
            output.extend(token[index:index + 2] for index in range(len(token) - 1))
            continue
        output.extend(word for word in jieba.lcut(token, HMM=False) if word.strip())
        output.extend(token)
    return output


__all__ = ["tokenize"]
