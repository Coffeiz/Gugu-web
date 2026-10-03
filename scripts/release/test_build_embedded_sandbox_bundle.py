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


def _write_save_archive(path, records, configs, *, include_layers=True):
    with tarfile.open(path, "w") as archive:
        manifest = json.dumps(records).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(manifest)
        archive.addfile(info, io.BytesIO(manifest))
        for record in records:
            name = record["RepoTags"][0]
            config = record["Config"]
            config_bytes = configs[name]
            info = tarfile.TarInfo(config)
            info.size = len(config_bytes)
            archive.addfile(info, io.BytesIO(config_bytes))
            if include_layers:
                for layer in record.get("Layers", []):
                    layer_bytes = b"layer data"
                    info = tarfile.TarInfo(layer)
                    info.size = len(layer_bytes)
                    archive.addfile(info, io.BytesIO(layer_bytes))


class DockerRunner:
    def __init__(self, config_format="legacy", *, archive_records=None, include_layers=True):
        self.calls = []
        self.config_format = config_format
        self.archive_records = archive_records
        self.include_layers = include_layers
        self.configs = {
            SANDBOX_REF: b'{"os":"linux","role":"sandbox"}',
            PROXY_REF: b'{"os":"linux","role":"egress-proxy"}',
        }
        self.image_ids = {
            name: "sha256:" + hashlib.sha256(config).hexdigest()
            for name, config in self.configs.items()
        }

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv)
        if argv[1:4] == ["image", "inspect", SANDBOX_REF]:
            payload = [{
                "Id": self.image_ids[SANDBOX_REF],
                "RepoDigests": [f"ghcr.io/coffeiz/gugu-sandbox@{SANDBOX_DIGEST}"],
            }]
            return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
        if argv[1:4] == ["image", "inspect", PROXY_REF]:
            payload = [{
                "Id": self.image_ids[PROXY_REF],
                "RepoDigests": [f"ubuntu/squid@{PROXY_DIGEST}"],
            }]
            return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
        if argv[1:3] == ["save", "--output"]:
            archive_path = Path(argv[3])
            records = []
            for name in (SANDBOX_REF, PROXY_REF):
                image_id = self.image_ids[name].removeprefix("sha256:")
                config = f"{image_id}.json" if self.config_format == "legacy" else f"blobs/sha256/{image_id}"
                layers = [f"{name.rsplit('/', 1)[-1]}/layer.tar"]
                records.append({"Config": config, "Layers": layers, "RepoTags": [name]})
            _write_save_archive(
                archive_path,
                self.archive_records if self.archive_records is not None else records,
                self.configs,
                include_layers=self.include_layers,
            )
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="unexpected docker command")


def _build_spec(archive_path, manifest_path, *, sandbox_digest=SANDBOX_DIGEST, source_revision="a" * 40):
    return builder.BundleBuildSpec(
        output=archive_path,
        manifest_path=manifest_path,
        images=(
            builder.BundleImageSpec("sandbox", SANDBOX_REF, sandbox_digest),
            builder.BundleImageSpec("egress-proxy", PROXY_REF, PROXY_DIGEST),
        ),
        source_revision=source_revision,
    )


def _assert_bundle_rejected(monkeypatch, runner, spec, message):
    monkeypatch.setattr(builder.shutil, "which", lambda _name: "/usr/bin/docker")
    with pytest.raises(builder.BundleBuildError, match=message):
        builder.build_bundle(spec, run=runner)
    assert not spec.output.exists()
    assert not spec.manifest_path.exists()


@pytest.mark.parametrize("config_format", ["legacy", "oci"])
def test_build_embedded_bundle_records_roles_repo_digests_archive_ids_and_hash(tmp_path, monkeypatch, config_format):
    runner = DockerRunner(config_format=config_format)
    monkeypatch.setattr(builder.shutil, "which", lambda _name: "/usr/bin/docker")
    archive_path = tmp_path / "runtime-images.tar"
    manifest_path = tmp_path / "manifest.json"

    builder.build_bundle(
        _build_spec(archive_path, manifest_path),
        run=runner,
    )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 2
    assert manifest["source_revision"] == "a" * 40
    assert manifest["archive_sha256"] == "sha256:" + hashlib.sha256(archive_path.read_bytes()).hexdigest()
    assert manifest["images"] == [
        {
            "role": "sandbox",
            "name": SANDBOX_REF,
            "digest": SANDBOX_DIGEST,
            "image_id": runner.image_ids[SANDBOX_REF],
        },
        {
            "role": "egress-proxy",
            "name": PROXY_REF,
            "digest": PROXY_DIGEST,
            "image_id": runner.image_ids[PROXY_REF],
        },
    ]
    assert [call[1] for call in runner.calls if len(call) > 1] == ["image", "image", "save"]


def test_build_embedded_bundle_rejects_digest_not_matching_local_repo_digest(tmp_path, monkeypatch):
    runner = DockerRunner()
    spec = _build_spec(
        tmp_path / "runtime-images.tar",
        tmp_path / "manifest.json",
        sandbox_digest=PROXY_DIGEST,
    )

    _assert_bundle_rejected(monkeypatch, runner, spec, "摘要与 RepoDigest/image ID 不匹配")

    assert not any(call[1] == "save" for call in runner.calls)


def test_build_embedded_bundle_accepts_same_run_local_sandbox_image_id(tmp_path, monkeypatch):
    runner = DockerRunner()
    spec = _build_spec(
        tmp_path / "runtime-images.tar",
        tmp_path / "manifest.json",
        sandbox_digest=runner.image_ids[SANDBOX_REF],
    )
    monkeypatch.setattr(builder.shutil, "which", lambda _name: "/usr/bin/docker")

    builder.build_bundle(spec, run=runner)

    manifest = json.loads(spec.manifest_path.read_text(encoding="utf-8"))
    assert manifest["images"][0]["digest"] == runner.image_ids[SANDBOX_REF]


def test_build_embedded_bundle_rejects_image_missing_from_docker_save_archive(tmp_path, monkeypatch):
    config_bytes = b'{"os":"linux","role":"sandbox"}'
    image_id = "sha256:" + hashlib.sha256(config_bytes).hexdigest()
    runner = DockerRunner(archive_records=[{
        "Config": image_id.removeprefix("sha256:") + ".json",
        "Layers": [],
        "RepoTags": [SANDBOX_REF],
    }])
    spec = _build_spec(tmp_path / "runtime-images.tar", tmp_path / "manifest.json")

    _assert_bundle_rejected(monkeypatch, runner, spec, "未唯一包含镜像")


def test_build_embedded_bundle_rejects_missing_layer_content(tmp_path, monkeypatch):
    runner = DockerRunner(include_layers=False)
    spec = _build_spec(tmp_path / "runtime-images.tar", tmp_path / "manifest.json")

    _assert_bundle_rejected(monkeypatch, runner, spec, "镜像 layer 缺失")
