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

    probe = {"width": 1440, "height": 2560, "bit_rate": 5_000_000}
    result = asyncio.run(chat_attach._compress_video(b"RAW_VIDEO", probe))
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


def test_probe_video_falls_back_to_format_duration_when_stream_missing(monkeypatch):
    """部分容器（尤其某些 mov/mp4 变体）只把 duration 记在 format 层，流层没有这个
    字段——只读 stream.duration 会让这些视频的探测结果变成 0 秒，>=120 秒直接拒绝
    这条规则形同虚设（code review 指出）。这里模拟 stream 里没有 duration，
    format 里有，验证最终探测结果能正确取到 format 层的值。"""
    import asyncio
    import json
    import subprocess
    from app.core import chat_attach

    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(
            cmd, 0,
            stdout=json.dumps({
                "streams": [{"codec_name": "h264", "width": 1920, "height": 1080, "bit_rate": 5000000}],
                "format": {"duration": "125.5"},
            }),
        )

    async def fake_to_thread(fn, *a, **k):
        return fn(*a, **k)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    result = asyncio.run(chat_attach._probe_video(b"RAW_VIDEO"))
    assert result["duration"] == 125.5


def test_probe_video_duration_takes_the_longer_of_stream_and_format(monkeypatch):
    """stream/format 两层都有 duration 时取较大值，不是无条件信任某一层——
    "整段视频不能超过 2 分钟"这条硬限制应该按更长的估计值判断，用 max 而不是
    "谁先非零用谁"（or），否则某一层元数据不完整（比如只有 10 秒）而另一层是
    真实的 125 秒时会误判成"没超"，放过一个实际超限的视频（code review 指出）。"""
    import asyncio
    import json
    import subprocess
    from app.core import chat_attach

    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(
            cmd, 0,
            stdout=json.dumps({
                "streams": [{"codec_name": "h264", "width": 1920, "height": 1080,
                             "bit_rate": 5000000, "duration": "10.0"}],
                "format": {"duration": "125.5"},
            }),
        )

    async def fake_to_thread(fn, *a, **k):
        return fn(*a, **k)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    result = asyncio.run(chat_attach._probe_video(b"RAW_VIDEO"))
    assert result["duration"] == 125.5


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
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 60.0}

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
    """>90MB 源文件，转码后仍 >90MB → 明确拒绝，不生成注定失败的 base64。

    95MB 源文件本身就超过 VIDEO_MMFILE_MAX，会触发转码尝试（见
    test_prepare_video_media_source_over_90mb_still_tries_transcode_first）；
    这里 mock 转码"压完还是太大"，验证最终仍然正确拒绝。"""
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
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 60.0}

    async def fake_compress(raw, probe=None):
        return b"x" * (95 * 1024 * 1024)   # 压完还是太大

    monkeypatch.setattr(chat_attach, "get_meta", fake_get_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", fake_read_bytes)
    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)
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
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 60.0}

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


def test_resolve_for_message_calls_shared_prepare_video_media(monkeypatch):
    """聊天附件视频路径必须调用公共的 prepare_video_media，不能自己另外维护一套
    决策逻辑——跟 read_file 的 read_video 是唯一共用的一处真相来源。"""
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    size = 1024
    meta = _make_video_meta(size)
    calls = {"n": 0}

    async def fake_get_meta(uid, aid):
        return meta

    async def fake_read_bytes(meta):
        return b"x" * size

    real_prepare = chat_attach.prepare_video_media

    async def spy_prepare(raw, mime, name, model_cfg):
        calls["n"] += 1
        return await real_prepare(raw, mime, name, model_cfg)

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 5.0}

    monkeypatch.setattr(chat_attach, "get_meta", fake_get_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", fake_read_bytes)
    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "prepare_video_media", spy_prepare)
    monkeypatch.setattr(chat_attach, "_minimax_video_enabled", lambda cfg: True)
    monkeypatch.setattr(chat_attach, "_video_enabled", lambda cfg=None: True)

    cfg = SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic",
                          model="MiniMax-M3", vision_video=True)
    asyncio.run(chat_attach.resolve_for_message("u1", ["a1"], "hi", model_cfg=cfg))
    assert calls["n"] == 1


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
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 60.0}

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


def _minimax_cfg():
    from types import SimpleNamespace
    return SimpleNamespace(provider="minimax", base_url="https://api.minimaxi.com/anthropic", model="MiniMax-M3")


