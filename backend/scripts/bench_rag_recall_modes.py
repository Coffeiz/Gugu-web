"""自动召回全链路冷/热/并发基准：对比 legacy 与 batch 词法查询模式。

只驱动 search_knowledge 主链（准备、排队、检索、排序、注入组装），不调用 LLM
意图路由与重排。每个模式用独立进程执行（保证冷启动口径一致），结果签名写入
JSON 供跨模式等价对比。不修改任何运行配置文件；模式切换仅在进程内存内生效。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from pathlib import Path

DEFAULT_QUERIES = (
    "最近的画布内容",
    "项目进度安排",
    "文件里的结论",
    "之前聊过的方案",
    "备忘录要点",
    "知识库里的说明",
)


def percentile(values: list[float], ratio: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(ratio * (len(ordered) - 1))))
    return int(round(ordered[index]))


def result_signature(result: dict) -> list:
    """最终排序、引用与文本的稳定签名；不含任何耗时或置信度随机项。"""
    return [
        {
            "source": item.get("source"),
            "chunk_id": item.get("chunk_id"),
            "text": item.get("text"),
            "confidence": item.get("confidence"),
            "citations": item.get("citations"),
        }
        for item in result.get("results", [])
    ]


async def run_mode(args, mode: str) -> dict:
    from app.core.config import get_settings

    get_settings().search.rag_query_mode = mode

    from agent.rag.service import search_knowledge

    def record(caller: str, elapsed_ms: float, result: dict | None, error: str | None = None):
        stage_ms = (result or {}).get("stage_ms") or {}
        entry = {"phase": caller, "total_ms": int(round(elapsed_ms)), "stage_ms": stage_ms}
        if error:
            entry["error"] = error
        return entry

    samples: list[dict] = []

    async def call(query: str, phase: str):
        started = time.monotonic()
        try:
            result = await search_knowledge(args.user_id, query, mode="automatic")
        except Exception as exc:  # noqa: BLE001 - 基准需要记录失败样本继续压测
            from app.core.redaction import diag_log

            diag_log("bench.rag_recall_modes", exc)
            samples.append(record(phase, (time.monotonic() - started) * 1000, None,
                                  type(exc).__name__))
            return None
        samples.append(record(phase, (time.monotonic() - started) * 1000, result))
        return result

    signatures: dict[str, list] = {}
    # 冷：进程内第一次调用，索引缓存与 sidecar 均未就绪。
    cold_query = DEFAULT_QUERIES[0]
    cold_result = await call(cold_query, "cold")
    if cold_result is not None:
        signatures[cold_query] = result_signature(cold_result)
    # 热：串行重复。
    for round_index in range(args.rounds):
        query = DEFAULT_QUERIES[(round_index + 1) % len(DEFAULT_QUERIES)]
        result = await call(query, "hot")
        if result is not None:
            signatures[query] = result_signature(result)
    # 并发：同一突发内的并行召回。
    for _ in range(max(1, args.concurrent_rounds)):
        results = await asyncio.gather(
            *(call(query, "concurrent") for query in DEFAULT_QUERIES[:args.concurrency])
        )
        for query, result in zip(DEFAULT_QUERIES[:args.concurrency], results):
            if result is not None:
                signatures[query] = result_signature(result)

    by_phase: dict[str, list[float]] = {"cold": [], "hot": [], "concurrent": []}
    stage_totals: dict[str, list[float]] = {}
    errors = 0
    for sample in samples:
        if sample.get("error"):
            errors += 1
            continue
        by_phase.setdefault(sample["phase"], []).append(sample["total_ms"])
        for key, value in (sample.get("stage_ms") or {}).items():
            stage_totals.setdefault(key, []).append(float(value or 0))
    summary = {
        "error_types": {
            name: samples_of_error
            for name, samples_of_error in sorted(
                (lambda counts: counts.items())(
                    {sample.get("error", ""): sum(
                        1 for item in samples if item.get("error") == sample.get("error", ""))
                        for sample in samples if sample.get("error")}
                )
            )
        },
        "mode": mode,
        "user_id": args.user_id,
        "rounds": args.rounds,
        "concurrency": args.concurrency,
        "errors": errors,
        "phases": {
            name: {
                "count": len(values),
                "p50_ms": percentile(values, 0.50),
                "p95_ms": percentile(values, 0.95),
                "max_ms": int(max(values)) if values else 0,
            }
            for name, values in by_phase.items() if values
        },
        "stage_ms_p50": {key: percentile(values, 0.50) for key, values in sorted(stage_totals.items())},
    }
    return {"summary": summary, "signatures": signatures}


def compare_outputs(left_path: Path, right_path: Path) -> dict:
    """对比两个模式的最终排序/引用/文本签名，报告逐查询差异。"""
    left = json.loads(left_path.read_text(encoding="utf-8"))
    right = json.loads(right_path.read_text(encoding="utf-8"))
    left_sigs = left.get("signatures", {})
    right_sigs = right.get("signatures", {})
    queries = sorted(set(left_sigs) | set(right_sigs))
    report = {"left_mode": left.get("summary", {}).get("mode"),
              "right_mode": right.get("summary", {}).get("mode"), "queries": []}
    equal_count = 0
    for query in queries:
        left_sig, right_sig = left_sigs.get(query), right_sigs.get(query)
        equal = left_sig == right_sig and left_sig is not None
        equal_count += 1 if equal else 0
        diff = {"query": query, "equal": equal}
        if not equal:
            diff["left_count"] = len(left_sig or [])
            diff["right_count"] = len(right_sig or [])
            diff["left_chunks"] = [item["chunk_id"] for item in left_sig or []]
            diff["right_chunks"] = [item["chunk_id"] for item in right_sig or []]
            diff["first_text_mismatch"] = next(
                (index for index, (one, two) in enumerate(zip(left_sig or [], right_sig or []))
                 if one.get("text") != two.get("text")), None)
        report["queries"].append(diff)
    report["equal_queries"] = equal_count
    report["total_queries"] = len(queries)
    report["all_equal"] = equal_count == len(queries) and bool(queries)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", default=None)
    parser.add_argument("--mode", default="legacy", choices=["legacy", "batch", "batch_shadow"])
    parser.add_argument("--rounds", type=int, default=20)
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--concurrent-rounds", type=int, default=3)
    parser.add_argument("--out", type=Path, default=None, help="结果 JSON 输出路径")
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("LEFT", "RIGHT"),
                        help="对比两份结果 JSON 的最终排序等价性")
    args = parser.parse_args()

    if args.compare:
        print(json.dumps(compare_outputs(args.compare[0], args.compare[1]),
                         ensure_ascii=False, indent=2))
        return
    if not args.user_id:
        parser.error("基准运行需要 --user-id")
    result = asyncio.run(run_mode(args, args.mode))
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))
    if args.out:
        args.out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
