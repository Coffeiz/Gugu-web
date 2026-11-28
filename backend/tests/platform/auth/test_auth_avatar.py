"""头像上传只接受受支持的媒体类型，并以已校验类型确定本地文件后缀。"""

from io import BytesIO
from types import SimpleNamespace

from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers
import pytest

from app.api.v1 import auth as auth_api


def _upload(data: bytes, content_type: str, filename: str = "clipboard") -> UploadFile:
    return UploadFile(
        file=BytesIO(data),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


def _use_avatar_storage(monkeypatch, tmp_path):
    settings = SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path)))
    monkeypatch.setattr(
        auth_api,
        "get_settings",
        lambda: settings,
    )
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)


@pytest.mark.asyncio
async def test_avatar_upload_uses_validated_media_type_and_replaces_only_the_owners_old_avatar(
    db, user_a, monkeypatch, tmp_path,
):
    _use_avatar_storage(monkeypatch, tmp_path)
    avatar_dir = tmp_path / "avatars"
    avatar_dir.mkdir()
    old_avatar = avatar_dir / f"{user_a.id}.png"
    other_avatar = avatar_dir / "00000000-0000-4000-8000-000000000099.gif"
    old_avatar.write_bytes(b"old avatar")
    other_avatar.write_bytes(b"other user")

    result = await auth_api.upload_avatar(
        _upload(b"new jpeg bytes", "image/jpeg", filename="avatar.png"), user_a, db,
    )

    new_avatar = avatar_dir / f"{user_a.id}.jpg"
    assert result.avatar_url.startswith(f"/api/v1/auth/avatar/{user_a.id}?v=")
    assert user_a.avatar == f"avatars/{user_a.id}.jpg"
    assert new_avatar.read_bytes() == b"new jpeg bytes"
    assert not old_avatar.exists()
    assert other_avatar.read_bytes() == b"other user"

    response = await auth_api.get_avatar(user_a.id, db)
    assert response.body == b"new jpeg bytes"
    assert response.media_type == "image/jpeg"
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
@pytest.mark.parametrize("content_type", ["image/svg+xml", "text/plain", "application/octet-stream"])
async def test_avatar_upload_rejects_unsupported_media_before_creating_files(
    db, user_a, monkeypatch, tmp_path, content_type,
):
    _use_avatar_storage(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as exc_info:
        await auth_api.upload_avatar(_upload(b"not an accepted image", content_type), user_a, db)

    assert exc_info.value.status_code == 400
    assert not (tmp_path / "avatars").exists()


@pytest.mark.asyncio
async def test_avatar_upload_rejects_files_over_five_megabytes_without_writing_them(
    db, user_a, monkeypatch, tmp_path,
):
    _use_avatar_storage(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as exc_info:
        await auth_api.upload_avatar(_upload(b"x" * (5 * 1024 * 1024 + 1), "image/png"), user_a, db)

    assert exc_info.value.status_code == 400
    assert not (tmp_path / "avatars").exists()
