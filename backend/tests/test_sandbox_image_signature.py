import subprocess
from pathlib import Path

import pytest

from updater.sandbox_signature import (
    COSIGN_IDENTITY_REGEXP,
    COSIGN_OIDC_ISSUER,
    COSIGN_VERIFIER_IMAGE,
    verify_sandbox_image_signature,
)


def test_sandbox_signature_verification_uses_pinned_verifier_and_release_identity(monkeypatch):
    image = "coffeiz/gugu-sandbox:latest@sha256:" + "a" * 64
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr("updater.sandbox_signature.subprocess.run", fake_run)

    assert verify_sandbox_image_signature(image, "/run/gugu/docker.sock") is True

    command = captured["command"]
    assert command[:5] == [
        "docker", "-H", "unix:///run/gugu/docker.sock", "run", "--rm",
    ]
    assert COSIGN_VERIFIER_IMAGE in command
    assert command[-1] == image
    assert command[command.index("--certificate-identity-regexp") + 1] == COSIGN_IDENTITY_REGEXP
    assert command[command.index("--certificate-oidc-issuer") + 1] == COSIGN_OIDC_ISSUER
    assert captured["kwargs"]["check"] is False
    assert captured["kwargs"]["timeout"] == 300


@pytest.mark.parametrize("image", [
    "docker.io/attacker/gugu-sandbox@sha256:" + "a" * 64,
    "docker.io/coffeiz/gugu-sandbox@sha256:not-a-digest",
])
def test_sandbox_signature_verification_rejects_untrusted_reference_before_running(monkeypatch, image):
    def must_not_run(*_args, **_kwargs):
        raise AssertionError("非官方镜像不得启动 Cosign verifier")

    monkeypatch.setattr("updater.sandbox_signature.subprocess.run", must_not_run)

    with pytest.raises(ValueError, match="官方沙盒镜像"):
        verify_sandbox_image_signature(image, "/run/gugu/docker.sock")


def test_sandbox_signature_verification_fails_closed_on_bad_signature(monkeypatch):
    def fake_run(command, **_kwargs):
        return subprocess.CompletedProcess(command, 1, stderr="signature not found")

    monkeypatch.setattr("updater.sandbox_signature.subprocess.run", fake_run)

    with pytest.raises(RuntimeError, match="签名验证失败"):
        verify_sandbox_image_signature(
            "docker.io/coffeiz/gugu-sandbox@sha256:" + "a" * 64,
            "/run/gugu/docker.sock",
        )


def test_sandbox_init_has_explicit_offline_bundle_path():
    script = Path(__file__).parents[1] / "scripts" / "sandbox_rootless_init.sh"
    source = script.read_text(encoding="utf-8")
    assert "GUGU_SANDBOX_OFFLINE" in source
    assert "GUGU_SANDBOX_BUNDLE_MANIFEST" in source
    assert "离线模式禁止拉取" in source
    assert "write_squid_config" in source
    assert '$RD cp "$proxy_config"' in source
    assert 'mkdir -p "$USERS_ROOT"' in source
