"""
结构化日志系统
- DbLogHandler：将 WARNING+ 日志写入内存队列
- flush_log_queue()：异步后台任务，定期将队列写入数据库
- setup_logging()：初始化，替换 print 风格为 logging
"""

import asyncio
from app.core.tz import now_utc
import logging
import queue
import re
import sys
import traceback as _tb
from datetime import datetime

_log_queue: queue.Queue = queue.Queue(maxsize=2000)
_LINE_TIMESTAMP_RE = re.compile(r"^\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\s|$)")


class _TimestampedStream:
    """给 worker/gateway 的 print 输出补行首时间戳。

    systemd 的 ``StandardOutput=append:`` 会绕过 journald 的时间元数据，
    而这些常驻进程仍有大量历史 ``print``。包装 stdout/stderr 可以在不改动
    业务日志调用的前提下，让文件日志和 Admin tail 都保留真实 emit 时间。
    """

    def __init__(self, stream):
        self._stream = stream
        self._pending = ""

    def write(self, data: str) -> int:
        if not data:
            return 0
        text = self._pending + str(data)
        lines = text.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            self._pending = lines.pop()
        else:
            self._pending = ""
        for line in lines:
            if line.strip() and not _LINE_TIMESTAMP_RE.match(line):
                line = f"{datetime.now().strftime('%m-%d %H:%M:%S')} {line}"
            self._stream.write(line)
        return len(data)

    def flush(self) -> None:
        if self._pending:
            line = self._pending
            self._pending = ""
            if line.strip() and not _LINE_TIMESTAMP_RE.match(line):
                line = f"{datetime.now().strftime('%m-%d %H:%M:%S')} {line}"
            self._stream.write(line)
        self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


def setup_process_output() -> None:
    """为独立 worker/gateway/网关进程的标准输出补时间戳。"""
    if not isinstance(sys.stdout, _TimestampedStream):
        sys.stdout = _TimestampedStream(sys.stdout)
    if not isinstance(sys.stderr, _TimestampedStream):
        sys.stderr = _TimestampedStream(sys.stderr)


class DbLogHandler(logging.Handler):
    """将 WARNING 及以上的日志记录放入内存队列，不阻塞调用方。"""

    def emit(self, record: logging.LogRecord):
        if _log_queue.full():
            return
        tb_text = None
        if record.exc_info:
            tb_text = "".join(_tb.format_exception(*record.exc_info)).strip()
        try:
            _log_queue.put_nowait({
                "level":      record.levelname,
                "module":     record.name,
                "message":    self.format(record),
                "traceback":  tb_text,
                "created_at": now_utc(),
            })
        except queue.Full:
            pass


async def flush_log_queue():
    """每 10 秒将队列中的日志批量写入数据库，随 lifespan 启动。"""
    from app.db.session import _SessionLocal
    from app.models import SystemLog

    while True:
        await asyncio.sleep(10)
        if _SessionLocal is None:
            continue

        items = []
        try:
            while True:
                items.append(_log_queue.get_nowait())
        except queue.Empty:
            pass

        if not items:
            continue

        try:
            async with _SessionLocal() as db:
                for item in items:
                    db.add(SystemLog(
                        level=item["level"],
                        module=item["module"],
                        message=item["message"],
                        traceback=item.get("traceback"),
                        created_at=item["created_at"],
                    ))
                await db.commit()
        except Exception:
            pass  # DB 不可用时丢弃，不循环报错


def setup_logging():
    """配置根 logger：WARNING+ 进数据库（系统日志页，自带 created_at）；
    INFO+ 进控制台（→ stdout/stderr → logs/gugu.log，Debug 实时日志面板 tail 它），**带时间戳**。"""
    # DB 用的 message 不带时间（SystemLog 有独立 created_at 列）
    db_fmt = logging.Formatter("%(levelname)s [%(name)s] %(message)s")
    # 控制台/文件用的带时间戳，让 Debug 面板能看到每行的时间
    console_fmt = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s",
                                    datefmt="%m-%d %H:%M:%S")

    db_handler = DbLogHandler(level=logging.WARNING)
    db_handler.setFormatter(db_fmt)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not any(isinstance(h, DbLogHandler) for h in root.handlers):
        root.addHandler(db_handler)
    # 控制台 handler（带时间戳）：app 的 logger.* 经此进 gugu.log；StreamHandler 默认走 stderr，
    # systemd 单元 StandardError 也 append 到 gugu.log，所以 Debug 面板能 tail 到。
    if not any(getattr(h, "_gugu_console", False) for h in root.handlers):
        console = logging.StreamHandler()
        console.setLevel(logging.INFO)
        console.setFormatter(console_fmt)
        console._gugu_console = True
        root.addHandler(console)

    # 抑制第三方库噪声
    for noisy in ("httpx", "httpcore", "openai", "anthropic", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
