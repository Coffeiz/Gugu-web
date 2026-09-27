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
    def __init__(self, *, base=None, candidate=None, smoke_code=0):
        self.base = base or _image(["sha256:base-layer"])
        self.candidate = candidate or _image(["sha256:base-layer", "sha256:bundle-layer"])
        self.smoke_code = smoke_code
        self.calls = []

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv)
        if argv[1:3] == ["image", "inspect"]:
            payload = self.base if argv[3] == "base:ci" else self.candidate
            return SimpleNamespace(returncode=0, stdout=json.dumps([payload]), stderr="")
        if argv[1:3] == ["run", "--rm"]:
            return SimpleNamespace(returncode=self.smoke_code, stdout="", stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="unexpected Docker command")


def test_verifier_accepts_same_app_config_platform_and_single_bundle_layer(monkeypatch):
    monkeypatch.setattr(verifier.shutil, "which", lambda _name: "/usr/bin/docker")
    runner = DockerRunner()

    verifier.verify_embedded_app_image("base:ci", "candidate:ci", run=runner)

    assert runner.calls[-1][2:8] == ["--rm", "--network", "none", "--read-only", "--entrypoint", "python3"]
    assert "EmbeddedBundleRuntime" in runner.calls[-1][-1]


@pytest.mark.parametrize(
    "candidate, message",
    [
        (_image(["sha256:base-layer", "sha256:bundle-layer"]) | {"Architecture": "arm64"}, "平台字段"),
        (_image(["sha256:base-layer", "sha256:bundle-layer"]) | {"Config": {"Entrypoint": ["/changed"]}}, "Config"),
        (_image(["sha256:replaced-layer", "sha256:bundle-layer"]), "只追加一个 bundle 层"),
    ],
)
def test_verifier_rejects_candidate_that_changes_app_contract(candidate, message, monkeypatch):
    monkeypatch.setattr(verifier.shutil, "which", lambda _name: "/usr/bin/docker")
    runner = DockerRunner(candidate=candidate)

    with pytest.raises(verifier.ImageVerificationError, match=message):
        verifier.verify_embedded_app_image("base:ci", "candidate:ci", run=runner)


def test_verifier_rejects_failed_bundle_smoke(monkeypatch):
    monkeypatch.setattr(verifier.shutil, "which", lambda _name: "/usr/bin/docker")
    runner = DockerRunner(smoke_code=1)

    with pytest.raises(verifier.ImageVerificationError, match="bundle smoke 失败"):
        verifier.verify_embedded_app_image("base:ci", "candidate:ci", run=runner)
