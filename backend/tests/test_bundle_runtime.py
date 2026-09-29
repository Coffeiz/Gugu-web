import hashlib
import json
from types import SimpleNamespace

import pytest

from agent.sandbox.bundle_runtime import EmbeddedBundleRuntime
from agent.sandbox.offline_bundle import BundleManifestError


def _digest(char: str) -> str:
    return "sha256:" + char * 64


def _write_bundle(tmp_path, *, archive=b"verified runtime archive"):
    archive_path = tmp_path / "runtime-images.tar"
    archive_path.write_bytes(archive)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps({
            "schema_version": 2,
            "archive_sha256": "sha256:" + hashlib.sha256(archive).hexdigest(),
            "images": [
                {
                    "role": "sandbox",
                    "name": "coffeiz/gugu-sandbox:embedded",
                    "digest": _digest("a"),
                    "image_id": _digest("1"),
                },
                {
                    "role": "egress-proxy",
                    "name": "ubuntu/squid:embedded",
                    "digest": _digest("b"),
                    "image_id": _digest("2"),
                },
            ],
        }),
        encoding="utf-8",
    )
    return manifest_path, archive_path


class DockerRunner:
    def __init__(self, image_ids=None, *, loaded_image_ids=None):
        self.image_ids = image_ids or {}
        self.loaded_image_ids = loaded_image_ids or {}
        self.loaded = False
        self.calls = []

    def __call__(self, argv, **_kwargs):
        command = tuple(argv[1:])
        self.calls.append(command)
        if command == ("info",):
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if command[:2] == ("image", "inspect"):
            name = command[2]
            image = {
                "coffeiz/gugu-sandbox:embedded": "sandbox",
                "ubuntu/squid:embedded": "egress-proxy",
            }.get(name)
            image_id = self.image_ids.get(image) if image else None
            if self.loaded and image:
                image_id = self.loaded_image_ids.get(
                    image,
                    _digest("1" if image == "sandbox" else "2"),
                )
            if image_id is None:
                return SimpleNamespace(returncode=1, stdout="", stderr="not found")
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps([{"Id": image_id, "RepoDigests": []}]),
                stderr="",
            )
        if command[:1] == ("load",):
            self.loaded = True
            return SimpleNamespace(returncode=0, stdout="Loaded image", stderr="")
        return SimpleNamespace(returncode=99, stdout="", stderr="unexpected docker command")


def test_embedded_bundle_imports_only_from_verified_local_archive(tmp_path):
    _write_bundle(tmp_path)
    runner = DockerRunner()
    runtime = EmbeddedBundleRuntime(
        tmp_path,
        docker_path="/usr/bin/docker",
        runner=runner,
    )

    manifest = runtime.ensure_images()

    assert manifest.image_for_role("sandbox").image_id == _digest("1")
    assert runner.loaded
    assert ("load", "--input", str(tmp_path / "runtime-images.tar")) in runner.calls
    assert not any(command[:1] == ("pull",) for command in runner.calls)


def test_embedded_bundle_skips_import_when_both_exact_image_ids_are_present(tmp_path):
    _write_bundle(tmp_path)
    runner = DockerRunner({"sandbox": _digest("1"), "egress-proxy": _digest("2")})
    runtime = EmbeddedBundleRuntime(tmp_path, docker_path="docker", runner=runner)

    runtime.ensure_images()

    assert runner.loaded is False
    assert not any(command[:1] == ("load",) for command in runner.calls)


def test_embedded_bundle_accepts_docker29_image_ids_after_archive_import(tmp_path):
    _write_bundle(tmp_path)
    runner = DockerRunner(loaded_image_ids={"sandbox": _digest("a"), "egress-proxy": _digest("b")})
    runtime = EmbeddedBundleRuntime(tmp_path, docker_path="docker", runner=runner)

    runtime.ensure_images()

    assert runner.loaded


def test_embedded_bundle_rejects_corrupt_archive_before_docker_access(tmp_path):
    _write_bundle(tmp_path)
    (tmp_path / "runtime-images.tar").write_bytes(b"tampered")
    runner = DockerRunner()
    runtime = EmbeddedBundleRuntime(tmp_path, docker_path="docker", runner=runner)

    with pytest.raises(BundleManifestError, match="摘要不匹配"):
        runtime.ensure_images()

    assert runner.calls == []


def test_embedded_bundle_rejects_wrong_local_image_without_overwriting_it(tmp_path):
    _write_bundle(tmp_path)
    runner = DockerRunner({"sandbox": _digest("f")})
    runtime = EmbeddedBundleRuntime(tmp_path, docker_path="docker", runner=runner)

    with pytest.raises(BundleManifestError, match="镜像 digest 不匹配"):
        runtime.ensure_images()

    assert runner.loaded is False
