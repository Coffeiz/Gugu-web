"""专属 stdin/stdout 管道协议，不监听 TCP、不接收调用方所有者身份。"""
from dataclasses import asdict
from pathlib import Path
import argparse
import asyncio
import json
import sys

from sqlalchemy.exc import SQLAlchemyError

from gugu_core.application.clients import ClientNotFound
from gugu_core.application.projects import ProjectConflict, ProjectNotFound
from gugu_core.data.runtime import LocalRuntime, RuntimeSchemaError

MAX_FRAME = 65_536
METHODS = {"core.info", "projects.list", "projects.create", "projects.rename", "clients.list", "clients.create"}


async def dispatch(runtime, method, params):
    if method not in METHODS:
        raise ValueError("此桌面能力不可用")
    if not isinstance(params, dict) or "owner_id" in params or "user_id" in params:
        raise ValueError("桌面请求参数无效")
    if method == "core.info":
        return {"protocol": 1, "storage": "sqlite", "accountMode": "single-user"}
    async with runtime.unit_of_work() as data:
        if method == "projects.list":
            return [asdict(row) for row in await data.projects.list()]
        if method == "projects.create":
            return asdict(await data.projects.create(params))
        if method == "projects.rename":
            if set(params) != {"id", "version", "name"} or type(params["id"]) is not int or type(params["version"]) is not int:
                raise ValueError("项目改名参数无效")
            return asdict(await data.projects.update(params["id"], params["version"], {"name": params["name"]}))
        if method == "clients.list":
            return [asdict(row) for row in await data.clients.list()]
        return asdict(await data.clients.create(params))


def send(value):
    encoded = (json.dumps(value, ensure_ascii=False, default=str) + "\n").encode("utf-8")
    if len(encoded) > MAX_FRAME:
        value = {"v": 1, "id": value.get("id"), "error": {"code": "result_too_large", "message": "结果超出桌面协议限制"}}
        encoded = (json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


async def serve(database):
    try:
        runtime = await (LocalRuntime.open(database) if database.exists() else LocalRuntime.initialize(database))
    except (OSError, RuntimeSchemaError, SQLAlchemyError):
        send({"v": 1, "event": "failed", "error": {"code": "storage_unavailable", "message": "本地数据无法打开，请检查版本与文件权限"}})
        return 2
    send({"v": 1, "event": "ready"})
    try:
        while True:
            raw = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_FRAME + 1)
            if not raw:
                return 0
            if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                send({"v": 1, "id": None, "error": {"code": "invalid_frame", "message": "桌面请求超出协议限制"}})
                return 2
            identifier = None
            try:
                request = json.loads(raw)
                if not isinstance(request, dict) or set(request) != {"v", "id", "method", "params"}:
                    raise ValueError("桌面请求格式无效")
                if type(request["v"]) is not int or request["v"] != 1 or type(request["id"]) is not int or request["id"] < 0:
                    raise ValueError("桌面协议版本或请求标识无效")
                identifier = request["id"]
                result = await dispatch(runtime, request["method"], request["params"])
                send({"v": 1, "id": identifier, "result": result})
            except (ProjectConflict, ProjectNotFound, ClientNotFound) as exc:
                code = "conflict" if isinstance(exc, ProjectConflict) else "not_found"
                send({"v": 1, "id": identifier, "error": {"code": code, "message": str(exc)}})
            except (ValueError, TypeError, KeyError):
                send({"v": 1, "id": identifier, "error": {"code": "invalid_request", "message": "桌面请求无效，请检查字段与能力范围"}})
            except SQLAlchemyError:
                send({"v": 1, "id": identifier, "error": {"code": "storage_error", "message": "本地数据操作失败"}})
    finally:
        await runtime.close()


def main():
    parser = argparse.ArgumentParser(description="咕咕桌面 Core 管道宿主")
    parser.add_argument("--database", required=True, type=Path)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(serve(args.database)))


if __name__ == "__main__":
    main()
