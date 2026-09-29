import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

from updater import app_bundle_runtime as runtime
from updater.app_bundle import AppBundleUpdater


def _write_release(path: Path, version: str, contract: str = "1") -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / ".gugu-app-release.json").write_text(
        json.dumps({"version": version, "runtime_contract": contract}), encoding="utf-8"
    )
    (path / "entry.py").write_text(f"VERSION = {version!r}\n", encoding="utf-8")


def _archive(path: Path, version: str = "v1.2.0", contract: str = "1") -> str:
    source = path.parent / "app-source"
    _write_release(source, version, contract)
    with tarfile.open(path, "w:gz") as bundle:
        bundle.add(source, arcname="app")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _patch_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(runtime, "APP_ROOT", tmp_path / "app")
    monkeypatch.setattr(runtime, "DATA_ROOT", tmp_path / "data" / "app-updates")
    monkeypatch.setattr(runtime, "IMAGE_APP_ROOT", tmp_path / "image-app")
    monkeypatch.setattr(runtime, "ACTIVE_FILE", tmp_path / "data" / "app-updates" / "active.json")
    monkeypatch.setattr(runtime, "PREVIOUS_FILE", tmp_path / "data" / "app-updates" / "previous.json")
    monkeypatch.setattr(runtime, "PENDING_FILE", tmp_path / "data" / "app-updates" / "pending.json")


def test_app_bundle_switch_and_failed_start_rollback_are_atomic(monkeypatch, tmp_path):
    _patch_paths(monkeypatch, tmp_path)
    _write_release(runtime.APP_ROOT, "v1.1.0")
    runtime.activate_image_or_persisted_app()
    assert runtime.APP_ROOT.is_symlink()
    assert runtime.current_app_info()["version"] == "v1.1.0"

    archive = tmp_path / "gugu-app-v1.2.0.tar.gz"
    digest = _archive(archive)
    release = runtime.install_archive(
        archive, expected_sha256=digest, version="v1.2.0", runtime_contract="1"
    )
    runtime.activate_installed_release(release)
    assert runtime.current_app_info()["version"] == "v1.2.0"
    assert runtime.PENDING_FILE.is_file()

    restored = runtime.rollback_pending_app()
    assert restored == {"version": "v1.1.0", "runtime_contract": "1"}
    assert runtime.current_app_info()["version"] == "v1.1.0"
    assert not runtime.PENDING_FILE.exists()


def test_image_symlink_layout_still_selects_newer_persisted_app(monkeypatch, tmp_path):
    _patch_paths(monkeypatch, tmp_path)
    _write_release(runtime.IMAGE_APP_ROOT, "v1.1.0")
    runtime.APP_ROOT.parent.mkdir(parents=True, exist_ok=True)
    runtime.APP_ROOT.symlink_to(runtime.IMAGE_APP_ROOT, target_is_directory=True)

    newer_release = runtime.DATA_ROOT / "releases" / "v1.2.0"
    _write_release(newer_release, "v1.2.0")
    runtime._write_json_atomic(runtime.ACTIVE_FILE, {"version": "v1.2.0", "runtime_contract": "1"})

    info = runtime.activate_image_or_persisted_app()

    assert info["version"] == "v1.2.0"
    assert runtime.APP_ROOT.is_symlink()
    assert runtime.APP_ROOT.resolve() == newer_release.resolve()
    assert runtime.IMAGE_APP_ROOT.is_dir()
    assert runtime.read_release_info(runtime.IMAGE_APP_ROOT)["version"] == "v1.1.0"


def test_legacy_image_directory_can_switch_to_newer_persisted_app(monkeypatch, tmp_path):
    _patch_paths(monkeypatch, tmp_path)
    _write_release(runtime.APP_ROOT, "v1.1.0")
    newer_release = runtime.DATA_ROOT / "releases" / "v1.2.0"
    _write_release(newer_release, "v1.2.0")
    runtime._write_json_atomic(runtime.ACTIVE_FILE, {"version": "v1.2.0", "runtime_contract": "1"})

    info = runtime.activate_image_or_persisted_app()

    assert info["version"] == "v1.2.0"
    assert runtime.APP_ROOT.is_symlink()
    assert runtime.APP_ROOT.resolve() == newer_release.resolve()
    assert runtime.read_release_info(runtime.IMAGE_APP_ROOT)["version"] == "v1.1.0"