def test_prepare_video_media_minimax_small_uses_base64(monkeypatch):
    import asyncio
    from app.core import chat_attach

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 10.0}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)

    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", _minimax_cfg()))
    assert result["mode"] == "base64"
    assert result["type"] == "video"


def test_prepare_video_media_minimax_between_45_and_90mb_uses_mmfile(monkeypatch):
    """转码后落在 (45MB, 90MB] 区间 → mm_file（阈值 monkeypatch 成 KB 级，不构造真实大 bytes）。"""
    import asyncio
    from app.core import chat_attach

    monkeypatch.setattr(chat_attach, "VIDEO_BASE64_MAX", 10)
    monkeypatch.setattr(chat_attach, "VIDEO_MMFILE_MAX", 100)

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 10.0}

    async def fake_upload(raw, name, cfg):
        assert name == "v.mp4"
        return "file-abc"

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)

    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 50, "video/mp4", "v.mp4", _minimax_cfg()))
    assert result == {"type": "video", "mode": "mm_file", "mime": "video/mp4", "file_id": "file-abc"}


def test_prepare_video_media_minimax_mmfile_upload_failure_raises(monkeypatch):
    """上传失败必须抛异常，不能悄悄回退成注定超限的 base64。"""
    import asyncio
    from app.core import chat_attach

    monkeypatch.setattr(chat_attach, "VIDEO_BASE64_MAX", 10)
    monkeypatch.setattr(chat_attach, "VIDEO_MMFILE_MAX", 100)

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 10.0}

    async def fake_upload(raw, name, cfg):
        return None

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)

    with pytest.raises(ValueError, match="上传失败"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 50, "video/mp4", "v.mp4", _minimax_cfg()))


def test_prepare_video_media_transcode_failure_does_not_silently_use_original(monkeypatch):
    """规则要求必须转码时（比如 2K 视频超 1080p），转码失败不能静默改用未转码的原始
    视频——那样会违反"超 1080p 必须先压"这条规则却完全没有任何提示（code review
    指出的真实风险）。这里模拟一个明确需要转码（分辨率超 1080p）但 _compress_video
    失败（返回 None，比如 ffmpeg 崩溃/不存在）的场景，必须抛异常，不能继续拿原始
    2K 字节去走 base64/mm_file。"""
    import asyncio
    from app.core import chat_attach

    async def fake_probe(raw):
        return {"width": 2560, "height": 1440, "bit_rate": 5_000_000, "duration": 10.0}

    async def fake_compress_fails(raw, probe=None):
        return None

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress_fails)

    with pytest.raises(ValueError, match="转码失败"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", _minimax_cfg()))


def test_prepare_video_media_source_limits_apply_to_non_minimax_too(monkeypatch):
    """源文件处理上限（>500MB / >=120秒）是"服务器愿不愿意尝试处理"这一层的产品
    限制，跟 provider 无关，必须对所有 provider 统一生效——不能只在 MiniMax 分支
    里判断，导致非 MiniMax provider 完全不受这条限制约束（code review 指出）。"""
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 120.0}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    mimo_cfg = SimpleNamespace(provider="mimo", base_url="https://api.xiaomimimo.com/v1", model="mimo-vl")

    with pytest.raises(ValueError, match="120"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", mimo_cfg))


def test_prepare_video_media_over_mmfile_max_still_tries_transcode_first(monkeypatch):
    """核心行为：源文件超过 VIDEO_MMFILE_MAX 不能直接拒绝——90MB 是最终 payload 上限，
    不是源文件上限，压缩可能把体积压下来，必须先尝试转码。这里模拟 186MB/90s/1080p/12Mbps
    的源视频（分辨率码率都不超阈值，只有文件大小超），压缩成 70MB 后走 mm_file。"""
    import asyncio
    from app.core import chat_attach

    monkeypatch.setattr(chat_attach, "VIDEO_SOURCE_MAX", 1000)
    monkeypatch.setattr(chat_attach, "VIDEO_MMFILE_MAX", 100)   # "源文件" 186 单位 > 100
    monkeypatch.setattr(chat_attach, "VIDEO_BASE64_MAX", 50)    # "压缩后" 70 单位 > 50 → mm_file

    calls = {"compress": 0}

    async def fake_probe(raw):
        # 分辨率/码率都不超阈值——只有文件大小超，验证 size 本身也能触发转码。
        return {"width": 1920, "height": 1080, "bit_rate": 12_000_000, "duration": 90.0}

    async def fake_compress(raw, probe=None):
        calls["compress"] += 1
        return b"x" * 70   # 压缩后 70 单位，落在 (50, 100] 区间

    async def fake_upload(raw, name, cfg):
        return "file-compressed"

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)

    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 186, "video/mp4", "v.mp4", _minimax_cfg()))
    assert calls["compress"] == 1, "源文件超过 VIDEO_MMFILE_MAX 必须尝试转码，不能直接拒绝"
    assert result == {"type": "video", "mode": "mm_file", "mime": "video/mp4", "file_id": "file-compressed"}


