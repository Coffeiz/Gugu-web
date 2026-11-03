"""按数据库变更事件管理每个用户 Bot 的网关子进程。

平台凭据保存在 ``user_bots``，通过进程环境变量注入子进程，不进入 argv。
PostgreSQL trigger 在连接配置变更提交后发送 ``LISTEN/NOTIFY``；频道管家在
启动和订阅重连时全量对账，日常只处理配置通知和子进程退出事件。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import os
import signal
import sys
import time
from typing import Any

from app.core.redaction import diag_log

RELOAD_CHANNEL = "im_gateway_reload"
PLATFORM_MODULE = {
    "feishu": "agent.gateway.feishu",
    "qq": "agent.gateway.qq",
    "wechat": "agent.gateway.wechat",
    "telegram": "agent.gateway.telegram",
}

FAST_CRASH_SEC = 5
BACKOFF_BASE_SEC = 10
BACKOFF_MAX_SEC = 300
RECONCILE_RETRY_BASE_SEC = 5
RECONCILE_RETRY_MAX_SEC = 60


@dataclass
class ManagedBot:
    spec: dict[str, Any]
    process: asyncio.subprocess.Process
    started_at: float
    monitor: asyncio.Task | None = None


_procs: dict[str, ManagedBot] = {}
_desired_specs: dict[str, dict[str, Any]] = {}
_fail_count: dict[str, int] = {}
_retry_tasks: dict[str, asyncio.Task] = {}
_retry_specs: dict[str, dict[str, Any]] = {}
_reconcile_lock: asyncio.Lock | None = None
_reload_queue: asyncio.Queue[None] | None = None
_stop_event: asyncio.Event | None = None
_reconcile_retry_task: asyncio.Task | None = None
_reconcile_retry_delay = RECONCILE_RETRY_BASE_SEC


def _queue_reconcile() -> None:
    queue = _reload_queue
    if queue is None or queue.full():
        return
    queue.put_nowait(None)


async def _fetch_userbots() -> list[dict[str, Any]]:
    import app.db.session as S
    from sqlalchemy import select

    from app.models import UserBot
    from app.services.im_platforms import is_im_platform_enabled

    S.ensure_engine()
    async with S._SessionLocal() as db:
        rows = (await db.execute(
            select(UserBot).where(UserBot.enabled.is_(True))
        )).scalars().all()
        return [{
            "id": str(bot.id),
            "platform": bot.platform,
            "app_id": bot.app_id,
            "app_secret": bot.app_secret,
            "sandbox": bot.sandbox,
            "owner": str(bot.user_id),
        } for bot in rows if is_im_platform_enabled(bot.platform)]


def _spawn_environment(spec: dict[str, Any]) -> dict[str, str]:
    env = {**os.environ}
    platform = spec["platform"]
    if platform == "feishu":
        env.update({
            "FEISHU_BOT_ID": spec["id"],
            "FEISHU_APP_ID": spec["app_id"],
            "FEISHU_APP_SECRET": spec["app_secret"],
            "FEISHU_OWNER": spec["owner"],
        })
    elif platform == "wechat":
        env.update({
            "WECHAT_BOT_ID": spec["id"],
            "WECHAT_BOT_TOKEN": spec["app_secret"],
            "WECHAT_BASE_URL": spec["app_id"],
            "WECHAT_OWNER": spec["owner"],
        })
    elif platform == "telegram":
        env.update({
            "TELEGRAM_BOT_ID": spec["id"],
            "TELEGRAM_BOT_TOKEN": spec["app_secret"],
            "TELEGRAM_OWNER": spec["owner"],
        })
    else:
        env.update({
            "QQ_BOT_ID": spec["id"],
            "QQ_APP_ID": spec["app_id"],
            "QQ_APP_SECRET": spec["app_secret"],
            "QQ_SANDBOX": "1" if spec["sandbox"] else "0",
            "QQ_OWNER": spec["owner"],
        })
    return env


async def _spawn(key: str, spec: dict[str, Any]) -> ManagedBot:
    module = PLATFORM_MODULE[spec["platform"]]
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", module, env=_spawn_environment(spec),
        )
    except Exception as exc:
        diag_log("agent.gateway.spawn", exc)
        _schedule_bot_retry(key, spec, _next_backoff(key))
        print(f"[gateway] 启动 {key} 失败：{type(exc).__name__}", flush=True)
        raise

    managed = ManagedBot(spec=spec, process=process, started_at=time.monotonic())
    _procs[key] = managed
    managed.monitor = asyncio.create_task(_monitor_process(key, managed))
    print(f"[gateway] ▶ 启动 {key}", flush=True)
    return managed


def _next_backoff(key: str) -> float:
    failures = _fail_count.get(key, 0) + 1
    _fail_count[key] = failures
    return min(BACKOFF_BASE_SEC * (2 ** (failures - 1)), BACKOFF_MAX_SEC)


def _schedule_bot_retry(key: str, spec: dict[str, Any], delay: float) -> None:
    current = _retry_tasks.get(key)
    if current is not None and not current.done():
        return
    _retry_specs[key] = spec

    async def retry_after_delay() -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            raise
        finally:
            if _retry_tasks.get(key) is asyncio.current_task():
                _retry_tasks.pop(key, None)
                _retry_specs.pop(key, None)
        if _stop_event is None or not _stop_event.is_set():
            _queue_reconcile()

    _retry_tasks[key] = asyncio.create_task(retry_after_delay())


async def _cancel_bot_retry(key: str) -> None:
    task = _retry_tasks.pop(key, None)
    _retry_specs.pop(key, None)
    if task is None or task is asyncio.current_task():
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def _terminate_process(managed: ManagedBot) -> None:
    process = managed.process
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
    monitor = managed.monitor
    if monitor is not None and monitor is not asyncio.current_task():
        await asyncio.gather(monitor, return_exceptions=True)


async def _monitor_process(key: str, managed: ManagedBot) -> None:
    await managed.process.wait()
    lock = _reconcile_lock
    if lock is None:
        return
    async with lock:
        if _procs.get(key) is not managed:
            return
        _procs.pop(key, None)
        if _stop_event is None or _stop_event.is_set():
            return
        desired_spec = _desired_specs.get(key)
        if desired_spec is None or desired_spec != managed.spec:
            _queue_reconcile()
            return

        lived = time.monotonic() - managed.started_at
        if lived < FAST_CRASH_SEC:
            delay = _next_backoff(key)
            print(
                f"[gateway] {key} 启动后 {lived:.1f}s 内退出（连续秒崩 {_fail_count[key]} 次），"
                f"{delay:.0f}s 后重试",
                flush=True,
            )
            _schedule_bot_retry(key, managed.spec, delay)
            return

        _fail_count.pop(key, None)
        _queue_reconcile()


def _schedule_reconcile_retry() -> None:
    global _reconcile_retry_task, _reconcile_retry_delay
    if _reconcile_retry_task is not None and not _reconcile_retry_task.done():
        return
    delay = _reconcile_retry_delay
    _reconcile_retry_delay = min(delay * 2, RECONCILE_RETRY_MAX_SEC)

    async def retry_after_delay() -> None:
        global _reconcile_retry_task
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            raise
        finally:
            if _reconcile_retry_task is asyncio.current_task():
                _reconcile_retry_task = None
        if _stop_event is None or not _stop_event.is_set():
            _queue_reconcile()

    _reconcile_retry_task = asyncio.create_task(retry_after_delay())


async def _cancel_reconcile_retry() -> None:
    global _reconcile_retry_task, _reconcile_retry_delay
    task = _reconcile_retry_task
    _reconcile_retry_task = None
    _reconcile_retry_delay = RECONCILE_RETRY_BASE_SEC
    if task is None or task is asyncio.current_task():
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def reconcile() -> bool:
    """读取一次权威配置并收敛进程状态；数据库故障时保留当前进程。"""
    lock = _reconcile_lock
    if lock is None:
        raise RuntimeError("gateway supervisor is not initialized")
    async with lock:
        try:
            bots = await _fetch_userbots()
        except Exception as exc:
            diag_log("agent.gateway.fetch_userbots", exc)
            print(f"[gateway] 读取 user_bots 失败：{type(exc).__name__}（保持现状）", flush=True)
            _schedule_reconcile_retry()
            return False

        desired = {
            f"{bot['platform']}:{bot['id']}": bot
            for bot in bots
            if bot["platform"] in PLATFORM_MODULE
        }
        _desired_specs.clear()
        _desired_specs.update(desired)
        await _cancel_reconcile_retry()

        for key in list(_procs):
            if key in desired:
                continue
            managed = _procs.pop(key)
            await _terminate_process(managed)
            _fail_count.pop(key, None)
            print(f"[gateway] ■ 停止 {key}", flush=True)

        for key in set(_retry_tasks) - set(desired):
            await _cancel_bot_retry(key)
            _fail_count.pop(key, None)

        for key, spec in desired.items():
            retry_task = _retry_tasks.get(key)
            if retry_task is not None and not retry_task.done():
                if _retry_specs.get(key) == spec:
                    continue
                await _cancel_bot_retry(key)
                _fail_count.pop(key, None)

            managed = _procs.get(key)
            if managed is not None and managed.spec == spec and managed.process.returncode is None:
                continue
            if managed is not None:
                _procs.pop(key, None)
                await _terminate_process(managed)
                _fail_count.pop(key, None)

            try:
                await _spawn(key, spec)
            except Exception:
                # _spawn 已安排带退避的单次重试；继续收敛其他 Bot。
                continue
        return True


async def _open_config_listener() -> tuple[Any, asyncio.Event]:
    import asyncpg

    from app.core.config import get_settings

    db_settings = get_settings().db
    connection = await asyncpg.connect(
        host=db_settings.host,
        port=db_settings.port,
        user=db_settings.user,
        password=db_settings.password,
        database=db_settings.name,
        timeout=10,
    )
    disconnected = asyncio.Event()

    def on_notification(_connection, _pid, _channel, _payload) -> None:
        _queue_reconcile()

    def on_termination(_connection) -> None:
        disconnected.set()

    await connection.add_listener(RELOAD_CHANNEL, on_notification)
    connection.add_termination_listener(on_termination)
    return connection, disconnected


async def _wait_for_listener(connection: Any, disconnected: asyncio.Event) -> bool:
    assert _stop_event is not None
    stopped = asyncio.create_task(_stop_event.wait())
    lost = asyncio.create_task(disconnected.wait())
    done, pending = await asyncio.wait(
        (stopped, lost), return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    return stopped in done and stopped.result()


async def _listen_for_config_changes(ready: asyncio.Event) -> None:
    """订阅 PostgreSQL 通知；每次重连都触发全量对账补回离线期间的变化。"""
    assert _stop_event is not None
    reconnected = False
    retry_delay = 1.0
    while not _stop_event.is_set():
        connection = None
        try:
            connection, disconnected = await _open_config_listener()
            if reconnected:
                _queue_reconcile()
            reconnected = True
            retry_delay = 1.0
            ready.set()
            if await _wait_for_listener(connection, disconnected):
                return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            diag_log("agent.gateway.config_listener", exc)
            print(f"[gateway] 数据库通知订阅暂不可用：{type(exc).__name__}", flush=True)
        finally:
            if connection is not None and not connection.is_closed():
                try:
                    await connection.close()
                except Exception as exc:
                    diag_log("agent.gateway.config_listener.close", exc)

        if _stop_event.is_set():
            return
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=retry_delay)
        except asyncio.TimeoutError:
            pass
        retry_delay = min(retry_delay * 2, 60.0)


async def _heartbeat_loop() -> None:
    from app.core import health

    assert _stop_event is not None
    while not _stop_event.is_set():
        gateways = [
            {
                "key": key,
                "platform": managed.spec["platform"],
                "owner": managed.spec["owner"],
            }
            for key, managed in _procs.items()
        ]
        await health.beat("gateway", {"gateways": gateways, "count": len(gateways)})
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=health.INTERVAL)
        except asyncio.TimeoutError:
            pass


async def _shutdown() -> None:
    global _reconcile_retry_task
    retry_tasks = list(_retry_tasks.values())
    for task in retry_tasks:
        task.cancel()
    _retry_tasks.clear()
    _retry_specs.clear()
    await asyncio.gather(*retry_tasks, return_exceptions=True)
    if _reconcile_retry_task is not None:
        _reconcile_retry_task.cancel()
        _reconcile_retry_task = None

    managed_bots = list(_procs.items())
    _procs.clear()
    for key, managed in managed_bots:
        print(f"[gateway] ■ 停止 {key}", flush=True)
        await _terminate_process(managed)

    import app.db.session as S

    await S.dispose_engine()
    print("[gateway] 已停止", flush=True)


async def _run() -> None:
    global _reconcile_lock, _reload_queue, _stop_event

    from app.core.logging import setup_process_output

    setup_process_output()
    loop = asyncio.get_running_loop()
    _reconcile_lock = asyncio.Lock()
    _reload_queue = asyncio.Queue(maxsize=1)
    _stop_event = asyncio.Event()

    def request_stop() -> None:
        assert _stop_event is not None
        _stop_event.set()
        _queue_reconcile()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, request_stop)

    ready = asyncio.Event()
    listener = asyncio.create_task(_listen_for_config_changes(ready))
    heartbeat = asyncio.create_task(_heartbeat_loop())
    print("[gateway] 频道管家启动，等待 user_bots 变更通知", flush=True)
    ready_wait = asyncio.create_task(ready.wait())
    stop_wait = asyncio.create_task(_stop_event.wait())
    done, pending = await asyncio.wait(
        (ready_wait, stop_wait), return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)

    try:
        if stop_wait in done and stop_wait.result():
            return
        # 已经先 LISTEN 再读快照，提交发生在对账期间的通知仍会排队处理。
        await reconcile()
        while not _stop_event.is_set():
            await _reload_queue.get()
            if _stop_event.is_set():
                break
            await reconcile()
    finally:
        _stop_event.set()
        for task in (listener, heartbeat):
            task.cancel()
        await asyncio.gather(listener, heartbeat, return_exceptions=True)
        await _shutdown()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
