"""离线验证 Capability RAG 软推荐与硬筛选边界。

本脚本不改运行时工具集合，也不执行工具。它使用真实 Tool Registry 的短描述元数据，
复用统一 RAG 分词，模拟“授权视图 -> 硬筛选 -> 推荐排序”的第一轮结果。
正式 Capability RAG 接入后，推荐排序应替换为 RAG 结果，但筛选边界保持不变。
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from agent.capabilities.index import CapabilityIndex
from agent.capabilities.models import CapabilityMeta, CapabilitySnapshot
from agent.rag.tokenizer import tokenize


DEFAULT_LIMIT = 5
RECOMMENDATION_FLOOR = 0.35


@dataclass(frozen=True)
class ProbeContext:
    name: str
    query: str
    platform: str = "web"
    authorized_names: frozenset[str] | None = None
    required_permissions: frozenset[str] = frozenset()
    limit: int = DEFAULT_LIMIT


def _terms(text: str) -> set[str]:
    return {token for token in tokenize(text) if token.strip()}


def _score(
    query: str,
    item: CapabilityMeta,
    skills: dict[str, CapabilityMeta],
) -> tuple[float, str]:
    query_terms = _terms(query)
    related_skill_items = [
        skill for skill in skills.values()
        if item.name in skill.related_tools or skill.name in item.related_skills
    ]
    searchable = " ".join(
        (item.name, item.description_short, item.category,
         " ".join(item.related_tools), " ".join(item.related_skills),
         " ".join(skill.description_short for skill in related_skill_items),
         " ".join(skill.category for skill in related_skill_items))
    )
    document_terms = _terms(searchable)
    if not query_terms or not document_terms:
        return 0.0, "没有可匹配的语义词"

    overlap = query_terms & document_terms
    score = len(overlap) / len(query_terms)
    normalized_query = re.sub(r"\s+", "", query.casefold())
    normalized_name = re.sub(r"[_-]+", "", item.name.casefold())
    if normalized_name and normalized_name in normalized_query:
        score += 0.35
    if item.category and item.category.casefold() in normalized_query:
        score += 0.15
    score = min(1.0, score)
    reason = "命中：" + "、".join(sorted(overlap)) if overlap else "名称/类别弱匹配"
    return score, reason


def recommend(snapshot: CapabilitySnapshot, context: ProbeContext) -> dict:
    """返回推荐结果和每个硬筛选阶段的脱敏统计。"""
    authorized = (
        set(snapshot.tools)
        if context.authorized_names is None
        else set(context.authorized_names) & set(snapshot.tools)
    )
    eligible: list[CapabilityMeta] = []
    rejected = {"unauthorized": 0, "disabled": 0, "platform": 0, "permission": 0}
    for item in snapshot.tools.values():
        if item.name not in authorized:
            rejected["unauthorized"] += 1
            continue
        if not item.enabled:
            rejected["disabled"] += 1
            continue
        if item.platforms and context.platform not in item.platforms:
            rejected["platform"] += 1
            continue
        if context.required_permissions - set(item.permissions):
            rejected["permission"] += 1
            continue
        eligible.append(item)

    scored = []
    for item in eligible:
        score, reason = _score(context.query, item, dict(snapshot.skills))
        if score >= RECOMMENDATION_FLOOR:
            scored.append((score, item, reason))
    scored.sort(key=lambda row: (-row[0], row[1].name))
    recommendations = [
        {"name": item.name, "score": round(score, 3), "reason": reason,
         "category": item.category}
        for score, item, reason in scored[: max(1, context.limit)]
    ]
    return {
        "context": {"name": context.name, "query": context.query,
                    "platform": context.platform,
                    "required_permissions": sorted(context.required_permissions)},
        "authorized_count": len(authorized),
        "eligible_count": len(eligible),
        "recommended_count": len(recommendations),
        "rejected": rejected,
        "recommendations": recommendations,
        "fallback": not recommendations,
        "fallback_behavior": "保留完整授权短描述目录，不裁剪工具"
        if not recommendations else None,
    }


def _contexts(snapshot: CapabilitySnapshot) -> list[ProbeContext]:
    all_tools = frozenset(snapshot.tools)
    reduced = frozenset(name for name in all_tools if name not in {"shell", "delete_file", "delete_folder"})
    return [
        ProbeContext("天气查询", "查一下南京今天的天气和降雨", authorized_names=all_tools),
        ProbeContext("文件下载", "把这个网页文件下载到个人文件库", authorized_names=all_tools),
        ProbeContext("画布整理", "把福建便签放到城市节点旁边并连接起来", authorized_names=all_tools),
        ProbeContext("系统命令但无 shell 授权", "查看服务器磁盘空间和系统信息", authorized_names=reduced),
        ProbeContext("模糊闲聊", "今天有点累，陪我聊会儿", authorized_names=all_tools),
        ProbeContext("IM 平台天气", "在 QQ 里告诉我上海明天是否下雨", platform="qq", authorized_names=all_tools),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="只输出 JSON")
    parser.add_argument("--output", type=Path, help="将结果写入 JSON 文件")
    args = parser.parse_args()

    index = CapabilityIndex.from_registries()
    snapshot = index.snapshot()
    results = {
        "tool_count": len(snapshot.tools),
        "skill_count": len(snapshot.skills),
        "filter": {
            "authorization": "只允许 snapshot.tools 中的工具",
            "enabled": "禁用项不参与推荐",
            "platform": "指定平台不支持的工具不参与推荐",
            "permissions": "缺少 required_permissions 的工具不参与推荐",
            "confidence_floor": RECOMMENDATION_FLOOR,
            "recommendation_is_soft": True,
        },
        "cases": [recommend(snapshot, context) for context in _contexts(snapshot)],
    }
    payload = json.dumps(results, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    if args.json or not args.output:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
