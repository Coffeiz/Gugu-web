"""chat_attach 视频处理逻辑测试：压缩触发判断、mm_file 块构建。

覆盖新增的 MiniMax M3 大视频链路（探测→压缩→base64/mm_file），
以及 build_user_content 对 mm_file 视频块的生成。ffmpeg 依赖用 mock 隔离。
"""
import pytest


# ── _should_compress_video：压缩触发判断 ─────────────────────────────────────
def test_should_compress_4k_high_bitrate():
    from app.core.chat_attach import _should_compress_video
    # 4K + 高码率 → 压
    assert _should_compress_video({"width": 3840, "height": 2160, "bit_rate": 20_000_000}) is True


def test_should_compress_4k_low_bitrate():
    from app.core.chat_attach import _should_compress_video
    # 4K 但低码率 → 分辨率超 1080p，仍压
    assert _should_compress_video({"width": 3840, "height": 2160, "bit_rate": 5_000_000}) is True


def test_should_compress_1080p_high_bitrate():
    from app.core.chat_attach import _should_compress_video
    # 1080p 但码率 >16M → 压
    assert _should_compress_video({"width": 1920, "height": 1080, "bit_rate": 20_000_000}) is True


def test_should_not_compress_1080p_low_bitrate():
    from app.core.chat_attach import _should_compress_video
    # 1080p + 低码率 → 不压
    assert _should_compress_video({"width": 1920, "height": 1080, "bit_rate": 5_000_000}) is False


def test_should_not_compress_none_probe():
    from app.core.chat_attach import _should_compress_video
    # 探测失败 → 不压（保守，避免误伤）
    assert _should_compress_video(None) is False


def test_should_not_compress_zero_bitrate():
    from app.core.chat_attach import _should_compress_video
    # 容器未带码率（bit_rate=0）→ 只看分辨率
    assert _should_compress_video({"width": 1920, "height": 1080, "bit_rate": 0}) is False
    assert _should_compress_video({"width": 3840, "height": 2160, "bit_rate": 0}) is True


# ── build_user_content：mm_file 视频块 ───────────────────────────────────────
def test_build_user_content_mm_file_video():
    from app.core.chat_attach import build_user_content
    media = [{"type": "video", "mode": "mm_file", "mime": "video/mp4", "file_id": "12345"}]
    content = build_user_content("hi", [], True, media=media)
    video_blk = [b for b in content if isinstance(b, dict) and b.get("type") == "video"]
    assert len(video_blk) == 1
    assert video_blk[0]["source"] == {"type": "url", "url": "mm_file://12345"}


def test_build_user_content_base64_video():
    from app.core.chat_attach import build_user_content
    media = [{"type": "video", "mode": "base64", "mime": "video/mp4", "b64": "AAAA"}]
    content = build_user_content("hi", [], True, media=media)
    video_blk = [b for b in content if isinstance(b, dict) and b.get("type") == "video"]
    assert len(video_blk) == 1
    assert video_blk[0]["source"]["type"] == "base64"
    assert video_blk[0]["source"]["data"] == "AAAA"


def test_build_user_content_mm_file_missing_fid_falls_back_base64():
    from app.core.chat_attach import build_user_content
    # mm_file 缺 file_id 但有 b64 → 退回 base64
    media = [{"type": "video", "mode": "mm_file", "mime": "video/mp4", "b64": "AAAA"}]
    content = build_user_content("hi", [], True, media=media)
    video_blk = [b for b in content if isinstance(b, dict) and b.get("type") == "video"]
    assert len(video_blk) == 1
    assert video_blk[0]["source"]["type"] == "base64"
    assert video_blk[0]["source"]["data"] == "AAAA"


def test_build_user_content_video_missing_all_data_skipped():
    from app.core.chat_attach import build_user_content
    # file_id 和 b64 都缺（数据异常）→ 跳过该块，不崩
    media = [{"type": "video", "mode": "mm_file", "mime": "video/mp4"}]
    content = build_user_content("hi", [], True, media=media)
    video_blk = [b for b in content if isinstance(b, dict) and b.get("type") == "video"]
    assert len(video_blk) == 0


