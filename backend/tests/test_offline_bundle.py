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


def test_load_embedded_bundle_manifest_requires_fixed_roles_ids_and_archive_digest(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps({
            "schema_version": 2,
            "archive_sha256": _digest("d"),
            "images": [
                {"role": "sandbox", "name": "coffeiz/gugu-sandbox:embedded", "digest": _digest(), "image_id": _digest("a")},
                {"role": "egress-proxy", "name": "ubuntu/squid:embedded", "digest": _digest("b"), "image_id": _digest("c")},
            ],
        }),
        encoding="utf-8",
    )

    manifest = load_bundle_manifest(path)

    assert manifest.schema_version == 2
    assert manifest.archive_sha256 == _digest("d")
    assert manifest.image_for_role("sandbox").image_id == _digest("a")
    assert manifest.image_for_role("egress-proxy").name == "ubuntu/squid:embedded"


@pytest.mark.parametrize(
    "images",
    [
        [{"role": "sandbox", "name": "sandbox:embedded", "digest": _digest(), "image_id": _digest()}],
        [
            {"role": "sandbox", "name": "sandbox:embedded", "digest": _digest(), "image_id": _digest()},
            {"role": "sandbox", "name": "proxy:embedded", "digest": _digest(), "image_id": _digest("b")},
        ],
        [
            {"role": "sandbox", "name": "sandbox:embedded", "digest": _digest(), "image_id": _digest()},
            {"role": "egress-proxy", "name": "proxy:embedded", "digest": _digest()},
        ],
    ],
)
def test_load_embedded_bundle_manifest_rejects_incomplete_roles(images, tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps({"schema_version": 2, "archive_sha256": _digest(), "images": images}),
        encoding="utf-8",
    )

    with pytest.raises(BundleManifestError):
        load_bundle_manifest(path)


def test_load_bundle_manifest_wraps_invalid_utf8_as_bundle_error(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_bytes(b"\xff\xfe")

    with pytest.raises(BundleManifestError, match="无法读取 bundle manifest"):
        load_bundle_manifest(path)
