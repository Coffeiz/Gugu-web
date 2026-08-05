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