def test_build_user_content_openai_video_ignores_mm_file():
    from app.core.chat_attach import build_user_content
    # OpenAI 路（mimo 等）不识别 mm_file，仍走 video_url base64
    media = [{"type": "video", "mode": "mm_file", "mime": "video/mp4", "file_id": "12345", "b64": "AAAA"}]
    content = build_user_content("hi", [], False, media=media)
    video_blk = [b for b in content if isinstance(b, dict) and b.get("type") == "video_url"]
    assert len(video_blk) == 1
    assert "data:video/mp4;base64,AAAA" in video_blk[0]["video_url"]["url"]


# ── _minimax_video_enabled：MiniMax M3 判定 ──────────────────────────────────
def test_minimax_video_enabled_m3():
    from types import SimpleNamespace
    from app.core.chat_attach import _minimax_video_enabled
    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic", model="MiniMax-M3")
    assert _minimax_video_enabled(cfg) is True


def test_minimax_video_enabled_non_m3():
    from types import SimpleNamespace
    from app.core.chat_attach import _minimax_video_enabled
    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic", model="MiniMax-M2")
    assert _minimax_video_enabled(cfg) is False


def test_minimax_video_enabled_other_provider():
    from types import SimpleNamespace
    from app.core.chat_attach import _minimax_video_enabled
    cfg = SimpleNamespace(provider="mimo", base_url="https://token-plan-cn.xiaomimimo.com/v1", model="mimo-v2.5-pro")
    assert _minimax_video_enabled(cfg) is False


# ── _compress_video：竖屏长边限制 + 不阻塞事件循环 ───────────────────────────
def test_compress_video_uses_portrait_scale_filter(monkeypatch):
    """竖屏视频的 ffmpeg 滤镜必须限制长边（force_original_aspect_ratio=decrease），
    而不是只限制宽度（旧实现 scale='min(1920,iw)':-2 会让 1440×2560 保持超高高度）。"""
    import asyncio
    import subprocess
    from app.core import chat_attach

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        # 模拟 ffmpeg 成功，并生成一个假输出文件
        out_path = cmd[-1]
        with open(out_path, "wb") as f:
            f.write(b"FAKE_MP4")
        return subprocess.CompletedProcess(cmd, 0)

    async def fake_to_thread(fn, *a, **k):
        return fn(*a, **k)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    result = asyncio.run(chat_attach._compress_video(b"RAW_VIDEO"))
    assert result == b"FAKE_MP4"
    vf = None
    for i, arg in enumerate(captured["cmd"]):
        if arg == "-vf":
            vf = captured["cmd"][i + 1]
            break
    assert vf is not None
    # 必须用 force_original_aspect_ratio=decrease 限制长边，且输出宽高取偶数
    assert "force_original_aspect_ratio=decrease" in vf
    assert "trunc(iw/2)*2" in vf
    # 旧实现只限制宽度的 min(1920,iw) 不应再出现
    assert "min(1920,iw)" not in vf


def test_compress_video_uses_to_thread(monkeypatch):
    """ffmpeg 必须通过 asyncio.to_thread 跑，不能直接同步 subprocess.run 阻塞事件循环。"""
    import asyncio
    import subprocess
    from app.core import chat_attach

    called_to_thread = {"n": 0}

    def fake_run(cmd, **kwargs):
        out_path = cmd[-1]
        with open(out_path, "wb") as f:
            f.write(b"FAKE_MP4")
        return subprocess.CompletedProcess(cmd, 0)

    async def fake_to_thread(fn, *a, **k):
        called_to_thread["n"] += 1
        return fn(*a, **k)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    asyncio.run(chat_attach._compress_video(b"RAW_VIDEO"))
    assert called_to_thread["n"] == 1, "ffmpeg 必须经 asyncio.to_thread 执行"


def test_probe_video_uses_to_thread(monkeypatch):
    """ffprobe 必须通过 asyncio.to_thread 跑，不能直接同步 subprocess.run 阻塞事件循环。"""
    import asyncio
    import json
    import subprocess
    from app.core import chat_attach

    called_to_thread = {"n": 0}

    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(
            cmd, 0,
            stdout=json.dumps({"streams": [{"codec_name": "h264", "width": 1920, "height": 1080, "bit_rate": 5000000}]}),
        )

    async def fake_to_thread(fn, *a, **k):
        called_to_thread["n"] += 1
        return fn(*a, **k)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    result = asyncio.run(chat_attach._probe_video(b"RAW_VIDEO"))
    assert called_to_thread["n"] == 1, "ffprobe 必须经 asyncio.to_thread 执行"
    assert result["width"] == 1920


