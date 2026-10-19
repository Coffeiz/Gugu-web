"""隔离删除压力探针：只使用临时目录，不连接数据库或读取运行配置。"""
from __future__ import annotations

import argparse
import ctypes
import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import signal
import sys
import struct
import subprocess
import tempfile
import time

from app.services.filesync.ts_sidecar import FileSyncSidecar


def prepare(root: Path, count: int) -> None:
    for index in range(count):
        (root / f"sample-{index:05d}.txt").write_text("隔离数据", encoding="utf-8")


async def collect_events(sidecar, events, deleted, *, duration, expected=None, sentinel=False):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        event = await sidecar.next_event(timeout=0.5)
        if not event:
            continue
        events[f"{event.get('event')}:{event.get('code') or ''}"] += 1
        if event.get("operation") == "delete" and event.get("object_type") == "file":
            deleted.add(event["relative_path"])
        if sentinel and event.get("relative_path") == "sentinel.txt":
            return True
        if expected is not None and len(deleted) == expected:
            break
    return False


async def run_case(name: str, count: int, pause: bool, slow_consumer: bool, cpu_pressure: bool = False, driver: str = "native") -> dict:
    with tempfile.TemporaryDirectory(prefix="gugu-filesync-pressure-") as directory:
        root = Path(directory)
        await asyncio.to_thread(prepare, root, count)
        command = None
        if driver == "baseline":
            artifact = Path(__file__).resolve().parents[2] / "bin" / "gugu-filesync-ts-worker.cjs"
            command = ["node", str(artifact)]
        sidecar = FileSyncSidecar(command=command)
        events: Counter = Counter()
        deleted: set[str] = set()
        stopped = False
        burner = None
        try:
            await sidecar.start()
            await sidecar.watch(1, root)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                event = await sidecar.next_event(timeout=1)
                if event and event.get("event") == "ready":
                    break
            else:
                raise RuntimeError("隔离监听未就绪")
            # 仅暂停本探针创建的子进程，模拟构建压力下监听线程无法及时消费内核事件。
            if pause:
                sidecar._process.send_signal(signal.SIGSTOP)
                stopped = True
            if cpu_pressure:
                cpu = min(os.sched_getaffinity(0))
                os.sched_setaffinity(sidecar._process.pid, {cpu})
                burner = await asyncio.create_subprocess_exec(
                    sys.executable, "-c",
                    "import time; end=time.monotonic()+15\nwhile time.monotonic()<end: pass",
                )
                os.sched_setaffinity(burner.pid, {cpu})
            started = time.monotonic()
            process = await asyncio.create_subprocess_exec(
                "find", str(root), "-maxdepth", "1", "-type", "f", "-delete",
            )
            if await process.wait():
                raise RuntimeError("隔离删除失败")
            if stopped:
                sidecar._process.send_signal(signal.SIGCONT)
                stopped = False
            # reader 持续读取 stdout，但业务消费者暂停，模拟 DB 投影积压。
            if slow_consumer:
                await asyncio.sleep(8)
            await collect_events(sidecar, events, deleted, duration=45, expected=count)
            # 哨兵用于区分监听仍活跃但历史事件丢失与整个进程已经退出。
            sentinel = root / "sentinel.txt"
            sentinel.write_text("哨兵", encoding="utf-8")
            sentinel_seen = await collect_events(sidecar, events, deleted, duration=20, sentinel=True)
            sentinel.unlink()
            return {
                "sentinel_seen": sentinel_seen, "sidecar_running": sidecar.running,
                "driver": driver, "case": name, "expected_deletes": count, "received_deletes": len(deleted),
                "missing_deletes": count-len(deleted), "remaining_disk_files": len(list(root.iterdir())),
                "events": dict(events), "seconds": round(time.monotonic()-started, 2),
            }
        finally:
            if stopped:
                sidecar._process.send_signal(signal.SIGCONT)
            if burner is not None:
                if burner.returncode is None:
                    burner.terminate()
                await burner.wait()
            await sidecar.close()


def kernel_queue_control(count: int = 24000) -> dict:
    """同等删除量直接读取 inotify，验证内核能否报告队列溢出。"""
    library = ctypes.CDLL(None, use_errno=True)
    library.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
    with tempfile.TemporaryDirectory(prefix="gugu-filesync-kernel-") as directory:
        root = Path(directory)
        prepare(root, count)
        descriptor = library.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if descriptor < 0:
            raise OSError(ctypes.get_errno(), "初始化隔离 inotify 失败")
        try:
            if library.inotify_add_watch(descriptor, os.fsencode(root), 0x200) < 0:
                raise OSError(ctypes.get_errno(), "注册隔离 inotify 失败")
            subprocess.run(["find", str(root), "-maxdepth", "1", "-type", "f", "-delete"], check=True)
            deleted = overflow = 0
            while True:
                try:
                    data = os.read(descriptor, 1024 * 1024)
                except BlockingIOError:
                    break
                offset = 0
                while offset < len(data):
                    _, mask, _, length = struct.unpack_from("iIII", data, offset)
                    deleted += bool(mask & 0x200)
                    overflow += bool(mask & 0x4000)
                    offset += 16 + length
            return {"case": "原生内核队列对照", "expected_deletes": count,
                    "received_deletes": deleted, "overflow_events": overflow}
        finally:
            os.close(descriptor)


async def main(repeats: int, driver: str) -> None:
    print(json.dumps(await asyncio.to_thread(kernel_queue_control), ensure_ascii=False), flush=True)
    for iteration in range(repeats):
        for name, count, pause, slow, cpu in (
            ("常规", 100, False, False, False),
            ("批量", 5000, False, False, False),
            ("大批量", 24000, False, False, False),
            ("消费积压", 24000, False, True, False),
            ("监听停顿", 24000, True, False, False),
            ("单核竞争", 24000, False, False, True),
        ):
            result = await run_case(name, count, pause, slow, cpu, driver)
            result["iteration"] = iteration + 1
            print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, choices=range(1, 6), default=1)
    parser.add_argument("--driver", choices=["baseline", "native"], default="native")
    args = parser.parse_args()
    asyncio.run(main(args.repeats, args.driver))
