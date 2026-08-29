"""定时任务引擎（APScheduler · AsyncIOScheduler）。

**单实例运行**：挂在 worker 进程里（worker 天生单例，避免 web 多 uvicorn worker 各自
重复跑——也呼应「周期任务单实例化」的进程优化）。web 进程不 start，故不会重复。

任务来源是 **DB 驱动**（`scheduled_tasks` 表）：worker.serve() 里 `start()` 起 scheduler，
再由 `app.scheduled_tasks.reconcile()` 每 ~30s 从 DB 把任务同步成 APScheduler job（用 `get()`
拿底层 scheduler 增删）。下面的 `register/cron/every` 是给「代码内置周期任务」预留的轻量入口，
当前没有内置任务（全 DB 驱动）。

> 多 worker 时（未来）会重复触发——届时给 job 执行加 Redis leader 锁即可，上层不动。
"""
from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

_sched: AsyncIOScheduler | None = None
_pending: list = []   # [(fn, trigger, id, name)]，start() 前累积注册


def register(trigger, id: str, name: str = ""):
    """装饰器：注册一个定时 job。trigger 用 cron()/every()。"""
    def deco(fn):
        _pending.append((fn, trigger, id, name or id))
        return fn
    return deco


def cron(**kw) -> CronTrigger:
    """如 cron(hour=9, minute=0)；时区跟随 scheduler（Asia/Shanghai）。"""
    return CronTrigger(**kw)


def every(**kw) -> IntervalTrigger:
    """如 every(minutes=30) / every(hours=1)。"""
    return IntervalTrigger(**kw)


def start() -> AsyncIOScheduler:
    """把累积注册的 job 全挂上并启动（需在运行中的 asyncio loop 内调用）。幂等。"""
    global _sched
    if _sched is not None:
        return _sched
    _sched = AsyncIOScheduler(timezone="Asia/Shanghai")
    for fn, trig, jid, name in _pending:
        _sched.add_job(fn, trig, id=jid, name=name,
                       replace_existing=True, max_instances=1, coalesce=True)
    _sched.start()
    print(
        f"[scheduler] started · {len(_pending)} builtin jobs: {[p[2] for p in _pending]} "
        "(DB tasks are attached by scheduled_tasks.reconcile)",
        flush=True,
    )
    return _sched


def get():
    """返回底层 AsyncIOScheduler（None 表示未启动）；DB 驱动 reconcile 用它增删 job。"""
    return _sched


def jobs() -> list:
    """当前已挂的 job（给服务面板/调试看）。"""
    return _sched.get_jobs() if _sched else []


def shutdown() -> None:
    global _sched
    if _sched is not None:
        _sched.shutdown(wait=False)
        _sched = None
