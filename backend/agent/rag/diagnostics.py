"""RAG 脱敏诊断；普通诊断不记录正文，受控 LoopScope 可记录排序 token 明细。"""
from __future__ import annotations

import time
import hashlib


def record_recall(*, namespace: str, source_type: str, candidate_count: int,
                  hit_count: int, elapsed_ms: int, fallback_reason: str | None,
                  index_version: str, mode: str = "tool", scope_type: str = "owner",
                  scope_key: str = "", injected: bool | None = None,
                  engine: str = "unknown", cache_hit: bool | None = None,
                  sidecar_reused: bool | None = None,
                  cache_entries: int | None = None,
                  cache_miss_reasons: list[str] | None = None,
                  quality: dict[str, object] | None = None,
                  rank_details: list[dict[str, object]] | None = None,
                  stages: dict[str, object] | None = None,
                  source_diagnostics: dict[str, object] | None = None,
                  scope_details: list[dict[str, object]] | None = None) -> None:
    """记录脱敏召回日志和 LoopScope span。"""
    scope_digest = hashlib.sha256(scope_key.encode()).hexdigest()[:12] if scope_key else ""
    from agent.rag.observation import current_recall
    observation = current_recall.get()
    if observation is not None:
        if not observation.finished:
            observation.result = {
                "candidate_count": candidate_count, "hit_count": hit_count,
                "elapsed_ms": elapsed_ms, "fallback_reason": fallback_reason,
                "engine": engine, "cache_hit": cache_hit,
                "sidecar_reused": sidecar_reused, "cache_entries": cache_entries,
                "cache_miss_reasons": cache_miss_reasons or [],
                "quality": quality or {}, "stages": stages or {},
                "rank_details": rank_details or [],
                "source_diagnostics": source_diagnostics or {},
                "scope_type": scope_type, "scope_digest": scope_digest,
                "scope_details": scope_details or [], "index_version": index_version,
            }
        return
    # 正常召回的明细只进入 LoopScope，避免每轮把完整阶段耗时和候选统计写入主日志。
    _record_loopscope_recall(
        namespace=namespace,
        source_type=source_type,
        candidate_count=candidate_count,
        hit_count=hit_count,
        elapsed_ms=elapsed_ms,
        fallback_reason=fallback_reason,
        index_version=index_version,
        mode=mode,
        scope_type=scope_type,
        scope_digest=scope_digest,
        injected=injected,
        engine=engine,
        cache_hit=cache_hit,
        sidecar_reused=sidecar_reused,
        cache_entries=cache_entries,
        cache_miss_reasons=cache_miss_reasons,
        quality=quality,
        rank_details=rank_details,
        stages=stages,
        source_diagnostics=source_diagnostics,
        scope_details=scope_details,
    )


def _record_loopscope_recall(*, namespace: str, source_type: str,
                             candidate_count: int, hit_count: int,
                             elapsed_ms: int, fallback_reason: str | None,
                             index_version: str, mode: str, scope_type: str = "owner",
                             scope_digest: str = "", injected: bool | None = None,
                             engine: str = "unknown", cache_hit: bool | None = None,
                             sidecar_reused: bool | None = None,
                             cache_entries: int | None = None,
                             cache_miss_reasons: list[str] | None = None,
                             quality: dict[str, object] | None = None,
                             rank_details: list[dict[str, object]] | None = None,
                             stages: dict[str, object] | None = None,
                             source_diagnostics: dict[str, object] | None = None,
                             scope_details: list[dict[str, object]] | None = None) -> None:
    """把召回指标写入当前 LoopScope run；排序明细只进入受控 trace。"""
    try:
        from agent.runtime.loopscope_trace.state import _scope_run, _enabled

        if not _enabled():
            return
        run = _scope_run.get()
        if run is None or run.ended_at is not None:
            return
        span = run.span(
            "rag",
            "Knowledge RAG recall",
            {
                "namespace": namespace,
                "source_type": source_type,
                "mode": mode,
            },
            token_impact={
                "candidate_count": int(candidate_count),
                "hit_count": int(hit_count),
            },
            namespace=namespace,
            source_type=source_type,
            mode=mode,
            scope_type=scope_type,
            scope_digest=scope_digest,
            scope_details=scope_details or [],
            injected=injected,
            engine=engine,
            cache_hit=cache_hit,
            sidecar_reused=sidecar_reused,
            cache_entries=cache_entries,
            cache_miss_reasons=cache_miss_reasons or [],
            quality=quality or {},
            rank_details=rank_details or [],
            stages=stages or {},
            source_diagnostics=source_diagnostics or {},
            fallback_reason=fallback_reason or "",
            index_version=index_version,
        )
        # 召回已经结束才创建 span，回填真实耗时，避免把诊断代码耗时算进来。
        span.started_at = time.time() - max(0, int(elapsed_ms)) / 1000
        span.finish({
            "candidate_count": int(candidate_count),
            "hit_count": int(hit_count),
            "fallback_reason": fallback_reason,
            "index_version": index_version,
            "scope_type": scope_type,
            "scope_digest": scope_digest,
            "scope_details": scope_details or [],
            "injected": injected,
            "engine": engine,
            "cache_hit": cache_hit,
            "sidecar_reused": sidecar_reused,
            "cache_entries": cache_entries,
            "quality": quality or {},
            "rank_details": rank_details or [],
            "stages": stages or {},
            "source_diagnostics": source_diagnostics or {},
        })
    except Exception:
        # 可观测性不能阻塞 RAG 或主 Agent。
        pass


def record_index_update(*, source_type: str, operation: str, document_count: int,
                        attempt: int, success: bool, elapsed_ms: int,
                        mode: str = "source_replace",
                        upsert_count: int | None = None,
                        delete_count: int | None = None,
                        projection_ms: int | None = None,
                        status: str | None = None,
                        base_revision_match: bool | None = None) -> None:
    """记录索引生命周期指标（PRD-RAG-9 §9）；不记录 owner、查询或正文。

    ``mode`` 区分 document_patch / source_replace；``status`` 使用 ready/failed/
    revision_mismatch/no_change 等固定分类，不携带异常详情。
    """
    payload = {
        "t": "rag_index",
        "source_type": source_type,
        "operation": operation,
        "mode": mode,
        "document_count": document_count,
        "attempt": attempt,
        "success": success,
        "elapsed_ms": elapsed_ms,
    }
    if upsert_count is not None:
        payload["upsert_count"] = upsert_count
    if delete_count is not None:
        payload["delete_count"] = delete_count
    if projection_ms is not None:
        payload["projection_ms"] = projection_ms
    if status is not None:
        payload["status"] = status
    if base_revision_match is not None:
        payload["base_revision_match"] = base_revision_match
    try:
        _log.info(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass
