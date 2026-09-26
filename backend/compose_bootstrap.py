#!/usr/bin/env python3
"""默认 Compose 启动前检查与首次配置初始化。"""

from __future__ import annotations

import fcntl
import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values


class ComposeConfigError(RuntimeError):
    """用户可直接修复的默认 Compose 配置错误。"""


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
        raise ComposeConfigError(
            "SECRET_KEY 未设置，无法安全启动。请在 backend/.env 中设置，"
            "或执行：export SECRET_KEY=\"$(openssl rand -base64 32)\""
        )

    if not (_config_value("GUGU_DB_PASSWORD", values) or _config_value("DB__PASSWORD", values)):
        raise ComposeConfigError(
            "GUGU_DB_PASSWORD 未设置，无法连接 PostgreSQL。请在根目录 .env 中设置，"
            "或执行：export GUGU_DB_PASSWORD=\"$(openssl rand -base64 32)\""
        )

    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ComposeConfigError(
            f"用户数据目录无法创建：{data_dir}。请在宿主机执行：{_repair_command_for_data_dir(host_data_dir)}"
        ) from exc

    try:
        fd, probe = tempfile.mkstemp(prefix=".gugu-write-check-", dir=data_dir)
        os.close(fd)
        Path(probe).unlink()
    except OSError as exc:
        raise ComposeConfigError(
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


def _write_generated_env_value(path: Path, name: str, value: str) -> None:
    """在锁内写入一次性生成的配置值，保留已有配置和注释。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, "r+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.seek(0)
        content = handle.read()
        current_values = _read_env_file(path)
        if str(current_values.get(name, "")).strip():
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return

        lines = content.splitlines(keepends=True)
        replaced = False
        for index, line in enumerate(lines):
            match = _ENV_ASSIGNMENT.match(line)
            if match and match.group(1) == name:
                newline = "\n" if line.endswith("\n") else ""
                lines[index] = f"{name}={value}{newline}"
                replaced = True
                break

        if replaced:
            handle.seek(0)
            handle.truncate()
            handle.write("".join(lines))
        else:
            handle.seek(0, os.SEEK_END)
            if handle.tell() > 0 and not content.endswith("\n"):
                handle.write("\n")
            handle.write(f"{name}={value}\n")
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def ensure_secret_key(*, env_file: Path, env_file_values: Mapping[str, str]) -> None:
    """首次启动生成并持久化 SECRET_KEY；显式配置始终优先。"""
    if _config_value("SECRET_KEY", env_file_values):
        return
    _write_generated_env_value(env_file, "SECRET_KEY", secrets.token_urlsafe(48))


def ensure_database_password(
    *, env_file: Path, env_file_values: Mapping[str, str], embedded: bool
) -> None:
    """内置数据库首次启动时生成并持久化连接密码；外部数据库仍要求显式配置。"""
    if not embedded:
        return
    if _config_value("DB__PASSWORD", env_file_values):
        return
    configured_password = _config_value("GUGU_DB_PASSWORD", env_file_values)
    if configured_password:
        if not os.environ.get("DB__PASSWORD", "").strip():
            _write_generated_env_value(env_file, "DB__PASSWORD", configured_password)
        return
    _write_generated_env_value(env_file, "DB__PASSWORD", secrets.token_urlsafe(32))
    saved_password = _read_env_file(env_file).get("DB__PASSWORD", "").strip()
    if not saved_password:
        raise OSError(f"数据库密码未能写入配置文件：{env_file}")
    print(f"内置 PostgreSQL 连接密码已随机生成并保存到 {env_file}。")


def ensure_admin_password(*, env_file: Path, env_file_values: Mapping[str, str]) -> None:
    """首次启动写入随机密码；空字段视为未配置并会被填充。"""
    if os.environ.get("ADMIN_PASSWORD", "").strip() or str(env_file_values.get("ADMIN_PASSWORD", "")).strip():
        return

    username = (
        os.environ.get("ADMIN_USERNAME", "").strip()
        or str(env_file_values.get("ADMIN_USERNAME", "")).strip()
        or "admin"
    )
    password = secrets.token_urlsafe(24)
    _write_generated_env_value(env_file, "ADMIN_PASSWORD", password)
    saved_password = _read_env_file(env_file).get("ADMIN_PASSWORD", "").strip()
    if not saved_password:
        raise OSError(f"管理员密码未能写入配置文件：{env_file}")

    print(f"管理员账号/密码（已保存到 {env_file}）：")
    print(f"  账号：{username}")
    print(f"  密码：{saved_password}")


def main() -> int:
    env_file = Path(os.environ.get("GUGU_ENV_FILE", "/app/.env"))
    data_dir = Path(os.environ.get("GUGU_DATA_DIR", "/data"))
    host_data_dir = os.environ.get("GUGU_DATA_HOST_DIR", "/data")
    print(f"[entrypoint] 使用持久化配置文件：{env_file}")
    try:
        values = _read_env_file(env_file)
        ensure_secret_key(env_file=env_file, env_file_values=values)
        ensure_database_password(
            env_file=env_file,
            env_file_values=values,
            embedded=os.environ.get("GUGU_EMBEDDED_DEPS", "0") == "1",
        )
        values = _read_env_file(env_file)
        values = validate_required_config(
            env_file=env_file,
            data_dir=data_dir,
            host_data_dir=host_data_dir,
        )
        ensure_admin_password(env_file=env_file, env_file_values=values)
    except ComposeConfigError as exc:
        print(f"Compose 启动检查失败：{exc}", file=os.sys.stderr)
        return 1
    except OSError as exc:
        print(f"Compose 启动检查失败：无法写入 {env_file}，请确认 backend/.env 可写。", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
