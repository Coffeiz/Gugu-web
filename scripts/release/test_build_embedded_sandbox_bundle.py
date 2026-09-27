import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

_BUILDER_PATH = Path(__file__).with_name("build_embedded_sandbox_bundle.py")
_SPEC = importlib.util.spec_from_file_location("embedded_bundle_builder", _BUILDER_PATH)
builder = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = builder
_SPEC.loader.exec_module(builder)


SANDBOX_REF = "ghcr.io/coffeiz/gugu-sandbox:ci"
PROXY_REF = "ubuntu/squid:latest"
SANDBOX_DIGEST = "sha256:" + "a" * 64
PROXY_DIGEST = "sha256:" + "b" * 64


class DockerRunner:
    def __init__(self):
        self.calls = []

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv)
        if argv[1:4] == ["image", "inspect", SANDBOX_REF]:
            payload = [{
                "Id": "sha256:" + "1" * 64,
                "RepoDigests": [f"ghcr.io/coffeiz/gugu-sandbox@{SANDBOX_DIGEST}"],
            }]
            return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
        if argv[1:4] == ["image", "inspect", PROXY_REF]:
            payload = [{
                "Id": "sha256:" + "2" * 64,
                "RepoDigests": [f"ubuntu/squid@{PROXY_DIGEST}"],
            }]
            return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
        if argv[1:3] == ["save", "--output"]:
            archive_path = Path(argv[3])
            records = [
                {"Config": "3" * 64 + ".json", "RepoTags": [SANDBOX_REF]},
                {"Config": "4" * 64 + ".json", "RepoTags": [PROXY_REF]},
            ]
            with tarfile.open(archive_path, "w") as archive:
                manifest = json.dumps(records).encode()
                info = tarfile.TarInfo("manifest.json")
                info.size = len(manifest)
                archive.addfile(info, io.BytesIO(manifest))
                for record in records:
                    config = record["Config"]
                    info = tarfile.TarInfo(config)
                    info.size = 2
                    archive.addfile(info, io.BytesIO(b"{}"))
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="unexpected docker command")


def _build_spec(archive_path, manifest_path, *, sandbox_digest=SANDBOX_DIGEST):
    return builder.BundleBuildSpec(
        output=archive_path,
        manifest_path=manifest_path,
        images=(
            builder.BundleImageSpec("sandbox", SANDBOX_REF, sandbox_digest),
            builder.BundleImageSpec("egress-proxy", PROXY_REF, PROXY_DIGEST),
        ),
    )


def test_build_embedded_bundle_records_roles_repo_digests_archive_ids_and_hash(tmp_path, monkeypatch):
    runner = DockerRunner()
    monkeypatch.setattr(builder.shutil, "which", lambda _name: "/usr/bin/docker")
    archive_path = tmp_path / "runtime-images.tar"
    manifest_path = tmp_path / "manifest.json"

    builder.build_bundle(
        _build_spec(archive_path, manifest_path),
        run=runner,
    )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 2
    assert manifest["archive_sha256"] == "sha256:" + hashlib.sha256(archive_path.read_bytes()).hexdigest()
    assert manifest["images"] == [
        {
            "role": "sandbox",
            "name": SANDBOX_REF,
            "digest": SANDBOX_DIGEST,
            "image_id": "sha256:" + "3" * 64,
        },
        {
            "role": "egress-proxy",
            "name": PROXY_REF,
            "digest": PROXY_DIGEST,
            "image_id": "sha256:" + "4" * 64,
        },
    ]
    assert [call[1] for call in runner.calls if len(call) > 1] == ["image", "image", "save"]


def test_build_embedded_bundle_rejects_digest_not_matching_local_repo_digest(tmp_path, monkeypatch):
    runner = DockerRunner()
    monkeypatch.setattr(builder.shutil, "which", lambda _name: "/usr/bin/docker")

    with pytest.raises(builder.BundleBuildError, match="RepoDigest 与构建摘要不匹配"):
        builder.build_bundle(
            _build_spec(
                tmp_path / "runtime-images.tar",
                tmp_path / "manifest.json",
                sandbox_digest=PROXY_DIGEST,
            ),
            run=runner,
        )

    assert not any(call[1] == "save" for call in runner.calls)
    assert not (tmp_path / "runtime-images.tar").exists()


def test_build_embedded_bundle_rejects_image_missing_from_docker_save_archive(tmp_path, monkeypatch):
    runner = DockerRunner()
    monkeypatch.setattr(builder.shutil, "which", lambda _name: "/usr/bin/docker")
    original = runner.__call__

    def save_sandbox_only(argv, **kwargs):
        if argv[1:3] == ["save", "--output"]:
            path = Path(argv[3])
            record = {"Config": "3" * 64 + ".json", "RepoTags": [SANDBOX_REF]}
            with tarfile.open(path, "w") as archive:
                manifest = json.dumps([record]).encode()
                info = tarfile.TarInfo("manifest.json")
                info.size = len(manifest)
                archive.addfile(info, io.BytesIO(manifest))
                config = record["Config"]
                info = tarfile.TarInfo(config)
                info.size = 2
                archive.addfile(info, io.BytesIO(b"{}"))
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return original(argv, **kwargs)

    with pytest.raises(builder.BundleBuildError, match="未唯一包含镜像"):
        builder.build_bundle(
            _build_spec(tmp_path / "runtime-images.tar", tmp_path / "manifest.json"),
            run=save_sandbox_only,
        )
    assert not (tmp_path / "manifest.json").exists()
