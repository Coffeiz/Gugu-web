"""RAG 统一分词边界。

词法索引实现已经迁移到 Rust；这里暂时保留 Jieba 分词，确保迁移前后的
中文召回语义一致。该模块不负责评分、倒排或索引生命周期。
"""
from __future__ import annotations

import re

import jieba


_TOKEN = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]+")


def tokenize(text: str) -> list[str]:
    raw = _TOKEN.findall((text or "").lower())
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
