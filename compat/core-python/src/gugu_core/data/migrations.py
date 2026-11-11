"""本地库显式增量升级；锁定写入、备份后执行可回滚 DDL。"""
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4
import sqlite3

from sqlalchemy.dialects import sqlite
from sqlalchemy.schema import CreateIndex, CreateTable

from gugu_core.data.models import LocalClient, LocalProject
from gugu_core.data.runtime import RuntimeSchemaError, SCHEMA_VERSION


def migrate_local_database(path: Path) -> Path:
    path = Path(path).resolve(strict=True)
    connection = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=5)
    try:
        connection.execute("BEGIN IMMEDIATE")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "core_runtime_meta" not in tables or "projects" not in tables:
            raise RuntimeSchemaError("此文件不是已初始化的 Core 数据库")
        metadata = dict(connection.execute("SELECT key, value FROM core_runtime_meta"))
        if metadata.get("schema_version") != "1":
            raise RuntimeSchemaError("只支持将版本 1 显式升级到当前版本")
        try:
            UUID(metadata["owner_id"])
        except (KeyError, ValueError) as exc:
            raise RuntimeSchemaError("本地数据库身份缺失或损坏") from exc
        columns = {row[1] for row in connection.execute("PRAGMA table_info(projects)")}
        if columns != set(LocalProject.__table__.columns.keys()) or "clients" in tables:
            raise RuntimeSchemaError("本地表结构不兼容，已拒绝自动修复")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = path.with_name(f"{path.name}.backup-{stamp}-{uuid4().hex[:8]}.db")
        with backup.open("xb"):
            pass
        # 另一个只读连接复制已提交的 WAL 快照；写锁保证备份与迁移之间没有写入。
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as source:
            with sqlite3.connect(backup) as destination:
                source.backup(destination)
        dialect = sqlite.dialect()
        connection.execute(str(CreateTable(LocalClient.__table__).compile(dialect=dialect)))
        for index in LocalClient.__table__.indexes:
            connection.execute(str(CreateIndex(index).compile(dialect=dialect)))
        connection.execute("UPDATE core_runtime_meta SET value=? WHERE key='schema_version'", (SCHEMA_VERSION,))
        connection.commit()
        return backup
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
