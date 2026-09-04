#!/usr/bin/env python3
"""standalone compose 启动前检查与首次管理员账号初始化。"""

from __future__ import annotations

import fcntl
import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values


class StandaloneConfigError(RuntimeError):
    """用户可直接修复的 standalone 配置错误。"""


_ENV_ASSIGNMENT = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return {
        key: value
        for key, value in dotenv_values(path).items()
        if key and value is not None
    }


def _config_value(name: str, env_file_values: Mapping[str, str]) -> str:
    environment_value = os.environ.get(name, "").strip()
    if environment_value:
        return environment_value
    return str(env_file_values.get(name, "")).strip()


def _repair_command_for_data_dir(host_dir: str) -> str:
    quoted = host_dir.replace("'", "'\\''")
    return f"mkdir -p '{quoted}' && chown $(id -u):$(id -g) '{quoted}'"


def validate_required_config(*, env_file: Path, data_dir: Path, host_data_dir: str) -> dict[str, str]:
    """校验密钥与数据目录，返回已解析的 env 文件内容。"""
    values = _read_env_file(env_file)
    if not _config_value("SECRET_KEY", values):
        raise StandaloneConfigError(
            "SECRET_KEY 未设置，无法安全启动。请在 .env.standalone 中设置，"
            "或执行：export SECRET_KEY=\"$(openssl rand -base64 32)\""
        )

    if not (_config_value("GUGU_DB_PASSWORD", values) or _config_value("DB__PASSWORD", values)):
        raise StandaloneConfigError(
            "GUGU_DB_PASSWORD 未设置，无法连接 PostgreSQL。请在 .env.standalone 中设置，"
            "或执行：export GUGU_DB_PASSWORD=\"$(openssl rand -base64 32)\""
        )

    if not data_dir.is_dir():
        raise StandaloneConfigError(
            f"用户数据目录不存在：{data_dir}。请在宿主机执行：{_repair_command_for_data_dir(host_data_dir)}"
        )

    try:
        fd, probe = tempfile.mkstemp(prefix=".gugu-write-check-", dir=data_dir)
        os.close(fd)
        Path(probe).unlink()
    except OSError as exc:
        raise StandaloneConfigError(
            f"用户数据目录不可写：{data_dir}。请在宿主机执行：{_repair_command_for_data_dir(host_data_dir)}"
        ) from exc
    return values


def _has_assignment(path: Path, name: str) -> bool:
    if not path.is_file():
        return False
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _ENV_ASSIGNMENT.match(line)
        if match and match.group(1) == name:
            return True
    return False


def ensure_admin_password(*, env_file: Path, env_file_values: Mapping[str, str]) -> None:
    """首次启动追加随机密码；已有字段（包括空字段）绝不覆盖。"""
    if os.environ.get("ADMIN_PASSWORD", "").strip() or str(env_file_values.get("ADMIN_PASSWORD", "")).strip():
        return
    if _has_assignment(env_file, "ADMIN_PASSWORD"):
        return

    username = (
        os.environ.get("ADMIN_USERNAME", "").strip()
        or str(env_file_values.get("ADMIN_USERNAME", "")).strip()
        or "admin"
    )
    password = secrets.token_urlsafe(24)
    env_file.parent.mkdir(parents=True, exist_ok=True)

    with env_file.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.seek(0)
        if _has_assignment(env_file, "ADMIN_PASSWORD"):
            return
        handle.seek(0, os.SEEK_END)
        if handle.tell() > 0:
            handle.write("\n")
        handle.write(f"ADMIN_PASSWORD={password}\n")
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    print("管理员账号/密码（已保存到 backend/.env）：")
    print(f"  账号：{username}")
    print(f"  密码：{password}")


def main() -> int:
    env_file = Path(os.environ.get("GUGU_STANDALONE_ENV_FILE", "/app/.env"))
    data_dir = Path(os.environ.get("GUGU_STANDALONE_DATA_DIR", "/data"))
    host_data_dir = os.environ.get("GUGU_DATA_HOST_DIR", "/data")
    try:
        values = validate_required_config(
            env_file=env_file,
            data_dir=data_dir,
            host_data_dir=host_data_dir,
        )
        ensure_admin_password(env_file=env_file, env_file_values=values)
    except StandaloneConfigError as exc:
        print(f"standalone 启动检查失败：{exc}", file=os.sys.stderr)
        return 1
    except OSError as exc:
        print(f"standalone 启动检查失败：无法写入 {env_file}，请确认 backend/.env 可写。", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
