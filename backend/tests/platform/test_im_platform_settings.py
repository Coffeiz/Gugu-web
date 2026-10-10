import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.config import _validate_im_patch
from app.core import config as app_config
from app.core.config import AppSettings, IMPlatformSettings
from app.services.im_platforms import (
    IM_PLATFORMS,
    enabled_im_platforms,
    im_platform_dependency,
    is_im_platform_enabled,
)


def test_all_im_platforms_are_enabled_by_default(monkeypatch):
    settings = IMPlatformSettings()
    monkeypatch.setattr(
        "app.services.im_platforms.get_settings",
        lambda: SimpleNamespace(im=settings),
    )

    assert set(settings.model_dump()) == set(IM_PLATFORMS)
    assert set(IM_PLATFORMS) == set(enabled_im_platforms())


def test_im_platform_override_is_applied_without_changing_other_defaults(tmp_path, monkeypatch):
    override_file = tmp_path / "config.override.json"
    override_file.write_text(json.dumps({"im": {"qq": False}}), encoding="utf-8")
    monkeypatch.setattr(app_config, "OVERRIDE_FILE", override_file)

    settings = AppSettings(_env_file=None, im=IMPlatformSettings()).apply_override()

    assert settings.im.qq is False
    assert settings.im.feishu is True
    assert settings.im.wechat is True
    assert settings.im.telegram is True


def test_platform_availability_tracks_configured_switches(monkeypatch):
    monkeypatch.setattr(
        "app.services.im_platforms.get_settings",
        lambda: SimpleNamespace(im=IMPlatformSettings(qq=False, telegram=False)),
    )

    assert is_im_platform_enabled("feishu")
    assert not is_im_platform_enabled("qq")
    assert not is_im_platform_enabled("telegram")
    with pytest.raises(HTTPException) as exc:
        im_platform_dependency("qq")()
    assert exc.value.status_code == 503


def test_admin_im_patch_accepts_partial_boolean_settings(monkeypatch):
    current = IMPlatformSettings()
    monkeypatch.setattr(
        "app.api.v1.config.get_settings",
        lambda: SimpleNamespace(im=current),
    )

    _validate_im_patch({"qq": False})


@pytest.mark.parametrize("patch", [{"unknown": True}, {"qq": 1}, {"wechat": "false"}, []])
def test_admin_im_patch_rejects_unknown_or_non_boolean_values(monkeypatch, patch):
    monkeypatch.setattr(
        "app.api.v1.config.get_settings",
        lambda: SimpleNamespace(im=IMPlatformSettings()),
    )

    with pytest.raises(HTTPException) as exc:
        _validate_im_patch(patch)
    assert exc.value.status_code == 400
