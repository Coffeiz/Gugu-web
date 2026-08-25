"""config.override 校验：db.password 必须从 override.json 显式提供。

回归测试 — 真实踩过的坑：业务后端 config.py 默认 db.user="pm" / password="pm123"，
业务 config.override.json 只覆盖了 host/port/name/user，没写 password → 后端用
"gugu" + "pm123" 连 DB 失败 → worker 反复 restart → im:inbound 队列堆积 →
用户感觉「消息收不到」。

修法：默认值改成 user="gugu" / password=""，并在 apply_override 里强制要求
override 显式提供 password（不能空、不能是 "pm123"/"pm" 占位符）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core import config as cfg


@pytest.fixture
def override_path(tmp_path, monkeypatch):
    """把 OVERRIDE_FILE 临时指向 tmp_path 下的文件，避免污染真实 config.override.json。"""
    fake = tmp_path / "config.override.json"
    monkeypatch.setattr(cfg, "OVERRIDE_FILE", fake)
    return fake


def test_default_db_password_is_empty_string():
    """默认值 password='' 而不是 'pm123'——避免旧占位符被默默采用。"""
    db = cfg.DatabaseSettings()
    assert db.password == "", (
        f"DatabaseSettings().password 应为空字符串，当前是 {db.password!r}。"
        f"如果有占位符默认值（如 'pm123'），会被 apply_override 静默采用并掩盖"
        f"真实部署未配置 password 的问题。"
    )


def test_default_db_user_is_gugu():
    """默认值 user='gugu'——和实际生产用户名一致，方便 dev / 集成环境本地直跑。"""
    db = cfg.DatabaseSettings()
    assert db.user == "gugu"


def test_storage_defaults_to_migrated_user_data_root():
    """默认存储根必须与 sandboxd allowed-root 使用同一份迁移后目录。"""
    assert cfg.StorageSettings().local_path == "../Gugu-data/users"


def test_apply_override_requires_db_password(tmp_path, monkeypatch):
    """override.json 没写 password → 启动直接抛错，不允许静默用空密码连 DB。"""
    fake = tmp_path / "config.override.json"
    fake.write_text(json.dumps({
        "db": {"host": "localhost", "port": 5432, "name": "gugu", "user": "gugu"},
        # 故意不写 password
    }), encoding="utf-8")
    monkeypatch.setattr(cfg, "OVERRIDE_FILE", fake)

    s = cfg.AppSettings()
    with pytest.raises(RuntimeError, match="db.password"):
        s.apply_override()


def test_apply_override_rejects_placeholder_password(tmp_path, monkeypatch):
    """override.json 写了 password 但仍是 'pm123' / 'pm' 占位符 → 抛错。"""
    fake = tmp_path / "config.override.json"
    fake.write_text(json.dumps({
        "db": {"host": "localhost", "port": 5432, "name": "gugu", "user": "gugu",
               "password": "pm123"},   # ← 旧占位符
    }), encoding="utf-8")
    monkeypatch.setattr(cfg, "OVERRIDE_FILE", fake)

    s = cfg.AppSettings()
    with pytest.raises(RuntimeError, match="占位符|pm123"):
        s.apply_override()


def test_apply_override_rejects_empty_string_password(tmp_path, monkeypatch):
    """override.json 写了 password: '' → 仍视为未提供，抛错。"""
    fake = tmp_path / "config.override.json"
    fake.write_text(json.dumps({
        "db": {"host": "localhost", "port": 5432, "name": "gugu", "user": "gugu",
               "password": ""},
    }), encoding="utf-8")
    monkeypatch.setattr(cfg, "OVERRIDE_FILE", fake)

    s = cfg.AppSettings()
    with pytest.raises(RuntimeError, match="db.password"):
        s.apply_override()


def test_apply_override_accepts_real_password(tmp_path, monkeypatch):
    """override.json 提供非占位符的真实密码 → 正常应用，db.url 含该密码。"""
    fake = tmp_path / "config.override.json"
    fake.write_text(json.dumps({
        "db": {"host": "localhost", "port": 5432, "name": "gugu", "user": "gugu",
               "password": "RealSecret_abc123"},
    }), encoding="utf-8")
    monkeypatch.setattr(cfg, "OVERRIDE_FILE", fake)

    s = cfg.AppSettings().apply_override()
    assert s.db.password == "RealSecret_abc123"
    assert "RealSecret_abc123" in s.db.url


def test_write_override_json_is_atomic_and_private(tmp_path, monkeypatch):
    target = tmp_path / "config.override.json"
    monkeypatch.setattr(cfg, "OVERRIDE_FILE", target)

    cfg.write_override_json({"db": {"password": "secret"}, "ai": {"model": "test"}})

    assert json.loads(target.read_text(encoding="utf-8"))["ai"]["model"] == "test"
    assert target.stat().st_mode & 0o777 == 0o600
    assert list(tmp_path.glob("*.tmp")) == []


def test_write_override_json_falls_back_for_systemd_ebusy(tmp_path, monkeypatch):
    """ProtectSystem 只允许原位写入时，配置更新仍可完成。"""
    import errno

    target = tmp_path / "config.override.json"
    target.write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "OVERRIDE_FILE", target)
    original_replace = cfg.os.replace

    def raise_ebusy(*args, **kwargs):
        raise OSError(errno.EBUSY, "Device or resource busy")

    monkeypatch.setattr(cfg.os, "replace", raise_ebusy)
    cfg.write_override_json({"sandbox": {"enabled": False}})

    assert json.loads(target.read_text(encoding="utf-8"))["sandbox"]["enabled"] is False
    assert target.stat().st_mode & 0o777 == 0o600
    assert list(tmp_path.glob("*.tmp")) == []
    monkeypatch.setattr(cfg.os, "replace", original_replace)
