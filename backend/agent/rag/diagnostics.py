"""RAG 脱敏诊断，只记录结构和耗时，不记录查询或记忆正文。"""
from __future__ import annotations

import json
import logging
import time
import hashlib


_log = logging.getLogger("agent.rag")


def record_recall(*, namespace: str, source_type: str, candidate_count: int,
                  hit_count: int, elapsed_ms: int, fallback_reason: str | None,
                  index_version: str, mode: str = "tool", scope_type: str = "owner",
                  scope_key: str = "", injected: bool | None = None,
                  engine: str = "unknown", cache_hit: bool | None = None,
                  sidecar_reused: bool | None = None,
                  cache_entries: int | None = None,
                  cache_miss_reasons: list[str] | None = None,
                  quality: dict[str, object] | None = None,
                  stages: dict[str, object] | None = None) -> None:
    """记录脱敏召回日志和 LoopScope span。"""
    scope_digest = hashlib.sha256(scope_key.encode()).hexdigest()[:12] if scope_key else ""
    try:
        _log.info(json.dumps({
            "t": "rag",
            "namespace": namespace,
            "source_type": source_type,
            "mode": mode,
            "candidate_count": candidate_count,
            "hit_count": hit_count,
            "elapsed_ms": elapsed_ms,
            "fallback_reason": fallback_reason,
            "index_version": index_version,
            "scope_type": scope_type,
            "scope_digest": scope_digest,
            "injected": injected,
            "engine": engine,
            "cache_hit": cache_hit,
            "sidecar_reused": sidecar_reused,
            "cache_entries": cache_entries,
            "cache_miss_reasons": cache_miss_reasons or [],
            "quality": quality or {},
            "stages": stages or {},
        }, ensure_ascii=False))
    except Exception:
        pass
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
        stages=stages,
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
                             stages: dict[str, object] | None = None) -> None:
    """把召回指标写入当前 LoopScope run；绝不携带 query、正文或 owner。"""
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
            injected=injected,
            engine=engine,
            cache_hit=cache_hit,
            sidecar_reused=sidecar_reused,
            cache_entries=cache_entries,
            cache_miss_reasons=cache_miss_reasons or [],
            quality=quality or {},
            stages=stages or {},
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
            "injected": injected,
            "engine": engine,
            "cache_hit": cache_hit,
            "sidecar_reused": sidecar_reused,
            "cache_entries": cache_entries,
            "quality": quality or {},
            "stages": stages or {},
        })
    except Exception:
        # 可观测性不能阻塞 RAG 或主 Agent。
        pass


def record_index_update(*, source_type: str, operation: str, document_count: int,
                        attempt: int, success: bool, elapsed_ms: int) -> None:
    """记录索引生命周期指标，不记录 owner、查询或正文。"""
    try:
        _log.info(json.dumps({
            "t": "rag_index",
            "source_type": source_type,
            "operation": operation,
            "document_count": document_count,
            "attempt": attempt,
            "success": success,
            "elapsed_ms": elapsed_ms,
        }, ensure_ascii=False))
    except Exception:
        pass
