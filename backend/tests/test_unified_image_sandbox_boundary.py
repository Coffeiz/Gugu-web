"""一体化 gugu-web 不托管沙盒；默认 Compose 拉取并启动独立沙盒服务。"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_unified_image_does_not_bundle_sandbox_runtime_or_start_sandboxd():
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert "sandbox-image.tar.gz" not in dockerfile
    assert "sandbox-bundle-manifest.json" not in dockerfile
    assert "[program:sandboxd]" not in entrypoint
    assert "检测到 docker socket" not in entrypoint


def test_default_compose_starts_sandbox_services_without_profile_and_resolves_digest():
    compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    assert "profiles: [sandbox]" not in compose
    assert "SANDBOX__IMAGE: ${GUGU_SANDBOX_IMAGE:-coffeiz/gugu-sandbox:latest}" in compose
    assert "SANDBOX__IMAGE_DIGEST: ${GUGU_SANDBOX_IMAGE_DIGEST:-resolved}" in compose
    assert compose.count("/run/gugu/sandbox-image-digest") >= 2


def test_release_pipeline_no_longer_packages_sandbox_into_unified_image():
    workflow = (REPO_ROOT / ".github" / "workflows" / "docker-release.yml").read_text(encoding="utf-8")

    assert "bundled-sandbox-runtime" not in workflow
    assert "Package sandbox image for the all-in-one image" not in workflow
    assert "docker save" not in workflow


def test_compose_bootstrap_resolves_latest_to_an_immutable_digest():
    bootstrap = (REPO_ROOT / "backend" / "scripts" / "sandbox_rootless_init.sh").read_text(encoding="utf-8")

    assert "SANDBOX_BUNDLE_DIR" not in bootstrap
    assert '"$SANDBOX_IMAGE_DIGEST" = resolved' in bootstrap
    assert bootstrap.index('rm -f "$SANDBOX_IMAGE_DIGEST_FILE"') < bootstrap.index('$RD pull "$SANDBOX_IMAGE"')
    assert "RepoDigests" in bootstrap
    assert "python -m updater.sandbox_signature" in bootstrap
    assert bootstrap.index("python -m updater.sandbox_signature") < bootstrap.index('printf \'%s\\n\' "$resolved_digest"')
    assert "/run/gugu/sandbox-image-digest" in bootstrap