def test_prepare_video_media_transcode_still_over_limit_rejected(monkeypatch):
    """转码后仍然超过最终 payload 上限，才允许拒绝——186MB 压缩到 100（monkeypatch 后的
    单位）仍 >90（VIDEO_MMFILE_MAX），最终拒绝，不生成注定失败的 base64/mm_file。"""
    import asyncio
    from app.core import chat_attach

    monkeypatch.setattr(chat_attach, "VIDEO_SOURCE_MAX", 1000)
    monkeypatch.setattr(chat_attach, "VIDEO_MMFILE_MAX", 90)
    monkeypatch.setattr(chat_attach, "VIDEO_BASE64_MAX", 45)

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 12_000_000, "duration": 90.0}

    async def fake_compress(raw, probe=None):
        return b"x" * 100   # 压完还是超过 VIDEO_MMFILE_MAX(90)

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    with pytest.raises(ValueError, match="90MB"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 186, "video/mp4", "v.mp4", _minimax_cfg()))


def test_prepare_video_media_final_payload_boundaries(monkeypatch):
    """转码后按最终 payload 大小三分：≤45MB base64 / (45MB,90MB] mm_file / >90MB 拒绝
    （用 monkeypatch 阈值 + 转码产物大小直接命中三个区间，不构造真实大 bytes）。"""
    import asyncio
    from app.core import chat_attach

    monkeypatch.setattr(chat_attach, "VIDEO_SOURCE_MAX", 1000)
    monkeypatch.setattr(chat_attach, "VIDEO_MMFILE_MAX", 90)
    monkeypatch.setattr(chat_attach, "VIDEO_BASE64_MAX", 45)

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 12_000_000, "duration": 10.0}

    async def fake_upload(raw, name, cfg):
        return "fid"

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_upload_video_mmfile", fake_upload)

    def _compress_to(n):
        async def _f(raw, probe=None):
            return b"x" * n
        return _f

    # 40（monkeypatch 单位）→ base64
    monkeypatch.setattr(chat_attach, "_compress_video", _compress_to(40))
    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 200, "video/mp4", "v.mp4", _minimax_cfg()))
    assert result["mode"] == "base64"

    # 70（monkeypatch 单位）→ mm_file
    monkeypatch.setattr(chat_attach, "_compress_video", _compress_to(70))
    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 200, "video/mp4", "v.mp4", _minimax_cfg()))
    assert result["mode"] == "mm_file"

    # 100（monkeypatch 单位）→ 拒绝
    monkeypatch.setattr(chat_attach, "_compress_video", _compress_to(100))
    with pytest.raises(ValueError, match="90MB"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 200, "video/mp4", "v.mp4", _minimax_cfg()))


def test_prepare_video_media_rejects_when_duration_cannot_be_determined(monkeypatch):
    """时长上限是硬限制——ffprobe 失败/两层都拿不到 duration 时不能 fail-open
    放行，必须 fail-closed 拒绝（code review 指出：确认不了时长不等于没超限）。"""
    import asyncio
    from app.core import chat_attach

    async def fake_probe(raw):
        return None   # 模拟 ffprobe 彻底失败

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)

    with pytest.raises(ValueError, match="无法确认视频时长"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", _minimax_cfg()))


def test_prepare_video_media_rejects_duration_over_120s_without_transcoding(monkeypatch):
    """时长 >=120 秒直接拒绝，不跑转码——服务器不该为明显超出产品范围的长视频跑 ffmpeg。"""
    import asyncio
    from app.core import chat_attach

    calls = {"compress": 0}

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 120.0}

    async def fake_compress(raw, probe=None):
        calls["compress"] += 1
        return b"small"

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    monkeypatch.setattr(chat_attach, "_compress_video", fake_compress)

    with pytest.raises(ValueError, match="120"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", _minimax_cfg()))
    assert calls["compress"] == 0, "超时长应该在转码之前就拒绝"


def test_prepare_video_media_allows_119_seconds(monkeypatch):
    """119 秒（刚好低于上限）应该正常继续处理，不因时长被拒绝。"""
    import asyncio
    from app.core import chat_attach

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 119.0}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)

    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", _minimax_cfg()))
    assert result["mode"] == "base64"


