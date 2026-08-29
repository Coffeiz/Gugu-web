"""音频转码：把 IM 语音（QQ=SILK、飞书=opus 等）转成 mimo 能吃的格式（mp3）。

mimo 音频理解只收 mp3/wav/flac/m4a/ogg（见 chat_attach.AUDIO_EXTS）；而 IM 语音多是
SILK / opus / amr 这类，必须先转码。本件**优雅降级**：缺 ffmpeg / pilk 时一律返回 None，
调用方退回文字提示，绝不报错、不阻塞网关。

依赖（装了才生效）：
- `ffmpeg`（系统包）：通用音频转码（amr/opus/aac/m4a/ogg/wav → mp3）。
- `pilk`（pip）：QQ/微信的 SILK 解码 → pcm，再经 ffmpeg 封 mp3。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

def _native_audio_exts(adapter=None) -> frozenset[str]:
    """读取目标适配器的原生音频格式；未传适配器时保留旧 MiMo 默认。"""
    if adapter is not None:
        return adapter.audio_native_exts()
    from agent.providers.mimo import MimoAdapter
    return MimoAdapter().audio_native_exts()


def _ffmpeg_bin() -> str | None:
    """找 ffmpeg 可执行：先 PATH，再常见绝对路径兜底。
    ⚠️ 关键：IM 网关进程的 PATH 常被收窄到只有 `.venv/bin`（不含 /usr/bin），
    单靠 shutil.which 会找不到系统装的 ffmpeg → 转码静默失败。"""
    p = shutil.which("ffmpeg")
    if p:
        return p
    for c in ("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/snap/bin/ffmpeg"):
        if os.path.exists(c):
            return c
    return None


def _ffprobe_bin() -> str | None:
    """找 ffprobe（随 ffmpeg 一起装）；同样兜底绝对路径（IM 网关 PATH 收窄）。"""
    p = shutil.which("ffprobe")
    if p:
        return p
    for c in ("/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe", "/snap/bin/ffprobe"):
        if os.path.exists(c):
            return c
    return None


def probe_duration(data: bytes, ext: str | None) -> float | None:
    """探测音频时长（秒，1 位小数）。没 ffprobe / 失败 → None（前端按未知时长显示）。"""
    ff = _ffprobe_bin()
    if not ff:
        return None
    tmpdir = tempfile.mkdtemp(prefix="gugu_probe_")
    try:
        src = os.path.join(tmpdir, "in" + (("." + (ext or "").lower()) if ext else ""))
        with open(src, "wb") as f:
            f.write(data)
        r = subprocess.run([ff, "-v", "quiet", "-show_entries", "format=duration",
                            "-of", "default=nk=1:nw=1", src], capture_output=True, timeout=30)
        out = (r.stdout or b"").decode().strip()
        return round(float(out), 1) if (r.returncode == 0 and out) else None
    except Exception:
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _is_silk(data: bytes) -> bool:
    # 标准 SILK 头 "#!SILK_V3"；腾讯系常在前面多一个 \x02 字节
    head = data[:12]
    return b"#!SILK" in head


def to_provider_audio(data: bytes, ext: str, content_type: str | None, adapter=None) -> bytes | None:
    """按目标适配器的原生格式准备音频；已支持格式原样返回，否则转成 mp3。
    否则（非音频 / 缺工具 / 失败）→ None。"""
    ext = (ext or "").lower()
    ct = (content_type or "").lower()
    if ext in _native_audio_exts(adapter):
        return data                      # 已支持，免转
    looks_audio = ext in ("silk", "sil", "slk", "amr", "opus", "aac", "wma") \
        or ct.startswith("audio") or "voice" in ct or _is_silk(data)
    if not looks_audio:
        return None                      # 不是音频，交给图片/视频/二进制各自处理
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        return None                      # 没 ffmpeg，转不了 → 文字提示兜底

    tmpdir = tempfile.mkdtemp(prefix="gugu_audio_")
    try:
        out_mp3 = os.path.join(tmpdir, "out.mp3")
        if _is_silk(data) or ext in ("silk", "sil", "slk"):
            # SILK：pilk 解成裸 pcm（24k 单声道），再 ffmpeg 封 mp3
            try:
                import pilk
            except Exception:
                return None              # 没 pilk，解不了 silk → 兜底
            src = os.path.join(tmpdir, "in.silk")
            pcm = os.path.join(tmpdir, "in.pcm")
            with open(src, "wb") as f:
                f.write(data)            # pilk 自带腾讯 \x02 前缀处理，原样喂
            # ⚠️ pilk.decode 默认解成 **24kHz 单声道** pcm；其返回值是时长/状态、**不是采样率**——
            #    曾误当采样率传给 ffmpeg -ar 导致把 pcm 当 2Hz 读、生成 25MB「7 小时」mp3。固定用 24000。
            pilk.decode(src, pcm)
            cmd = [ffmpeg, "-y", "-f", "s16le", "-ar", "24000", "-ac", "1",
                   "-i", pcm, "-codec:a", "libmp3lame", "-q:a", "4", out_mp3]
        else:
            # amr/opus/aac/… → ffmpeg 直转 mp3（ffmpeg 自动识别输入格式）
            src = os.path.join(tmpdir, "in" + (("." + ext) if ext else ""))
            with open(src, "wb") as f:
                f.write(data)
            cmd = [ffmpeg, "-y", "-i", src, "-codec:a", "libmp3lame", "-q:a", "4", out_mp3]
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        if r.returncode != 0 or not os.path.exists(out_mp3) or os.path.getsize(out_mp3) == 0:
            return None
        with open(out_mp3, "rb") as f:
            return f.read()
    except Exception:
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
