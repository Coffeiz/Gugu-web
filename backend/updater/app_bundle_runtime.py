"""持久化应用包的校验、原子切换与启动时版本选择。"""

from __future__ import annotations

import hashlib
import argparse
import json
import os
import re
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


APP_ROOT = Path("/app")
DATA_ROOT = Path(os.getenv("GUGU_DATA_DIR", "/data")) / "app-updates"
IMAGE_APP_ROOT = Path("/opt/gugu/image-app")
ACTIVE_FILE = DATA_ROOT / "active.json"
PREVIOUS_FILE = DATA_ROOT / "previous.json"
PENDING_FILE = DATA_ROOT / "pending.json"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_FILES = 100_000


class AppBundleError(RuntimeError):
    """应用包无效或无法安全切换。"""


def read_release_info(directory: Path) -> dict[str, str]:
    try:
        value = json.loads((directory / ".gugu-app-release.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AppBundleError("应用版本信息缺失或无效") from exc
    if not isinstance(value, dict):
        raise AppBundleError("应用版本信息格式无效")
    version = value.get("version")
    contract = value.get("runtime_contract")
    if not isinstance(version, str) or not isinstance(contract, str) or not version or not contract:
        raise AppBundleError("应用版本信息字段缺失")
    return {"version": version, "runtime_contract": contract}


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _replace_app_link(target: Path) -> None:
    target = target.resolve(strict=True)
    link = APP_ROOT.with_name(".app-next")
    link.unlink(missing_ok=True)
    link.symlink_to(target, target_is_directory=True)
    if APP_ROOT.is_symlink():
        os.replace(link, APP_ROOT)
        return
    if APP_ROOT.exists():
        _preserve_image_app(APP_ROOT)
    os.replace(link, APP_ROOT)


def _already_activated_release() -> dict[str, str] | None:
    if not APP_ROOT.is_symlink():
        return None
    selected = APP_ROOT.resolve(strict=True)
    if IMAGE_APP_ROOT.is_dir() and selected == IMAGE_APP_ROOT.resolve(strict=True):
        return None
    return read_release_info(selected)


def _image_release_info(image_target: Path) -> dict[str, str]:
    try:
        return read_release_info(image_target)
    except AppBundleError:
        image_version = os.getenv("GUGU_IMAGE_VERSION", "")
        image_contract = os.getenv("GUGU_APP_RUNTIME_CONTRACT", "")
        if image_target.is_symlink() or not image_version or not image_contract:
            raise
        _write_json_atomic(
            image_target / ".gugu-app-release.json",
            {"version": image_version, "runtime_contract": image_contract},
        )
        return read_release_info(image_target)


def _preserve_image_app(image_target: Path) -> Path:
    if image_target != APP_ROOT:
        return image_target
    # 旧镜像布局的兼容迁移：复制而不是 rename，因 /app 可能位于 OverlayFS
    # lower layer，与 /opt/gugu 不同设备；新镜像构建时已预置固定目录和链接。
    IMAGE_APP_ROOT.parent.mkdir(parents=True, exist_ok=True)
    if IMAGE_APP_ROOT.exists():
        raise AppBundleError("镜像应用目录暂存路径冲突")
    shutil.copytree(APP_ROOT, IMAGE_APP_ROOT, symlinks=True)
    shutil.rmtree(APP_ROOT)
    return IMAGE_APP_ROOT


def activate_image_or_persisted_app() -> dict[str, str]:
    """容器启动时选择镜像代码或持久化代码；新镜像版本优先，避免旧包遮蔽镜像升级。"""
    DATA_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    active_info = _already_activated_release()
    if active_info is not None:
        return active_info
    if not APP_ROOT.is_dir():
        raise AppBundleError("镜像应用目录不存在")

    image_target = IMAGE_APP_ROOT if IMAGE_APP_ROOT.is_dir() else APP_ROOT
    image_info = _image_release_info(image_target)
    active: dict[str, Any] | None = None
    try:
        parsed = json.loads(ACTIVE_FILE.read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            active = parsed
    except (OSError, UnicodeError, json.JSONDecodeError):
        active = None

    # Compose 可在 /app/logs 单独挂载卷；不改动这类部署的路径与更新语义。
    nested_mount = False
    try:
        mountpoints = {
            Path(line.split(" - ", 1)[0].split()[4].replace("\\040", " "))
            for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines()
            if " - " in line and line.split(" - ", 1)[0].split()
        }
        nested_mount = any(point == APP_ROOT / "logs" for point in mountpoints)
    except OSError:
        pass
    if nested_mount:
        return image_info

    persisted_target: Path | None = None
    if active:
        release_path = DATA_ROOT / "releases" / str(active.get("version", ""))
        try:
            persisted_info = read_release_info(release_path)
            if (
                persisted_info["version"] == active.get("version")
                and persisted_info["runtime_contract"] == image_info["runtime_contract"]
            ):
                persisted_target = release_path
        except AppBundleError:
            persisted_target = None

    # 只有 runtime contract 相同且持久化应用版本高于镜像版本时，才继续使用在线应用包。
    selected = image_target
    if persisted_target is not None:
        try:
            if _version_key(read_release_info(persisted_target)["version"]) > _version_key(image_info["version"]):
                selected = persisted_target
        except AppBundleError:
            # 本地开发镜像可能使用 unknown/CI 版本；无法比较时不让旧应用包遮蔽镜像。
            selected = image_target

    if selected == image_target:
        selected = _preserve_image_app(image_target)
    _replace_app_link(selected)
    info = read_release_info(selected)
    if selected == IMAGE_APP_ROOT:
        _write_json_atomic(ACTIVE_FILE, info)
    return info


def _version_key(value: str) -> tuple[int, int, int, str]:
    import re

    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?", value)
    if not match:
        raise AppBundleError("应用版本号无效")
    major, minor, patch, suffix = match.groups()
    return int(major), int(minor), int(patch), suffix or "~"


def _safe_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members: list[tarfile.TarInfo] = []
    total = 0
    seen: set[str] = set()
    for member in archive:
        if len(members) >= MAX_FILES:
            raise AppBundleError("应用包文件数量超出限制")
        name = member.name
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or not path.parts or "" in path.parts:
            raise AppBundleError("应用包包含不安全路径")
        normalized = path.as_posix().rstrip("/")
        if normalized in seen:
            raise AppBundleError("应用包包含重复路径")
        seen.add(normalized)
        if not (member.isdir() or member.isfile()):
            raise AppBundleError("应用包只允许普通文件和目录")
        if member.isfile():
            total += member.size
            if member.size < 0 or total > MAX_UNPACKED_BYTES:
                raise AppBundleError("应用包解压大小超出限制")
        members.append(member)
    if not members:
        raise AppBundleError("应用包文件数量超出限制")
    return members


def install_archive(archive_path: Path, *, expected_sha256: str, version: str, runtime_contract: str) -> Path:
    """验证摘要与 tar 成员后暂存应用包；签名验证由下载/更新服务在调用前完成。"""
    if not archive_path.is_file() or archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise AppBundleError("应用包缺失或超过大小限制")
    _version_key(version)
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise AppBundleError("应用包摘要格式无效")
    digest = archive_sha256(archive_path)
    if not __import__("hmac").compare_digest(digest, expected_sha256):
        raise AppBundleError("应用包摘要校验失败")

    releases = DATA_ROOT / "releases"
    releases.mkdir(parents=True, exist_ok=True, mode=0o700)
    final = releases / version
    if final.exists():
        try:
            receipt = (final / ".gugu-app-archive.sha256").read_text(encoding="ascii").strip()
            existing = read_release_info(final)
        except (OSError, UnicodeError, AppBundleError):
            receipt, existing = "", {}
        if receipt == expected_sha256 and existing == {"version": version, "runtime_contract": runtime_contract}:
            return final
        raise AppBundleError("目标应用版本已存在且归档摘要不匹配")
    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=releases))
    try:
        with tarfile.open(archive_path, "r:gz") as bundle:
            members = _safe_members(bundle)
            bundle.extractall(staging, members=members, filter="data")
        roots = list(staging.iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            raise AppBundleError("应用包必须只有一个 app 根目录")
        app_root = roots[0]
        info = read_release_info(app_root)
        if info != {"version": version, "runtime_contract": runtime_contract}:
            raise AppBundleError("应用包版本或 runtime contract 不匹配")
        (app_root / ".gugu-app-archive.sha256").write_text(expected_sha256 + "\n", encoding="ascii")
        os.replace(app_root, final)
        return final
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise AppBundleError("应用包解压失败") from exc
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def activate_installed_release(directory: Path) -> dict[str, str]:
    info = read_release_info(directory)
    resolved = directory.resolve(strict=True)
    trusted_releases = (DATA_ROOT / "releases").resolve()
    trusted_image = IMAGE_APP_ROOT.resolve()
    if resolved != trusted_image and resolved.parent != trusted_releases:
        raise AppBundleError("应用版本目录不在受信任的持久化根目录")
    try:
        previous_target = APP_ROOT.resolve(strict=True)
        previous = read_release_info(previous_target)
    except (OSError, AppBundleError):
        previous_target = None
        previous = None
    if previous is not None:
        _write_json_atomic(PREVIOUS_FILE, {**previous, "path": str(previous_target)})
    else:
        PREVIOUS_FILE.unlink(missing_ok=True)
    previous_record = {**previous, "path": str(previous_target)} if previous and previous_target else None
    _write_json_atomic(PENDING_FILE, {**info, "previous": previous_record})
    _write_json_atomic(ACTIVE_FILE, info)
    _replace_app_link(resolved)
    return info


def current_app_info() -> dict[str, str]:
    return read_release_info(APP_ROOT.resolve(strict=True))


def mark_app_ready() -> dict[str, str] | None:
    """PID 1 已完成新代码健康检查后，清除待确认切换标记。"""
    if not PENDING_FILE.is_file():
        return None
    info = current_app_info()
    pending = json.loads(PENDING_FILE.read_text(encoding="utf-8"))
    if not isinstance(pending, dict) or pending.get("version") != info["version"]:
        raise AppBundleError("应用启动版本与待确认更新不匹配")
    PENDING_FILE.unlink(missing_ok=True)
    prune_old_releases()
    return info


def prune_old_releases() -> None:
    """只保留活动版和明确记录的上一版；清理范围严格限制在应用包版本目录。"""
    releases = DATA_ROOT / "releases"
    if not releases.is_dir():
        return
    keep: set[Path] = set()
    try:
        keep.add(APP_ROOT.resolve(strict=True))
    except OSError:
        pass
    try:
        previous = json.loads(PREVIOUS_FILE.read_text(encoding="utf-8"))
        keep.add(Path(str(previous["path"])).resolve(strict=True))
    except (OSError, UnicodeError, KeyError, TypeError, json.JSONDecodeError):
        pass
    root = releases.resolve()
    for release in root.iterdir():
        if release.is_symlink() or not release.is_dir() or release.resolve() in keep:
            continue
        try:
            if release.resolve().parent == root:
                shutil.rmtree(release)
        except OSError:
            # 清理失败不影响已通过健康检查的应用启动。
            continue


def rollback_pending_app() -> dict[str, str] | None:
    """应用启动健康检查失败时恢复切换前代码；不会回滚数据库或用户数据。"""
    if not PENDING_FILE.is_file():
        return None
    pending = json.loads(PENDING_FILE.read_text(encoding="utf-8"))
    previous = pending.get("previous") if isinstance(pending, dict) else None
    if not isinstance(previous, dict):
        return None
    path_value = str(previous.get("path") or "")
    target = Path(path_value).resolve(strict=True)
    allowed_roots = ((DATA_ROOT / "releases").resolve(), IMAGE_APP_ROOT.resolve())
    if target != allowed_roots[1] and target.parent != allowed_roots[0]:
        raise AppBundleError("待恢复应用目录不在受信任路径")
    info = read_release_info(target)
    if info != {"version": previous.get("version"), "runtime_contract": previous.get("runtime_contract")}:
        raise AppBundleError("待恢复应用版本与记录不匹配")
    _write_json_atomic(ACTIVE_FILE, info)
    _replace_app_link(target)
    PENDING_FILE.unlink(missing_ok=True)
    return info


def archive_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def supports_app_bundle_updates() -> bool:
    """仅允许已经完成启动时路径隔离的单容器使用持久化应用包更新。"""
    return APP_ROOT.is_symlink() and APP_ROOT.resolve().is_dir() and ACTIVE_FILE.is_file()


def main() -> int:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--activate", action="store_true")
    action.add_argument("--mark-ready", action="store_true")
    action.add_argument("--rollback-pending", action="store_true")
    args = parser.parse_args()
    if args.activate:
        activate_image_or_persisted_app()
    elif args.mark_ready:
        mark_app_ready()
    else:
        rollback_pending_app()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
