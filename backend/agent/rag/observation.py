"""自动召回生命周期观测；后台迟到结果不能改写已结束的注入状态。"""
from contextvars import ContextVar
from dataclasses import dataclass, field
import time


@dataclass
class RecallObservation:
    started: float = field(default_factory=time.monotonic)
    sources: dict = field(default_factory=dict)
    result: dict = field(default_factory=dict)
    span: object = None
    finished: bool = False

    def source(self, name, stage, **values):
        if not self.finished:
            self.sources[name] = {**self.sources.get(name, {}), "stage": stage, **values}

    def finish(self, reason, *, injected=False, timeout_ms=None, pending=0):
        if self.finished:
            return
        self.finished = True
        output = {
            **self.result,
            "reason": reason, "injected": injected,
            "total_ms": round((time.monotonic() - self.started) * 1000, 3),
            "timeout_ms": timeout_ms, "pending_background_tasks": pending,
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
