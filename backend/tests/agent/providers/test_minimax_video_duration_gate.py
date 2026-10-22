"""视频时长闸门：超出 Provider 规格的应用侧提前拒绝（维度 A）。

闸门的**机制**在通用媒体层（`agent/media/video.py`）：时长超限 → `ValueError` →
调用方（聊天附件 / read_file）把它变成失败提示或**失败的 tool result**，视频
**不发给 Provider**——不让上游去拒。

闸门的**数值**由 Provider 规格声明（`agent/providers/*/media.py`），通用层不
写任何厂商策略。所以本文件同时验证两件事：

1. MiniMax M3 声明的上限 = 官方硬限 1800 秒，边界语义跟上游一致；
2. 同一个闸门对别的 Provider 照样生效（用各自的规格值），不是给 M3 特设的。

上游硬限出处（MiniMax 400 原文，2013）：
`messages[167]'s content[1] video's duration is bigger than 1800 seconds`
——判的是"严格大于"，所以正好 1800 秒上游收，应用侧不能误拒。
"""
import asyncio
from types import SimpleNamespace

import pytest


def _m3_cfg():
    return SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic",
                           model="MiniMax-M3")


def _fake_probe(monkeypatch, duration):
    """把 ffprobe 替身成固定时长——不联网、不构造真实大文件。"""
    from agent.media import video as media_video

    async def probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": duration}

    monkeypatch.setattr(media_video, "probe_video", probe)


def test_m3_spec_declares_official_hard_limit():
    """M3 的时长上限 = 上游硬限 1800 秒；边界是"严格大于"（正好 1800 放行）。"""
    from agent.providers.minimax.media import M3_MEDIA_LIMITS

    assert M3_MEDIA_LIMITS.max_duration_s == 1800
    assert not M3_MEDIA_LIMITS.duration_limit_inclusive


def test_video_over_limit_is_rejected_before_any_upload(monkeypatch):
    """超 1800 秒：应用侧直接拒绝，且**一次 Files API 上传都不发**。

    上游对超限视频是硬拒绝（400），应用侧先判的意义就在这里——不能先把
    235MB 视频传上去了再等上游说不行。
    """
    from agent.media import video as media_video
    from agent.providers.minimax import MiniMaxAdapter

    uploaded = []

    async def fake_upload(_self, raw, name, _ai, *, mime="", purpose=""):
        uploaded.append(name)
        return "file-abc"

    _fake_probe(monkeypatch, 4119.105)
    monkeypatch.setattr(MiniMaxAdapter, "upload_media_file", fake_upload)

    with pytest.raises(ValueError) as exc:
        asyncio.run(media_video.prepare_video_media(
            b"x" * 1024, "video/mp4", "long.mp4", _m3_cfg()))

    message = str(exc.value)
    assert "未发送给 Provider" in message
    assert "1800" in message
    assert uploaded == [], "超时长应在上传之前就拒绝"


def test_video_just_over_limit_is_rejected(monkeypatch):
    """边界：1800.1 秒（上游拒）→ 应用侧也拒。"""
    from agent.media import video as media_video

    _fake_probe(monkeypatch, 1800.1)

    with pytest.raises(ValueError, match="1800"):
        asyncio.run(media_video.prepare_video_media(
            b"x" * 1024, "video/mp4", "v.mp4", _m3_cfg()))


def test_video_at_exact_limit_is_allowed(monkeypatch):
    """边界：正好 1800 秒（上游收）→ 应用侧不误拒，正常继续处理。"""
    from agent.media import video as media_video

    _fake_probe(monkeypatch, 1800.0)

    result = asyncio.run(media_video.prepare_video_media(
        b"x" * 1024, "video/mp4", "v.mp4", _m3_cfg()))
    assert result["mode"] == "base64"


def test_video_under_limit_is_allowed(monkeypatch):
    """1800 秒以内：正常放行。"""
    from agent.media import video as media_video

    _fake_probe(monkeypatch, 1799.9)

    result = asyncio.run(media_video.prepare_video_media(
        b"x" * 1024, "video/mp4", "v.mp4", _m3_cfg()))
    assert result["mode"] == "base64"


def test_gate_uses_other_providers_own_limit(monkeypatch):
    """闸门不是给 M3 特设的：别的 Provider 用自己的规格值，同样在应用侧拒绝。

    这里用共享默认规格（120 秒）——机制在通用层、数值在 Provider 规格，
    未来新增 Provider 只要声明自己的上限就自动获得这个闸门。
    """
    from agent.media import video as media_video

    _fake_probe(monkeypatch, 200.0)

    with pytest.raises(ValueError) as exc:
        asyncio.run(media_video.prepare_video_media(
            b"x" * 1024, "video/mp4", "v.mp4",
            SimpleNamespace(provider="openai", model="gpt-test", api_format="openai")))

    message = str(exc.value)
    assert "未发送给 Provider" in message
    assert "120" in message