def test_prepare_video_media_rejects_source_over_500mb_without_probing(monkeypatch):
    """源文件 >500MB（VIDEO_SOURCE_MAX，monkeypatch 成 KB 级）直接拒绝，连 ffprobe 都不跑——
    服务器不该为明显超出产品范围的超大文件做任何昂贵处理。"""
    import asyncio
    from app.core import chat_attach

    monkeypatch.setattr(chat_attach, "VIDEO_SOURCE_MAX", 100)

    calls = {"probe": 0}

    async def fake_probe(raw):
        calls["probe"] += 1
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 10.0}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)

    with pytest.raises(ValueError, match="500MB"):
        asyncio.run(chat_attach.prepare_video_media(b"x" * 200, "video/mp4", "v.mp4", _minimax_cfg()))
    assert calls["probe"] == 0, "超源文件上限应该在探测之前就拒绝"


def test_prepare_video_media_allows_under_500mb(monkeypatch):
    """刚好低于 VIDEO_SOURCE_MAX 应该正常继续处理。"""
    import asyncio
    from app.core import chat_attach

    monkeypatch.setattr(chat_attach, "VIDEO_SOURCE_MAX", 100)

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 10.0}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)

    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 99, "video/mp4", "v.mp4", _minimax_cfg()))
    assert result["mode"] == "base64"


def _run_compress_capture_cmd(monkeypatch, probe):
    import asyncio
    import subprocess
    from app.core import chat_attach

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        out_path = cmd[-1]
        with open(out_path, "wb") as f:
            f.write(b"FAKE_MP4")
        return subprocess.CompletedProcess(cmd, 0)

    async def fake_to_thread(fn, *a, **k):
        return fn(*a, **k)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    asyncio.run(chat_attach._compress_video(b"RAW_VIDEO", probe))
    return captured["cmd"]


def test_compress_video_720p_keeps_original_resolution_no_upscale(monkeypatch):
    """720p（≤1080p）视频因体积过大触发转码时，输出必须保持 720p，不能被放大成
    1920x1080——不再依赖 ffmpeg `scale` 滤镜"decrease 只缩不放"这个隐式语义，
    `_compress_video` 由调用方传入的 `probe` 显式决定要不要缩：探测到的长边
    没有超过 1080p 时，命令里完全不应该出现 `-vf` 缩放滤镜（code review 指出：
    只检查命令里出现 "decrease" 字样不足以证明分辨率没被改变，必须证明"根本
    没有对分辨率做任何改动"）。"""
    cmd = _run_compress_capture_cmd(monkeypatch, {"width": 1280, "height": 720, "bit_rate": 5_000_000})
    assert "-vf" not in cmd, "≤1080p 的视频转码时不应该带任何缩放滤镜"


def test_compress_video_2k_downscales_to_1080p(monkeypatch):
    """2K/4K（>1080p）视频转码时必须缩到 ≤1080p，且用 decrease + 偶数宽高的滤镜写法。"""
    cmd = _run_compress_capture_cmd(monkeypatch, {"width": 2560, "height": 1440, "bit_rate": 5_000_000})
    vf = cmd[cmd.index("-vf") + 1]
    assert "force_original_aspect_ratio=decrease" in vf
    assert "trunc(iw/2)*2" in vf


def test_compress_video_no_probe_keeps_original_resolution(monkeypatch):
    """探测不到分辨率（`probe=None`）时保守不缩——不擅自假设视频超限。"""
    cmd = _run_compress_capture_cmd(monkeypatch, None)
    assert "-vf" not in cmd


def test_prepare_video_media_non_minimax_under_36mb_uses_base64(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 5.0}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
    cfg = SimpleNamespace(provider="mimo", base_url="https://api.xiaomimimo.com/v1", model="mimo-vl")
    result = asyncio.run(chat_attach.prepare_video_media(b"x" * 1024, "video/mp4", "v.mp4", cfg))
    assert result["mode"] == "base64"


def test_prepare_video_media_non_minimax_over_36mb_rejected(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.core import chat_attach

    async def fake_probe(raw):
        return {"width": 1920, "height": 1080, "bit_rate": 5_000_000, "duration": 5.0}

    monkeypatch.setattr(chat_attach, "_probe_video", fake_probe)
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
