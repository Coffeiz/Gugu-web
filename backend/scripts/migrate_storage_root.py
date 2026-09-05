#!/usr/bin/env python3
"""统一迁移本地文件存储目录。

默认兼容旧裸机布局：backend/uploads → ../Gugu-data/users。
Compose 升级时也复用本脚本，把旧 named volume 挂载的整个 /data 目录迁移到
新的宿主机 Gugu-data 目录；该模式传入绝对的 --source/--target，并使用
--no-config-update。

默认只做检查和预览；传入 --apply 才会复制文件并更新 config.override.json。
迁移可重复执行：相同文件跳过，目标存在但内容不同则中止，不删除旧目录。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iter_files(root: Path):
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        for name in dirnames + filenames:
            path = directory_path / name
            if path.is_symlink():
                raise RuntimeError(f"源目录包含不允许迁移的符号链接：{path}")
        for name in filenames:
            yield directory_path / name


def load_override(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"无法读取配置文件：{path}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("config.override.json 必须是 JSON 对象")
    return value


def write_override(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def switch_storage_root(override_path: Path, storage_path: str) -> None:
    if not override_path.exists():
        raise RuntimeError(
            f"缺少配置文件：{override_path}；拒绝自动创建部分配置，"
            "请先恢复 config.override.json，或在全新部署时显式初始化。"
        )
    override = load_override(override_path)
    storage = override.setdefault("storage", {})
    storage["local_path"] = storage_path
    write_override(override_path, override)


def migrate_tree(source: Path, target: Path, *, apply: bool) -> tuple[int, int, int]:
    """迁移目录树，返回（文件总数，待复制数，冲突数）。"""
    if source == target:
        print(f"[OK] 源目录和目标目录相同，已完成迁移：{target}")
        return 0, 0, 0
    if not source.exists():
        print(f"[OK] 未发现旧存储目录，无需迁移：{source}")
        return 0, 0, 0
    if not source.is_dir():
        raise RuntimeError(f"源路径不是目录：{source}")

    files = list(iter_files(source))
    conflicts: list[Path] = []
    pending: list[tuple[Path, Path]] = []
    for source_file in files:
        relative = source_file.relative_to(source)
        target_file = target / relative
        if target_file.exists() or target_file.is_symlink():
            if target_file.is_symlink() or not target_file.is_file() or file_digest(source_file) != file_digest(target_file):
                conflicts.append(relative)
        else:
            pending.append((source_file, target_file))

    consistent = len(files) - len(pending) - len(conflicts)
    print(f"源目录：{source}")
    print(f"目标目录：{target}")
    print(f"文件总数：{len(files)}，待复制：{len(pending)}，已存在且一致：{consistent}")
    if conflicts:
        print("[ERROR] 目标存在内容不同的文件，已停止，不会覆盖：", file=sys.stderr)
        for relative in conflicts[:20]:
            print(f"  - {relative}", file=sys.stderr)
        if len(conflicts) > 20:
            print(f"  … 其余 {len(conflicts) - 20} 个冲突未展开", file=sys.stderr)
        return len(files), len(pending), len(conflicts)
    if not apply:
        return len(files), len(pending), 0

    target.mkdir(parents=True, exist_ok=True)
    for source_file, target_file in pending:
        target_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target_file)

    for source_file in files:
        target_file = target / source_file.relative_to(source)
        if not target_file.exists() or file_digest(source_file) != file_digest(target_file):
            raise RuntimeError(f"迁移校验失败：{source_file.relative_to(source)}")
    return len(files), len(pending), 0


def main() -> int:
    app_dir = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=app_dir / "uploads")
    parser.add_argument("--target", type=Path, default=app_dir.parent / "Gugu-data" / "users")
    parser.add_argument("--apply", action="store_true", help="执行复制并更新配置；默认只预览")
    parser.add_argument(
        "--no-config-update",
        action="store_true",
        help="只迁移目录，不更新 config.override.json（Compose 整棵 /data 迁移使用）",
    )
    args = parser.parse_args()

    source = args.source if args.source.is_absolute() else (app_dir / args.source)
    target = args.target if args.target.is_absolute() else (app_dir / args.target)
    source = source.resolve()
    target = target.resolve()
    override_path = app_dir / "config.override.json"
    configured_target = os.path.relpath(target, app_dir)

    if source == target:
        print(f"[OK] 源目录和目标目录相同，已完成迁移：{target}")
        return 0
    if not source.exists():
        if target.exists() and args.apply and not args.no_config_update:
            switch_storage_root(override_path, configured_target)
            print(f"[OK] 旧目录不存在，目标目录已存在，迁移无需重复执行：{target}")
        else:
            print(f"[OK] 未发现旧存储目录，无需迁移：{source}")
        return 0

    try:
        _, _, conflicts = migrate_tree(source, target, apply=args.apply)
    except RuntimeError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    if conflicts:
        return 1
    if not args.apply:
        if args.no_config_update:
            print("预览完成；确认后使用同样的参数追加 --apply")
        else:
            print("预览完成；确认后执行：make storage-migrate")
        return 0

    if not args.no_config_update:
        switch_storage_root(override_path, configured_target)
        print(f"[OK] 迁移完成，配置已切换到：{configured_target}")
    else:
        print(f"[OK] 迁移完成，未修改应用配置：{target}")
    print(f"[INFO] 旧目录保留未删除：{source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