# ── _upload_video_mmfile：成功 / 失败 ────────────────────────────────────────
def test_upload_video_mmfile_success(monkeypatch):
    """mm_file 上传成功返回 file_id。"""
    import asyncio
    import httpx
    from types import SimpleNamespace
    from app.core import chat_attach

    class FakeResp:
        status_code = 200
        def json(self):
            return {"file": {"file_id": 12345}, "base_resp": {"status_code": 0}}

    class FakeClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, *a, **k):
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    cfg = SimpleNamespace(api_key="k", base_url="https://api.minimaxi.com/anthropic")
    fid = asyncio.run(chat_attach._upload_video_mmfile(b"DATA", "v.mp4", cfg))
    assert fid == "12345"


def test_upload_video_mmfile_failure_status(monkeypatch):
    """mm_file 上传非 200 返回 None（不抛异常）。"""
    import asyncio
    import httpx
    from types import SimpleNamespace
    from app.core import chat_attach

    class FakeResp:
        status_code = 500
        def json(self):
            return {}

    class FakeClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, *a, **k):
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    cfg = SimpleNamespace(api_key="k", base_url="https://api.minimaxi.com/anthropic")
    fid = asyncio.run(chat_attach._upload_video_mmfile(b"DATA", "v.mp4", cfg))
    assert fid is None


# ── resolve_for_message：mm_file 失败不回退 base64、超限拒绝 ─────────────────
def _make_video_meta(size):
    return {
        "attach_id": "a1", "name": "v.mp4", "ext": "mp4", "size": size,
        "kind": "video", "mime": "video/mp4", "qq_face": False, "quoted": False,
    }


def test_resolve_mmfile_failure_does_not_fallback_base64(monkeypatch):
    """45–90MB 视频 mm_file 上传失败 → 明确拒绝，**不生成 base64**（base64 注定超 MiniMax 上限）。"""
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 60 * 1024 * 1024  # 60MB
    meta = _make_video_meta(size)

    async def fake_get_meta(uid, aid):
        return meta

    async def fake_read_bytes(meta):
        return b"x" * size

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    async def fake_upload(raw, name, cfg):
        return None  # 上传失败

    monkeypatch.setattr(chat_attach, "get_meta", fake_get_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", fake_read_bytes)
    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)
    monkeypatch.setattr(chat_attach, "_minimax_video_enabled", lambda cfg: True)
    monkeypatch.setattr(chat_attach, "_video_enabled", lambda cfg=None: True)

    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic",
                          model="MiniMax-M3", vision_video=True)
    text, cards, images, media = asyncio.run(
        chat_attach.resolve_for_message("u1", ["a1"], "hi", model_cfg=cfg))
    # 不应生成任何 base64 视频块
    assert media == []
    # 提示里应说明上传失败
    assert "上传失败" in text


def test_resolve_video_over_90mb_rejected(monkeypatch):
    """>90MB 视频 → 明确拒绝，不生成注定失败的 base64。"""
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 95 * 1024 * 1024  # 95MB
    meta = _make_video_meta(size)

    async def fake_get_meta(uid, aid):
        return meta

    async def fake_read_bytes(meta):
        return b"x" * size

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    monkeypatch.setattr(chat_attach, "get_meta", fake_get_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", fake_read_bytes)
    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_minimax_video_enabled", lambda cfg: True)
    monkeypatch.setattr(chat_attach, "_video_enabled", lambda cfg=None: True)

    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic",
                          model="MiniMax-M3", vision_video=True)
    text, cards, images, media = asyncio.run(
        chat_attach.resolve_for_message("u1", ["a1"], "hi", model_cfg=cfg))
    assert media == []
    assert "90MB" in text


def test_resolve_video_under_45mb_base64(monkeypatch):
    """≤45MB 视频 → 走 base64 内联。"""
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 10 * 1024 * 1024  # 10MB
    meta = _make_video_meta(size)

    async def fake_get_meta(uid, aid):
        return meta

    async def fake_read_bytes(meta):
        return b"x" * size

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    monkeypatch.setattr(chat_attach, "get_meta", fake_get_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", fake_read_bytes)
    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_minimax_video_enabled", lambda cfg: True)
    monkeypatch.setattr(chat_attach, "_video_enabled", lambda cfg=None: True)

    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic",
                          model="MiniMax-M3", vision_video=True)
    text, cards, images, media = asyncio.run(
        chat_attach.resolve_for_message("u1", ["a1"], "hi", model_cfg=cfg))
    assert len(media) == 1
    assert media[0]["mode"] == "base64"


