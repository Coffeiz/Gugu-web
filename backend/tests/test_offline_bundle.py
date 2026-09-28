import json

import pytest

from agent.sandbox.offline_bundle import (
    BundleManifestError,
    load_bundle_manifest,
    validate_local_image,
)


def _digest(char: str = "a") -> str:
    return "sha256:" + char * 64


def test_load_bundle_manifest_and_validate_local_repo_digest(tmp_path):
    digest = _digest()
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "images": [
                    {"name": "coffeiz/gugu-sandbox:latest", "digest": digest},
                    {"name": "ubuntu/squid:latest", "digest": _digest("b")},
                ],
            }
        ),
        encoding="utf-8",
    )

    manifest = load_bundle_manifest(path)

    assert manifest.image_digest("coffeiz/gugu-sandbox:latest") == digest
    validate_local_image(
        "coffeiz/gugu-sandbox:latest",
        digest,
        json.dumps({"RepoDigests": ["coffeiz/gugu-sandbox@" + digest]}),
    )


def test_load_bundle_manifest_rejects_duplicate_or_invalid_images(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "images": [
                    {"name": "coffeiz/gugu-sandbox:latest", "digest": _digest()},
                    {"name": "coffeiz/gugu-sandbox:latest", "digest": _digest("b")},
                ],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(BundleManifestError, match="重复镜像"):
        load_bundle_manifest(path)


def test_validate_local_image_rejects_digest_mismatch():
    with pytest.raises(BundleManifestError, match="digest 不匹配"):
        validate_local_image(
            "coffeiz/gugu-sandbox:latest",
            _digest(),
            json.dumps({"RepoDigests": ["coffeiz/gugu-sandbox@" + _digest("b")]}),
        )


def test_validate_local_image_accepts_bundle_image_id_after_docker_load():
    image_id = "sha256:" + "c" * 64

    validate_local_image(
        "coffeiz/gugu-sandbox:latest",
        _digest(),
        json.dumps({"Id": image_id, "RepoDigests": []}),
        expected_image_id=image_id,
    )
