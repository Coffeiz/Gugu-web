"""诊断 QQ 文件发送链路的阶段耗时。

开发环境使用：
  .venv/bin/python scripts/bench_qq_file_flow.py --file-id 123 \
    --channel-id 1 --target-id 2

默认只测数据库/存储读取和 base64 编码；加 ``--send`` 才会调用 QQ API。
脚本输出不包含文件名、URL、用户 ID、群 ID 或消息正文。
"""
from __future__ import annotations

from dataclasses import dataclass

import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import time
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@dataclass
class Timer:
    started: float

    @classmethod
    def start(cls) -> "Timer":
        return cls(time.perf_counter())

    def ms(self) -> float:
        return round((time.perf_counter() - self.started) * 1000, 2)


def report(stage: str, elapsed_ms: float, **fields: Any) -> None:
    payload = {"stage": stage, "ms": round(elapsed_ms, 2), **fields}
    print("[qq-file-bench] " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


async def resolve_source(args: argparse.Namespace) -> tuple[str, str, bytes]:
    from app.services.storage import get_storage

    source_count = sum(bool(value) for value in (args.file_id, args.attach_id, args.url))
    if source_count != 1:
        raise SystemExit("必须且只能提供 --file-id、--attach-id 或 --url 之一")

    total_timer = Timer.start()
    if args.file_id:
        timer = Timer.start()
        import app.db.session as db_session
        from app.models import File
        report("resolve-import", timer.ms())

        if db_session._engine is None:
            timer = Timer.start()
            db_session._build_engine()
            report("db-engine-build", timer.ms(), reused=False)
        else:
            report("db-engine-build", 0, reused=True)
        timer = Timer.start()
        async with db_session._SessionLocal() as db:
            report("db-session-open", timer.ms())
            timer = Timer.start()
            record = await db.get(File, args.file_id)
            report("db-file-query", timer.ms())
        if not record:
            raise SystemExit("找不到文件记录")
        name, ext, storage_key = record.display_name, record.ext, record.storage_key
        source = "file"
    elif args.attach_id:
        from app.core import chat_attach

        if not args.owner_user_id:
            raise SystemExit("使用 --attach-id 时必须提供 --owner-user-id")
        timer = Timer.start()
        meta = await chat_attach.get_meta(args.owner_user_id, args.attach_id)
        report("attachment-meta-query", timer.ms())
        if not meta:
            raise SystemExit("找不到暂存附件")
        name = meta.get("name") or "附件"
        ext = meta.get("ext") or ""
        storage_key = meta["storage_key"]
        source = "attachment"
    else:
        if not args.owner_user_id:
            raise SystemExit("使用 --url 时必须提供 --owner-user-id")
        from agent.tools.files import _send_file_from_url
        from app.core import chat_attach

        timer = Timer.start()
        result = await _send_file_from_url(args.owner_user_id, args.url, args.title or "图片")
        report("download-and-stage", timer.ms())
        if isinstance(result, str):
            result = json.loads(result)
        artifact = result.get("_artifact") if isinstance(result, dict) else None
        if not artifact or not artifact.get("attach_id"):
            raise SystemExit("网络图片下载或暂存失败")
        meta = await chat_attach.get_meta(args.owner_user_id, artifact["attach_id"])
        if not meta:
            raise SystemExit("网络图片暂存记录不存在")
        name = meta.get("name") or "图片"
        ext = meta.get("ext") or ""
        storage_key = meta["storage_key"]
        source = "url"
    report("resolve", total_timer.ms(), source=source)

    timer = Timer.start()
    data = await get_storage().get(storage_key)
    report("storage-read", timer.ms(), bytes=len(data))
    return name, ext, data


async def run_one(args: argparse.Namespace) -> None:
    # 先解析元数据，再单独读取一次数据，保证测量阶段和生产路径一致。
    name, ext, data = await resolve_source(args)

    timer = Timer.start()
    encoded = base64.b64encode(data)
    report("base64-encode", timer.ms(), bytes=len(data), encoded_bytes=len(encoded))

    if not args.send:
        print("[qq-file-bench] dry-run，未调用 QQ API", flush=True)
        return
    if not args.channel_id or not args.target_id:
        raise SystemExit("使用 --send 时必须提供 --channel-id 和 --target-id")
    if args.group and not args.message_id:
        raise SystemExit("群聊 --send 必须提供本次入站消息的 --message-id")

    os.environ["QQ_FILE_TIMING"] = "1"
    from agent.gateway import qq

    original_request = qq._qq_request

    async def timed_request(channel_id, method, path, json_body=None, **kwargs):
        request_timer = Timer.start()
        try:
            return await original_request(channel_id, method, path, json_body=json_body, **kwargs)
        finally:
            if path.endswith("/files"):
                stage = "qq-media-upload"
            elif path.endswith("/messages"):
                stage = "qq-media-message"
            else:
                stage = "qq-auth-or-other"
            report(stage, request_timer.ms())

    qq._qq_request = timed_request
    try:
        timer = Timer.start()
        ok = await qq.send_file(
            args.target_id,
            data,
            name,
            ext,
            args.channel_id,
            args.message_id,
            group=args.group,
        )
        report("qq-send-total", timer.ms(), ok=ok, target_kind="group" if args.group else "c2c")
    finally:
        qq._qq_request = original_request


async def run(args: argparse.Namespace) -> None:
    if args.capture_next:
        if not args.send or not args.group or not args.channel_id or not args.target_id:
            raise SystemExit("--capture-next 需要和 --send、--group、--channel-id、--target-id 一起使用")
        from app.core.redis import IM_INBOUND_STREAM, get_redis

        print("[qq-file-bench] 等待目标群下一条消息…", flush=True)
        entries = await get_redis().xread(
            {IM_INBOUND_STREAM: "$"}, count=20, block=args.capture_timeout * 1000
        )
        message_id = None
        if entries:
            for _stream, records in entries:
                for _entry_id, fields in records:
                    raw = fields.get("data") if isinstance(fields, dict) else None
                    try:
                        payload = json.loads(raw) if raw else {}
                    except (TypeError, ValueError):
                        continue
                    if (
                        payload.get("platform") == "qq"
                        and payload.get("channel_id") == args.channel_id
                        and payload.get("chat_type") == "group"
                        and payload.get("chat_id") == args.target_id
                        and payload.get("message_id")
                    ):
                        message_id = payload["message_id"]
                        break
                if message_id:
                    break
        if not message_id:
            raise SystemExit("等待超时，未捕获到目标群消息")
        args.message_id = message_id
        print("[qq-file-bench] 已捕获群消息，开始测试", flush=True)

    if args.file_ids:
        timer = Timer.start()
        for file_id in args.file_ids:
            one = argparse.Namespace(**vars(args))
            one.file_id = file_id
            one.file_ids = None
            await run_one(one)
        report("batch-total", timer.ms(), count=len(args.file_ids))
        return
    await run_one(args)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="测量 QQ 文件发送各阶段耗时")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file-id", type=int, help="文件库文件 ID")
    source.add_argument("--file-ids", type=int, nargs="+", help="多个文件库文件 ID，按顺序测试")
    source.add_argument("--attach-id", help="聊天暂存附件 ID")
    source.add_argument("--url", help="网络图片 URL，仅用于测量下载和暂存")
    parser.add_argument("--owner-user-id", type=int, help="暂存附件所属用户 ID")
    parser.add_argument("--title", help="网络图片暂存名称")
    parser.add_argument("--send", action="store_true", help="实际调用 QQ API 发送")
    parser.add_argument("--channel-id", help="QQ bot 配置 ID，仅 --send 需要")
    parser.add_argument("--target-id", help="私聊用户或群目标，仅 --send 需要")
    parser.add_argument("--message-id", help="被动回复消息 ID，可选")
    parser.add_argument("--group", action="store_true", help="按群聊接口发送")
    parser.add_argument("--capture-next", action="store_true", help="等待目标群下一条消息并自动取 message_id")
    parser.add_argument("--capture-timeout", type=int, default=120, help="自动捕获等待秒数")
    return parser.parse_args()


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