def test_resolve_video_45_to_90mb_uses_mmfile_on_success(monkeypatch):
    """45–90MB 视频、mm_file 上传成功 → 走 mm_file，不是 base64。"""
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 60 * 1024 * 1024  # 60MB
    meta = _make_video_meta(size)

    async def fake_get_meta(uid, aid):
        return meta

    async def fake_read_bytes(meta):
        return b"x" * size

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    async def fake_upload(raw, name, cfg):
        return "file-123"

    monkeypatch.setattr(chat_attach, "get_meta", fake_get_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", fake_read_bytes)
    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)
    monkeypatch.setattr(chat_attach, "_minimax_video_enabled", lambda cfg: True)
    monkeypatch.setattr(chat_attach, "_video_enabled", lambda cfg=None: True)

    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic",
                          model="MiniMax-M3", vision_video=True)
    text, cards, images, media = asyncio.run(
        chat_attach.resolve_for_message("u1", ["a1"], "hi", model_cfg=cfg))
    assert len(media) == 1
    assert media[0]["mode"] == "mm_file"
    assert media[0]["file_id"] == "file-123"


# ── prepare_video_media / video_media_to_anthropic_block：read_file 复用的公共入口 ──
# 这是 resolve_for_message（聊天附件）和 file_readers.read_video（文件库 read_file）
# 唯一共用的一份视频决策逻辑，直接单测覆盖，不要求每个调用方各自重复验证阈值。


def test_prepare_video_media_minimax_small_uses_base64(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic", model="MiniMax-M3")

    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", cfg))
    assert result["mode"] == "base64"
    assert result["type"] == "video"


def test_prepare_video_media_minimax_between_45_and_90mb_uses_mmfile(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 60 * 1024 * 1024

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    async def fake_upload(raw, name, cfg):
        assert name == "v.mp4"
        return "file-abc"

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)
    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic", model="MiniMax-M3")

    result = asyncio.run(chat_attach.prepare_video_media(b"x" * size, "video/mp4", "v.mp4", cfg))
    assert result == {"type": "video", "mode": "mm_file", "mime": "video/mp4", "file_id": "file-abc"}


def test_prepare_video_media_minimax_mmfile_upload_failure_raises(monkeypatch):
    """上传失败必须抛异常，不能悄悄回退成注定超限的 base64。"""
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 60 * 1024 * 1024

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    async def fake_upload(raw, name, cfg):
        return None

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)
    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic", model="MiniMax-M3")

    with pytest.raises(ValueError, match="上传失败"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * size, "video/mp4", "v.mp4", cfg))


def test_prepare_video_media_minimax_over_90mb_rejected(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 95 * 1024 * 1024

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic", model="MiniMax-M3")

    with pytest.raises(ValueError, match="90MB"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * size, "video/mp4", "v.mp4", cfg))


def test_prepare_video_media_non_minimax_under_36mb_uses_base64():
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    cfg = SimpleNamespace(provider="mimo", base_url="https://api.xiaomimimo.com/v1", model="mimo-vl")
    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", cfg))
    assert result["mode"] == "base64"


def test_prepare_video_media_non_minimax_over_36mb_rejected():
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 40 * 1024 * 1024
    cfg = SimpleNamespace(provider="mimo", base_url="https://api.xiaomimimo.com/v1", model="mimo-vl")
    with pytest.raises(ValueError, match="超过上限"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * size, "video/mp4", "v.mp4", cfg))


def test_video_media_to_anthropic_block_mm_file():
    from app.core import chat_attach

    block = chat_attach.video_media_to_anthropic_block(
        {"type": "video", "mode": "mm_file", "mime": "video/mp4", "file_id": "fid-1"})
    assert block == {"type": "video", "source": {"type": "url", "url": "mm_file://fid-1"}, "fps": 1}


def test_video_media_to_anthropic_block_base64():
    from app.core import chat_attach

    block = chat_attach.video_media_to_anthropic_block(
        {"type": "video", "mode": "base64", "mime": "video/mp4", "b64": "QUJD"})
    assert block == {"type": "video", "source": {"type": "base64", "media_type": "video/mp4", "data": "QUJD"}}


def test_video_media_to_anthropic_block_missing_data_returns_none():
    from app.core import chat_attach

    assert chat_attach.video_media_to_anthropic_block({"type": "video", "mode": "mm_file"}) is None