def test_duration_gate_is_shared_across_provider_registry():
    """每个声明了视频能力的 Provider 都有可用的时长闸门（没有"漏配就放行"的口子）。

    数值可以是 None（该 Provider 不设应用侧上限），但必须是有意声明的——
    共享默认值本身就是 120 秒，没有 Provider 会"忘了配"导致闸门整个失效。
    """
    from agent.providers import _REGISTRY
    from agent.providers.media import DEFAULT_MEDIA_LIMITS

    assert DEFAULT_MEDIA_LIMITS.max_duration_s == 120
    for name, adapter in _REGISTRY.items():
        limits = adapter.media_limits("")
        assert limits.max_duration_s is None or limits.max_duration_s > 0, \
            f"{name} 声明了非法时长上限 {limits.max_duration_s}"


# ── 时长闸门前置：读字节之前就拒 ──────────────────────────────────────────────
#
# 闸门前置的意义：大小闸门本来就在读字节之前拦，时长闸门却只能等读完 235MB、
# 再落一份临时文件才能判——为了说一句"太长了"，先花掉 470MB 的 IO。
# 下面的用例锁住"读之前就拒"这个性质。


def test_probe_video_at_reads_the_stored_file_without_copying_it(monkeypatch, tmp_path):
    """按路径探测：ffprobe 直接对存储里的文件跑，不落临时文件、不复制一遍。"""
    import asyncio
    from pathlib import Path

    from agent.media import video as media_video

    target = tmp_path / "v.mp4"
    target.write_bytes(b"not-a-real-video")

    class FakeStorage:
        def local_path(self, key):
            return target

    monkeypatch.setattr("app.services.storage.get_storage", lambda: FakeStorage())

    seen = {}

    def fake_ffprobe(path):
        seen["path"] = path
        return {"codec": "h264", "width": 1920, "height": 1080,
                "bit_rate": 5_000_000, "duration": 12.5}

    monkeypatch.setattr(media_video, "_ffprobe_info", fake_ffprobe)

    info = asyncio.run(media_video.probe_video_at("u1/v.mp4"))

    assert info["duration"] == 12.5
    assert seen["path"] == str(target), "应该探测存储里的原文件，而不是复制一份"


def test_probe_video_at_returns_none_when_no_local_path(monkeypatch):
    """对象存储（没有本地副本）→ 返回 None，调用方回退到字节探测。"""
    import asyncio

    from agent.media import video as media_video

    class OssLikeStorage:
        def local_path(self, key):
            return None

    monkeypatch.setattr("app.services.storage.get_storage", lambda: OssLikeStorage())

    assert asyncio.run(media_video.probe_video_at("u1/v.mp4")) is None


def test_prepare_video_media_skips_probe_when_duration_already_known(monkeypatch):
    """时长已知（调用方在读字节之前探好了）→ 不再跑任何探测。"""
    import asyncio

    from agent.media import video as media_video

    async def boom(*_args, **_kwargs):
        raise AssertionError("时长已知时不该再探测")

    monkeypatch.setattr(media_video, "probe_video", boom)
    monkeypatch.setattr(media_video, "probe_video_at", boom)

    result = asyncio.run(media_video.prepare_video_media(
        b"x" * 1024, "video/mp4", "v.mp4", _m3_cfg(), duration=60.0))
    assert result["mode"] == "base64"


def test_prepare_video_media_falls_back_to_byte_probe_without_local_path(monkeypatch):
    """没有本地路径可探（对象存储）→ 仍按字节探测，行为与优化前一致。"""
    import asyncio

    from agent.media import video as media_video

    probed = []

    async def no_path_probe(_storage_key):
        return None

    async def fake_probe(raw):
        probed.append(raw)
        return {"codec": "h264", "width": 1920, "height": 1080,
                "bit_rate": 5_000_000, "duration": 60.0}

    monkeypatch.setattr(media_video, "probe_video_at", no_path_probe)
    monkeypatch.setattr(media_video, "probe_video", fake_probe)

    result = asyncio.run(media_video.prepare_video_media(
        b"x" * 1024, "video/mp4", "v.mp4", _m3_cfg(), storage_key="u1/v.mp4"))

    assert probed == [b"x" * 1024], "没有本地路径时必须回退到字节探测"
    assert result["mode"] == "base64"


def test_check_video_duration_rejects_when_duration_unknown(monkeypatch):
    """确认不了时长 → fail-closed 拒绝，不当成"没超限"放行。"""
    import pytest

    from agent.media import video as media_video

    with pytest.raises(ValueError, match="无法确认视频时长"):
        media_video.check_video_duration(None, _m3_cfg())

    with pytest.raises(ValueError, match="无法确认视频时长"):
        media_video.check_video_duration(0, _m3_cfg())


def test_local_storage_backend_exposes_local_path(tmp_path):
    """本地后端给出可直接读写的路径；对象存储没有本地副本 → None。"""
    from app.services.storage import LocalStorageBackend

    backend = LocalStorageBackend(tmp_path)
    assert backend.local_path("u1/v.mp4") == tmp_path / "u1" / "v.mp4"
