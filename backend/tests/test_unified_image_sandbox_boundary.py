"""一体化部署的 Sandbox 管理模式与进程边界。"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_unified_image_requires_explicit_manager_mode_and_supervises_embedded_manager():
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert "GUGU_SANDBOX_MANAGER_MODE=disabled" in dockerfile
    assert 'GUGU_SANDBOX_MANAGER_MODE:-disabled' in entrypoint
    assert "[program:sandboxd]" in entrypoint
    assert "EMBEDDED_SANDBOX_SUPERVISORD_PID" in entrypoint
    assert "monitored_pids+=(\"$EMBEDDED_SANDBOX_SUPERVISORD_PID\")" not in entrypoint
    assert "其未就绪不会重启 Web/数据库" in entrypoint


def test_manager_mode_is_explicit_and_disabled_by_default():
    config = (REPO_ROOT / "backend" / "app" / "core" / "config.py").read_text(encoding="utf-8")
    runtime = (REPO_ROOT / "backend" / "agent" / "sandbox" / "docker_runtime.py").read_text(encoding="utf-8")

    assert 'Literal["embedded", "external", "disabled"]' in config
    assert '"disabled"' in config[config.index("manager_mode:"):config.index("manager_mode:") + 300]
    assert "未配置管理器或 Socket 不可用时 fail-closed" in runtime


def test_default_compose_starts_sandbox_services_without_profile_and_resolves_digest():
    compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    assert "profiles: [sandbox]" not in compose
    assert "SANDBOX__IMAGE: ${GUGU_SANDBOX_IMAGE:-coffeiz/gugu-sandbox:latest}" in compose
    assert "SANDBOX__IMAGE_DIGEST: ${GUGU_SANDBOX_IMAGE_DIGEST:-resolved}" in compose
    assert compose.count("/run/gugu/sandbox-image-digest") >= 2


def test_compose_bootstrap_resolves_latest_to_an_immutable_digest():
    bootstrap = (REPO_ROOT / "backend" / "scripts" / "runtime" / "sandbox_rootless_init.sh").read_text(encoding="utf-8")

    assert "SANDBOX_BUNDLE_DIR" not in bootstrap
    assert '"$SANDBOX_IMAGE_DIGEST" = resolved' in bootstrap
    assert bootstrap.index('rm -f "$SANDBOX_IMAGE_DIGEST_FILE"') < bootstrap.index('$RD pull "$SANDBOX_IMAGE"')
    assert "RepoDigests" in bootstrap
    assert "python -m updater.sandbox_signature" in bootstrap
    assert bootstrap.index("python -m updater.sandbox_signature") < bootstrap.index('printf \'%s\\n\' "$resolved_digest"')
    assert "/run/gugu/sandbox-image-digest" in bootstrap
