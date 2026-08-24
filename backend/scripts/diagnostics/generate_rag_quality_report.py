#!/usr/bin/env python3
"""把 rag_quality_retest.py 的脱敏 JSON 结果转换为 Markdown 报告。"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path


def main() -> None:
    data = json.loads(Path(sys.argv[1]).read_text())
    out: list[str] = []
    out += [
        "# RAG 质量完整复测报告（2026-08-25）\n",
        "## 1. 结论摘要\n",
        "- 使用 devserver 当前真实 Memory 索引，10 个查询、owner + 2 个群作用域，共 30 个 scope-query 组合。",
        f"- owner {data['scopes'][0]['document_count']} 个文档中 {data['scopes'][0]['vector_count']} 个有当前 embedding 缓存；两个群作用域当前没有文档向量缓存，因此群作用域实际走 BM25 回退。",
        "- owner 的 BM25 与 hybrid 前 20 名集合完全一致；向量 Top20 与 BM25 的集合重叠较低，说明向量会明显改变排序，但本轮没有人工相关性标注，不能据此断言向量更准。",
        "- `normalized_score >= 0.35` 只作为离线模拟：owner 几乎不过滤，群作用域会过滤约 40%，不适合直接作为全局硬过滤。\n",
        "## 2. 测试前提\n",
        "| 项目 | 值 |\n|---|---|",
        "| 环境 | devserver（真实配置、只读） |",
        f"| Embedding | `{data['embedding_model']}` |",
        f"| 查询数 | {data['query_count']} |",
        f"| 作用域 | {data['scope_count']}（owner、两个活跃群作用域；正文和标识不写入） |",
        "| 候选数 | 每个模式最多 Top20；下文逐项展示 Top5 |",
        "| 写入 | 无；不修改记忆、索引、向量或线上阈值 |",
        "| 脚本 | `backend/scripts/diagnostics/rag_quality_retest.py` |\n",
        "查询集合：`GTA 6`、`画布 卡片`、`项目文件`、`提醒`、`图片搜索`、`记忆`、`最近好玩的游戏`、`搜索工具`、`日历安排`、`当前工作计划`。\n",
        "## 3. 索引与向量覆盖\n",
        "| 作用域 | 文档数 | 匹配向量数 | 覆盖率 | 线上策略 |\n|---|---:|---:|---:|---|",
    ]
    for scope in data["scopes"]:
        docs, vectors = scope["document_count"], scope["vector_count"]
        out.append(f"| {scope['scope_label']} | {docs} | {vectors} | {vectors / docs * 100:.2f}% | {'hybrid 可用' if vectors else 'BM25 回退'} |")
    out += [
        "\n> 群作用域当前没有文档向量缓存，但每次查询仍会生成 query embedding；由于没有候选向量，hybrid 按设计回退 BM25。这是本轮最重要的覆盖缺口。\n",
        "## 4. 量化结果\n",
        "| 作用域 | BM25↔Hybrid Top20 Jaccard | BM25↔Vector Top20 Jaccard | normalized ≥ 0.35 | 词法中位数/P95 ms | query embedding 中位数 ms |\n|---|---:|---:|---:|---:|---:|",
    ]
    for scope in data["scopes"]:
        bm_hybrid, bm_vector, kept, total, lexical, vector = [], [], 0, 0, [], []
        for query in scope["queries"]:
            bm = {item["chunk_fp"] for item in query["bm25"]}
            hybrid = {item["chunk_fp"] for item in query["hybrid"]}
            vectors = {item["chunk_fp"] for item in query["vector"]}
            bm_hybrid.append(len(bm & hybrid) / len(bm | hybrid) if bm | hybrid else 1)
            if vectors:
                bm_vector.append(len(bm & vectors) / len(bm | vectors))
            kept += sum(bool(item.get("keep_035")) for item in query["hybrid_normalized"])
            total += len(query["hybrid_normalized"])
            lexical.append(query["lexical_ms"])
            if query["vector_ms"] is not None:
                vector.append(query["vector_ms"])
        p95 = sorted(lexical)[max(0, int(len(lexical) * .95) - 1)]
        vector_jaccard = f"{statistics.mean(bm_vector) * 100:.1f}%" if bm_vector else "—"
        vector_median = f"{statistics.median(vector):.1f}" if vector else "—"
        out.append(f"| {scope['scope_label']} | {statistics.mean(bm_hybrid) * 100:.1f}% | {vector_jaccard} | {kept}/{total} ({kept / total * 100:.1f}%) | {statistics.median(lexical):.1f}/{p95:.1f} | {vector_median} |")
    out += [
        "\n指标含义：Top20 Jaccard 只衡量排序集合变化，不代表正确率；本轮没有人工 query-document 相关性标注，因此不虚构 Precision/Recall。\n",
        "## 5. 完整 Top5 结果（脱敏指纹）\n",
        "格式：`来源:chunk_fp/raw/norm`；`norm` 为本次候选集合内 hybrid 分数归一化，`*` 表示通过 `>=0.35` 模拟门槛。正文、用户标识和 scope 原值均未输出。\n",
    ]
    for scope in data["scopes"]:
        out.append(f"### {scope['scope_label']}\n")
        for query in scope["queries"]:
            out.append(f"#### {query['label']}（query_fp `{query['query_fp']}`）")
            def render(items, normalized=False):
                if not items:
                    return "（无）"
                values = []
                for item in items[:5]:
                    text = f"{item['source']}:{item['chunk_fp']}/{item['raw']:.3f}"
                    if normalized:
                        text += f"/{item.get('norm', 0):.3f}{'*' if item.get('keep_035') else ''}"
                    values.append(text)
                return "；".join(values)
            out.append(f"- BM25：{render(query['bm25'])}")
            out.append(f"- Vector：{render(query['vector'])}")
            out.append(f"- Hybrid：{render(query['hybrid_normalized'], True)}\n")
    out += [
        "## 6. 质量限制方案讨论\n",
        "### 不建议\n",
        "- 不跨 BM25、cosine、hybrid 直接比较 raw score；三者量纲和候选集合不同。",
        "- 不只用 `normalized_score >= 0.35` 做全局硬过滤；本轮 owner 几乎不过滤，而群作用域会过滤约 40%，且没有标注证明被过滤项一定不相关。\n",
        "### 建议两阶段方案\n",
        "1. 每个 scope、每种检索策略独立计算 raw score；hybrid 只在候选向量完整时启用，否则明确标记 BM25 fallback。",
        "2. 使用 normalized score 做相对门槛，同时加入检索器专属绝对下限；低于任一门槛不注入，但至少保留最高分 1 条。",
        "3. 先 dry-run 记录分数分布、过滤数量和用户追问，再用人工标注校准 BM25/vector/hybrid 各自的绝对下限。",
        "4. 先补齐群作用域文档向量缓存，再评估群聊 hybrid；当前群聊数据不能证明 embedding 质量。",
        "5. 灰度顺序：只记录 → owner 过滤 → 群 scope 有向量且有标注后再独立校准。\n",
        "建议初始保护规则（未上线）：\n\n```text\nkeep = top_score\n    or (normalized_score >= 0.35 and absolute_score >= retriever_floor)\n    or (候选数很少且没有明显负相关信号)\n```\n\n`retriever_floor` 必须按 BM25、vector、hybrid 分开维护；owner/group 只影响校准参数，不改变权限边界。\n",
        "## 7. 限制与后续\n",
        "- 本轮是覆盖常见语义的诊断集，不是人工标注集；集合重叠率不能当成 Precision/Recall。",
        "- owner 有 1 个文档缺少匹配向量，需继续查明其来源和缓存失效原因。",
        "- 两个群作用域没有文档向量缓存，需在群记忆索引更新/管理员重建时补建 scope vectors。",
        "- 下一轮建议建立 30～50 条脱敏 query-document 标注，测 Precision@5/10、Recall@20、过滤误杀率和注入字符成本。\n",
    ]
    print("\n".join(out))


if __name__ == "__main__":
    main()
