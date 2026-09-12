"""自动召回生命周期观测；后台迟到结果不能改写已结束的注入状态。"""
import asyncio
import copy
import json
import logging
import os
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field


_probe_log = logging.getLogger("agent.rag.probe")


@dataclass
class RecallObservation:
    started: float = field(default_factory=time.monotonic)
    sources: dict = field(default_factory=dict)
    result: dict = field(default_factory=dict)
    span: object = None
    finished: bool = False
    backend_worker_pid: int = field(default_factory=os.getpid)
    probe_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    probe: dict = field(default_factory=lambda: {"stage_ms": {}, "metrics": {}})
    _probe_phase_started: float | None = None
    _probe_timed_out: bool = False
    _probe_timeout_at: float | None = None
    _probe_logged: bool = False

    def source(self, name, stage, **values):
        if not self.finished:
            self.sources[name] = {**self.sources.get(name, {}), "stage": stage, **values}

    def start_probe_phase(self, phase: str) -> None:
        self.probe["phase"] = phase
        self._probe_phase_started = time.monotonic()

    def finish_probe_phase(self, phase: str, elapsed_ms: int, **values) -> None:
        self.probe.setdefault("stage_ms", {})[phase] = max(0, int(elapsed_ms))
        if self.probe.get("phase") == phase:
            self.probe["phase"] = ""
            self._probe_phase_started = None
        if values:
            self.probe.setdefault("metrics", {}).update(values)

    def update_probe(self, **values) -> None:
        metrics = self.probe.setdefault("metrics", {})
        for key, value in values.items():
            if isinstance(value, dict) and isinstance(metrics.get(key), dict):
                metrics[key].update(value)
            else:
                metrics[key] = value

    def complete_probe(self, outcome: str, **values) -> None:
        self.probe["outcome"] = outcome
        if values:
            self.probe.setdefault("metrics", {}).update(values)
        if self._probe_timed_out and not self._probe_logged:
            current_phase_ms = None
            if self._probe_phase_started is not None:
                current_phase_ms = max(0, int((time.monotonic() - self._probe_phase_started) * 1000))
            payload = {
                "event": "rag_probe_late_completion",
                "probe_id": self.probe_id,
                "backend_worker_pid": self.backend_worker_pid,
                "outcome": outcome,
                "elapsed_after_timeout_ms": (
                    max(0, int((time.monotonic() - self._probe_timeout_at) * 1000))
                    if self._probe_timeout_at is not None else None
                ),
                "phase": self.probe.get("phase", ""),
                "phase_elapsed_ms": current_phase_ms,
                "stage_ms": dict(self.probe.get("stage_ms", {})),
                "metrics": copy.deepcopy(self.probe.get("metrics", {})),
            }
            _probe_log.info("RAG_PROBE %s", json.dumps(payload, ensure_ascii=False, sort_keys=True))
            self._probe_logged = True

    def finish(self, reason, *, injected=False, timeout_ms=None, pending=0):
        if self.finished:
            return
        self.finished = True
        if reason == "timeout":
            self._probe_timed_out = True
            self._probe_timeout_at = time.monotonic()
        probe = copy.deepcopy(self.probe)
        probe["probe_id"] = self.probe_id
        probe["backend_worker_pid"] = self.backend_worker_pid
        if self._probe_phase_started is not None:
            probe["phase_elapsed_ms"] = max(
                0, int((time.monotonic() - self._probe_phase_started) * 1000),
            )
        output = {
            **self.result,
            "reason": reason, "injected": injected,
            "total_ms": round((time.monotonic() - self.started) * 1000, 3),
            "timeout_ms": timeout_ms, "pending_background_tasks": pending,
            "probe": probe,
            "pending_sources": [name for name, value in self.sources.items()
                                if value.get("stage") not in {"completed", "error", "cancelled"}],
            "source_progress": {name: dict(value) for name, value in self.sources.items()},
        }
        try:
            if self.span is not None:
                self.span.attributes.update({key: value for key, value in output.items()
                                             if key not in {"source_progress", "stages"}})
                self.span.finish(output, status="success" if reason == "completed" else "error")
        except Exception:
            pass


current_recall: ContextVar[RecallObservation | None] = ContextVar("rag_observation", default=None)


def begin_recall():
    observation = RecallObservation()
    try:
        from agent.runtime.loopscope_trace.state import _enabled, _scope_run
        run = _scope_run.get()
        if _enabled() and run is not None and run.ended_at is None:
            observation.span = run.span("rag", "Knowledge RAG recall", {"mode": "automatic"})
    except Exception:
        pass
    return observation, current_recall.set(observation)


def progress(source, stage, **values):
    observation = current_recall.get()
    if observation is not None:
        observation.source(source, stage, **values)


def probe_start(phase: str) -> None:
    observation = current_recall.get()
    if observation is not None:
        observation.start_probe_phase(phase)


def probe_finish(phase: str, started: float, **values) -> None:
    observation = current_recall.get()
    if observation is not None:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        observation.finish_probe_phase(phase, elapsed_ms, **values)


def probe_update(**values) -> None:
    observation = current_recall.get()
    if observation is not None:
        observation.update_probe(**values)


def probe_complete(outcome: str, **values) -> None:
    observation = current_recall.get()
    if observation is not None:
        observation.complete_probe(outcome, **values)


async def await_probe(phase: str, awaitable, *, terminal_on_error: bool = False, **metadata):
    """给自动召回的一个等待点计时；trace 只记录阶段名和非正文诊断值。"""
    observation = current_recall.get()
    started = time.monotonic()
    if observation is not None:
        observation.start_probe_phase(phase)
        if metadata:
            observation.update_probe(**metadata)
    try:
        result = await awaitable
    except BaseException as exc:
        if observation is not None:
            observation.finish_probe_phase(
                phase, int((time.monotonic() - started) * 1000),
                **{"outcome": "cancelled" if isinstance(exc, asyncio.CancelledError) else "error",
                   "error_type": type(exc).__name__},
            )
            if terminal_on_error:
                observation.complete_probe(
                    "cancelled" if isinstance(exc, asyncio.CancelledError) else "error",
                    error_type=type(exc).__name__,
                )
        raise
    if observation is not None:
        observation.finish_probe_phase(phase, int((time.monotonic() - started) * 1000))
    return result
