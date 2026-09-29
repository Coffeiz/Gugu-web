import json
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "embedded_app_image_verifier",
    Path(__file__).with_name("verify_embedded_app_image.py"),
)
verifier = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = verifier
_SPEC.loader.exec_module(verifier)


def _image(layers):
    return {
        "Os": "linux",
        "Architecture": "amd64",
        "Variant": None,
        "Config": {"Env": ["PATH=/usr/bin"], "Entrypoint": ["/app/docker-entrypoint.sh"], "Labels": {"version": "ci"}},
        "RootFS": {"Layers": layers},
    }


class DockerRunner:
    def __init__(self, *, base=None, candidate=None, fail_at=None):
        self.base = base or _image(["sha256:base-layer"])
        self.candidate = candidate or _image(["sha256:base-layer", "sha256:bundle-layer"])
        self.fail_at = fail_at
        self.calls = []
        self.source_revision = "a" * 40

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv)
        command = argv[1]
        if command == "image":
            return self._inspect_image(argv)
        if command == "create":
            return self._create(argv)
        if command == "cp":
            return self._copy_archive(argv)
        if command == "run":
            return self._run_container(argv)
        if command == "load":
            return self._load_archive(argv)
        if command == "rm":
            return self._remove_container(argv)
        raise AssertionError(f"unexpected Docker command: {argv[1:]}")

    def _inspect_image(self, argv):
        name = argv[3]
        if name == "base:ci":
            payload = self.base
        elif name == "candidate:ci":
            payload = self.candidate
        else:
            role = "sandbox" if "sandbox" in name else "proxy"
            digest = "sha256:wrong-digest" if self.fail_at == "image" else "sha256:digest"
            payload = {
                "Id": f"sha256:runtime-{role}",
                "RepoDigests": [f"{name.rsplit(':', 1)[0]}@{digest}"],
            }
        return SimpleNamespace(returncode=0, stdout=json.dumps([payload]), stderr="")

    @staticmethod
    def _create(argv):
        return SimpleNamespace(returncode=0, stdout=argv[3], stderr="")

    @staticmethod
    def _copy_archive(argv):
        Path(argv[3]).write_bytes(b"bundle archive")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def _run_container(self, argv):
        if "candidate:ci" in argv:
            images = [
                {"name": "sandbox:test", "digest": "sha256:digest", "image_id": "sha256:sandbox", "role": "sandbox"},
                {"name": "proxy:test", "digest": "sha256:digest", "image_id": "sha256:proxy", "role": "egress-proxy"},
            ]
            code = 1 if self.fail_at == "manifest" else 0
            return SimpleNamespace(
                returncode=code,
                stdout=json.dumps({"images": images, "source_revision": self.source_revision}),
                stderr="",
            )
        code = 1 if self.fail_at == "shell" else 0
        return SimpleNamespace(returncode=code, stdout="shell-smoke-ok", stderr="")

    @staticmethod
    def _load_archive(_argv):
        return SimpleNamespace(returncode=0, stdout="Loaded image", stderr="")

    @staticmethod
    def _remove_container(_argv):
        return SimpleNamespace(returncode=0, stdout="", stderr="")


def test_verifier_accepts_loaded_images_by_repo_digest_when_daemon_id_differs(monkeypatch):
    monkeypatch.setattr(verifier.shutil, "which", lambda _name: "/usr/bin/docker")
    runner = DockerRunner()

    verifier.verify_embedded_app_image("base:ci", "candidate:ci", run=runner)

    assert not any("/var/run/docker.sock" in str(call) for call in runner.calls)
    assert any("EmbeddedBundleRuntime" in call[-1] and "load_verified_manifest()" in call[-1] for call in runner.calls)
    assert any(call[1:3] == ["load", "--input"] for call in runner.calls)
    assert any(
        call[1] == "run" and "--network" in call and "none" in call and "sandbox:test" in call
        and "shell-smoke-ok" in " ".join(call)
        for call in runner.calls
    )


@pytest.mark.parametrize(
    "candidate, fail_at, message",
    [
        (_image(["sha256:base-layer", "sha256:bundle-layer"]) | {"Architecture": "arm64"}, None, "平台字段"),
        (_image(["sha256:base-layer", "sha256:bundle-layer"]) | {"Config": {"Entrypoint": ["/changed"]}}, None, "Config"),
        (_image(["sha256:replaced-layer", "sha256:bundle-layer"]), None, "只追加一个 bundle 层"),
        (None, "manifest", "bundle 摘要校验失败"),
        (None, "shell", "离线 Shell smoke 失败"),
    ],
)
def test_verifier_rejects_invalid_candidate_or_smoke(candidate, fail_at, message, monkeypatch):
    monkeypatch.setattr(verifier.shutil, "which", lambda _name: "/usr/bin/docker")
    runner = DockerRunner(candidate=candidate, fail_at=fail_at)

    with pytest.raises(verifier.ImageVerificationError, match=message):
        verifier.verify_embedded_app_image("base:ci", "candidate:ci", run=runner)


def test_verifier_rejects_loaded_image_when_id_and_repo_digest_mismatch():
    runner = DockerRunner(fail_at="image")

    with pytest.raises(verifier.ImageVerificationError, match="镜像 digest 与 manifest 不一致"):
        verifier._load_and_verify_images(
            "bundle.tar",
            [{"name": "sandbox:test", "digest": "sha256:digest", "image_id": "sha256:config"}],
            "/usr/bin/docker",
            runner,
        )


def test_verifier_rejects_bundle_from_another_source_revision(monkeypatch):
    monkeypatch.setattr(verifier.shutil, "which", lambda _name: "/usr/bin/docker")
    runner = DockerRunner()

    with pytest.raises(verifier.ImageVerificationError, match="不属于本次源码提交"):
        verifier.verify_embedded_app_image(
            "base:ci",
            "candidate:ci",
            expected_source_revision="b" * 40,
            run=runner,
        )
