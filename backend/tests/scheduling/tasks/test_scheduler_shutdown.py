"""scheduler 关闭时必须等待正在执行的 job 释放资源。"""

from app.core import scheduler


def test_scheduler_shutdown_waits_for_running_jobs(monkeypatch):
    calls: list[bool] = []

    class FakeScheduler:
        def shutdown(self, wait=True):
            calls.append(wait)

    monkeypatch.setattr(scheduler, "_sched", FakeScheduler())

    scheduler.shutdown()

    assert calls == [True]
    assert scheduler._sched is None