def test_app_bundle_rejects_digest_mismatch_and_path_traversal(monkeypatch, tmp_path):
    _patch_paths(monkeypatch, tmp_path)
    archive = tmp_path / "valid.tar.gz"
    digest = _archive(archive)
    with pytest.raises(runtime.AppBundleError, match="摘要校验失败"):
        runtime.install_archive(
            archive, expected_sha256="0" * 64, version="v1.2.0", runtime_contract="1"
        )

    escaped = tmp_path / "escape.tar.gz"
    with tarfile.open(escaped, "w:gz") as bundle:
        member = tarfile.TarInfo("../outside")
        member.size = 4
        bundle.addfile(member, io.BytesIO(b"oops"))
    with pytest.raises(runtime.AppBundleError, match="不安全路径"):
        runtime.install_archive(
            escaped, expected_sha256=hashlib.sha256(escaped.read_bytes()).hexdigest(),
            version="v1.2.0", runtime_contract="1",
        )


def test_app_bundle_rejects_runtime_contract_mismatch(monkeypatch, tmp_path):
    _patch_paths(monkeypatch, tmp_path)
    archive = tmp_path / "gugu-app-v1.2.0.tar.gz"
    digest = _archive(archive, contract="2")
    with pytest.raises(runtime.AppBundleError, match="runtime contract 不匹配"):
        runtime.install_archive(
            archive, expected_sha256=digest, version="v1.2.0", runtime_contract="1"
        )


def test_mark_ready_keeps_current_and_previous_and_prunes_only_old_releases(monkeypatch, tmp_path):
    _patch_paths(monkeypatch, tmp_path)
    _write_release(runtime.APP_ROOT, "v1.1.0")
    runtime.activate_image_or_persisted_app()

    installed = []
    for version in ("v1.2.0", "v1.3.0"):
        archive = tmp_path / f"gugu-app-{version}.tar.gz"
        digest = _archive(archive, version=version)
        release = runtime.install_archive(
            archive, expected_sha256=digest, version=version, runtime_contract="1"
        )
        installed.append(release)
        runtime.activate_installed_release(release)
        assert runtime.mark_app_ready()["version"] == version

    orphan = runtime.DATA_ROOT / "releases" / "v1.0.0"
    _write_release(orphan, "v1.0.0")
    runtime.prune_old_releases()
    assert installed[0].is_dir()
    assert installed[1].is_dir()
    assert not orphan.exists()


def test_app_bundle_updater_accepts_only_version_bound_release_assets(tmp_path):
    updater = AppBundleUpdater(state_dir=tmp_path / "updater")
    manifest = {
        "schema_version": 3,
        "version": "v1.2.0",
        "channel": "stable",
        "minimum_version": "v1.1.0",
        "app_image": f"docker.io/coffeiz/gugu-web@sha256:{'a' * 64}",
        "split_images": {
            "backend_image": f"docker.io/coffeiz/gugu-web-backend@sha256:{'b' * 64}",
            "frontend_image": f"docker.io/coffeiz/gugu-web-frontend@sha256:{'c' * 64}",
        },
        "architectures": ["linux/amd64"],
        "database_migration": True,
        "release_notes_url": "https://github.com/Coffeiz/Gugu-web/releases/tag/v1.2.0",
        "rollback_supported": True,
        "app_bundle": {
            "archive": "gugu-app-v1.2.0.tar.gz",
            "signature_bundle": "gugu-app-v1.2.0.sigstore.json",
            "sha256": "d" * 64,
            "runtime_contract": "1",
            "size": 1024,
            "unpacked_size": 4096,
        },
    }
    candidate = updater._validate_manifest(json.dumps(manifest).encode())
    assert candidate["app_bundle"]["runtime_contract"] == "1"

    manifest["app_bundle"]["archive"] = "gugu-app-v1.3.0.tar.gz"
    with pytest.raises(runtime.AppBundleError, match="资源名称"):
        updater._validate_manifest(json.dumps(manifest).encode())
