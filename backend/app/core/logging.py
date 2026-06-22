"""
结构化日志系统
- DbLogHandler：将 WARNING+ 日志写入内存队列
- flush_log_queue()：异步后台任务，定期将队列写入数据库
- setup_logging()：初始化，替换 print 风格为 logging
"""

import asyncio
import logging
import queue
import traceback as _tb
from datetime import datetime

_log_queue: queue.Queue = queue.Queue(maxsize=2000)


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
                "created_at": datetime.utcnow(),
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
    """配置根 logger，WARNING+ 进数据库，所有级别保留控制台输出。"""
    fmt = logging.Formatter("%(levelname)s [%(name)s] %(message)s")

    db_handler = DbLogHandler(level=logging.WARNING)
    db_handler.setFormatter(fmt)

    root = logging.getLogger()
    if not any(isinstance(h, DbLogHandler) for h in root.handlers):
        root.addHandler(db_handler)

    # 抑制第三方库噪声
    for noisy in ("httpx", "httpcore", "openai", "anthropic", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
