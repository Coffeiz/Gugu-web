"""飞书网关连接运行时与进程生命周期。"""
from __future__ import annotations

import asyncio
import os
import threading
import lark_oapi as lark

from .events import _EventServices, _feishu_bot_open_id, _handle_card_action, _make_on_message
from .messages import _do_send


class _GatewayAsyncRunner:
    """为同步飞书回调提供进程级常驻事件循环，稳定复用异步数据库连接池。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            ready = threading.Event()

            def run_loop() -> None:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self._loop = loop
                ready.set()
                loop.run_forever()
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.close()

            self._thread = threading.Thread(
                target=run_loop, name="feishu-async-runner", daemon=True,
            )
            self._thread.start()
            ready.wait()

    def submit(self, coroutine):
        self.start()
        loop = self._loop
        if loop is None or loop.is_closed():
            raise RuntimeError("飞书异步执行环境不可用")
        return asyncio.run_coroutine_threadsafe(coroutine, loop)

    def run(self, coroutine):
        return self.submit(coroutine).result()

    def stop(self) -> None:
        with self._lock:
            thread, loop = self._thread, self._loop
            if thread is None or loop is None:
                return
            loop.call_soon_threadsafe(loop.stop)
        if thread is not threading.current_thread():
            thread.join(timeout=5)
        with self._lock:
            if self._thread is thread and not thread.is_alive():
                self._thread = None
                self._loop = None


_gateway_async_runner = _GatewayAsyncRunner()
_event_services = _EventServices(_gateway_async_runner, _do_send)


def serve() -> None:
    app_id = os.environ.get("FEISHU_APP_ID", "")
    app_secret = os.environ.get("FEISHU_APP_SECRET", "")
    channel_id = os.environ.get("FEISHU_BOT_ID", "")
    owner = os.environ.get("FEISHU_OWNER", "")
    if not app_id or not app_secret:
        raise SystemExit("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量（应由 gateway 注入）。")
    api_client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()   # 下载收到的文件/图片用
    bot_open_id = _feishu_bot_open_id(api_client)
    if not bot_open_id:
        print(f"[feishu:{channel_id}] 无法读取机器人身份，群 @命令识别不可用", flush=True)
    # 表情事件空处理器：咕咕加表情后飞书会回推 reaction.created 事件，不注册的话 lark 每条都报
    # 「processor not found」ERROR 刷屏（看着像断开，其实不是）。注册个 no-op 吞掉即可。
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(
            _make_on_message(
                channel_id, owner, api_client, _event_services, app_id, bot_open_id,
            )
        )
        .register_p2_card_action_trigger(
            lambda data: _handle_card_action(data, owner, _event_services, channel_id)
        )
        .register_p2_im_message_reaction_created_v1(lambda data: None)
        .register_p2_im_message_reaction_deleted_v1(lambda data: None)
        .build()
    )
    ws_client = lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.INFO)
    print(f"[feishu:{channel_id}] 网关启动（owner={owner}），WebSocket 长连接中…", flush=True)
    _gateway_async_runner.start()
    try:
        ws_client.start()  # 同步阻塞，SDK 自带断线重连
    finally:
        _gateway_async_runner.stop()
