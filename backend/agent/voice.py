"""语音 / 音视频识别（转写）——用独立配置的「语音模型」把 media 转成文字，与主模型解耦。

设计：收到语音/音视频这轮，**不再强切主模型到 mimo**，而是用 `settings.voice` 这个独立模型
把音频转成纯文字，把文字并进用户消息 → 主模型（本轮绑定的 model_cfg，pool/路由选中的那个）照常处理。
- 未配置语音模型（`settings.voice.model` 为空）→ `transcribe` 返回 **None**，调用方据此切断、回「不支持」。
- 配置了但转写失败/空 → 返回空串 `""`，调用方注入一句「没听清」兜底，仍交主模型（不报错）。

旧版 ASR 固定走 **OpenAI 兼容方式**（chat + `input_audio` base64）；
Qwen-Audio-3.0-ASR-Flash 和 Fun-ASR 改走百炼 DashScope 多模态 HTTP 接口。纯 ASR 模型只送音频块、不加文字指令。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import tempfile
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit

from agent.security.logsafe import fingerprint
from app.core.redaction import diag_log, redact
from app.core.credentials import normalize_ascii_api_key

logger = logging.getLogger("agent.voice")

# P2-b §4-A 标杆模板：ASR 是读操作（转写既有音频，不产生外部副作用）——天然幂等，
# 瞬时故障（超时/连接错/5xx）安全重试；4xx（鉴权失败/模型不存在/请求参数错）是永久
# 失败，不在白名单内，直接原样上抛让调用方兜底成「没听清」。
_ASR_RETRY_BACKOFF = [1, 2]   # ASR 单次调用本身较慢，退避拉满会拖累语音消息响应，缩到 2 次

# mimo-v2.5-asr 等 ASR 模型只收这几种容器；浏览器录音多是 audio/mp4(Safari)/audio/webm(Chrome)，
# QQ/微信语音也常是 amr/silk → 一律用 ffmpeg 转 wav 再送。
_ASR_OK_MIME = {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"}
_DASHSCOPE_SERVICES = {"qwen3-asr", "qwen-audio", "fun-asr"}


def _dashscope_generation_url(base_url: str) -> str:
    """校验并返回用户填写的百炼原生多模态生成端点。

    DashScope 原生接口不使用 OpenAI 的 ``/compatible-mode/v1`` Base URL；
    这里要求 Admin 直接填写完整 endpoint，避免自动拼接掩盖地域或 Workspace 配置错误。
    """
    parsed = urlsplit((base_url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("语音模型 Base URL 无效")
    path = parsed.path.rstrip("/")
    suffix = "/api/v1/services/aigc/multimodal-generation/generation"
    if not path.endswith(suffix):
        raise ValueError("DashScope Base URL 必须填写完整的多模态生成接口地址")
    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))


def _dashscope_transcript(payload: dict) -> str:
    """读取 DashScope 多模态响应中的文本结果。"""
    output = payload.get("output") or {}
    direct_text = output.get("text")
    if isinstance(direct_text, str):
        return direct_text.strip()
    sentence = output.get("sentence")
    if isinstance(sentence, dict) and isinstance(sentence.get("text"), str):
        return sentence["text"].strip()
    content = ((output.get("choices") or [{}])[0]
               .get("message", {}).get("content", []))
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "".join(
            str(item.get("text") or "") for item in content
            if isinstance(item, dict)
        ).strip()
    return ""


async def _to_wav(raw: bytes) -> bytes | None:
    """用 ffmpeg 把任意音频转成 16k 单声道 WAV。失败返回 None。

    输入走临时文件而非管道：mp4 的 moov 原子可能在尾部、需要可寻址输入，pipe 不可寻址会失败。"""
    # 不能用裸 "ffmpeg"——uvicorn / IM 网关进程 PATH 常被收窄，create_subprocess_exec 直接
    # FileNotFoundError。复用 media_transcode 的解析器（PATH → /usr/bin/ffmpeg 等绝对路径兜底）。
    from app.core.media_transcode import _ffmpeg_bin
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        logger.warning("找不到 ffmpeg 可执行，音频无法转码")
        return None
    fd, inp = tempfile.mkstemp(suffix=".bin")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-nostdin", "-i", inp, "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0 or not out:
            logger.warning("ffmpeg 转码失败 rc=%s: %s", proc.returncode,
                           (err or b"")[-300:].decode("utf-8", "ignore"))
            return None
        return out
    except Exception as e:
        logger.warning("ffmpeg 转码异常 %s: %s", type(e).__name__, str(e)[:200])
        return None
    finally:
        try:
            os.unlink(inp)
        except OSError:
            pass


def _vm(settings):
    """取语音模型配置，兼容它是 VoiceSettings 对象或 dict（不同加载路径下可能是 dict）。"""
    v = settings.get("voice") if isinstance(settings, dict) else getattr(settings, "voice", None)
    return SimpleNamespace(**v) if isinstance(v, dict) else v


def is_configured(settings) -> bool:
    """是否配置了语音识别模型。"""
    vm = _vm(settings)
    return bool(vm and (getattr(vm, "model", "") or "").strip())


async def transcribe(media: list, settings, *, db=None, user_id=None, raise_errors: bool = False) -> str | None:
    """把 media（[{type:'audio'|'video', mime, b64}]）转成文字。
    返回 None = 未配置语音模型（调用方切断回「不支持」）；返回 str = 转写结果（可能为空串）。"""
    vm = _vm(settings)
    if db is not None and user_id is not None:
        from app.byok.service import resolve_capability_settings
        vm = await resolve_capability_settings(db, user_id, "speech_to_text", vm)
    if not vm or not (getattr(vm, "model", "") or "").strip():
        return None
    # 只送音频块（纯 ASR，不加 text 指令）；base64 内联走 data URL（与现有 mimo input_audio 同格式）
    parts = []
    for m in (media or []):
        if m.get("type") == "audio" and m.get("b64"):
            mime = (m.get("mime") or "audio/mpeg").lower()
            b64 = m["b64"]
            # mimo ASR 只收 wav/mp3/mpeg；其余（mp4/webm/amr…）先用 ffmpeg 转 wav
            if mime not in _ASR_OK_MIME:
                wav = await _to_wav(base64.b64decode(b64))
                if wav is None:
                    logger.warning("转写跳过：音频 %s 转 wav 失败", mime)
                    continue
                b64 = base64.b64encode(wav).decode()
                mime = "audio/wav"
            data_url = f"data:{mime};base64,{b64}"
            parts.append({"type": "input_audio", "input_audio": {"data": data_url}})
    if not parts:
        logger.info("转写跳过：media 里没有 audio 块（types=%s）", [m.get("type") for m in (media or [])])
        return ""   # 没有可转写的音频（如纯视频）→ 调用方兜底为「没听清」
    from agent import providers
    import httpx
    import openai as _openai
    # 窄白名单：只有连接级/超时/5xx/429 算瞬时，安全重试（读操作，天然幂等）；
    # 鉴权失败/参数错/模型不存在等 4xx（openai.APIStatusError 但非 5xx/429）不在白名单内，
    # 会落进下面的 except Exception 分支直接回空串——不重试。
    transient = (_openai.APITimeoutError, _openai.APIConnectionError,
                 _openai.InternalServerError, _openai.RateLimitError,
                 httpx.TimeoutException, httpx.NetworkError)
    native_dashscope = (getattr(vm, "api_format", "") or "").strip().lower() == "dashscope"
    dashscope_service = (getattr(vm, "dashscope_service", "qwen3-asr") or "qwen3-asr").strip().lower()
    if native_dashscope and dashscope_service not in _DASHSCOPE_SERVICES:
        raise ValueError("DashScope 语音产品线未选择或暂不支持")
    client = None if native_dashscope else providers.build_openai_client(vm, httpx.Timeout(60.0))
    for i in range(len(_ASR_RETRY_BACKOFF) + 1):
        try:
            if native_dashscope:
                # DashScope 产品线由配置显式选择；不要从模型名前缀猜请求协议。
                if dashscope_service == "qwen3-asr":
                    content = [
                        {"audio": block["input_audio"]["data"]}
                        for block in parts
                    ]
                    parameters = {"asr_options": {"enable_itn": False}}
                elif dashscope_service in {"qwen-audio", "fun-asr"}:
                    content = parts
                    parameters = {"format": "wav", "sample_rate": 16000}
                else:  # 白名单校验已拦截；保留显式分支避免协议静默降级
                    raise ValueError("DashScope 语音产品线未选择或暂不支持")
                data = {
                    "model": vm.model,
                    "input": {"messages": [{"role": "user", "content": content}]},
                    "parameters": parameters,
                }
                headers = {
                    "Authorization": f"Bearer {normalize_ascii_api_key(vm.api_key, label='语音模型 API Key')}",
                    "Content-Type": "application/json",
                    "X-DashScope-SSE": "disable",
                }
                async with httpx.AsyncClient(timeout=60.0) as http:
                    response = await http.post(_dashscope_generation_url(vm.base_url),
                                               headers=headers, json=data)
                    response.raise_for_status()
                    out = _dashscope_transcript(response.json())
            else:
                # 旧 ASR 模型（mimo-v2.5-asr / qwen3-asr-flash）走 OpenAI 兼容接口；
                # 不传 thinking，ASR 模型会拒绝聊天模型专用参数。
                resp = await client.chat.completions.create(
                    model=vm.model, messages=[{"role": "user", "content": parts}],
                    extra_body={"asr_options": {"enable_itn": False}})
                out = (resp.choices[0].message.content or "").strip()
            logger.info("语音转写成功 model=%s → %d 字 fingerprint=%s",
                        vm.model, len(out), fingerprint(out))
            return out
        except transient as e:
            if i >= len(_ASR_RETRY_BACKOFF):
                diag_log("agent.voice.transcribe", e)   # 原始 → 受限诊断出口
                logger.warning("语音转写重试 %d 次后仍失败 model=%s：%s", i, vm.model, type(e).__name__)
                if raise_errors:
                    raise
                # 不上抛 RetryableError：transcribe() 的既有契约是「非 None 即成功（可能空串），
                # 从不抛异常」（见模块 docstring），三处调用方（agent/runner.py、
                # agent/gateway/web.py）都只判断 None/空串，没有 except RetryableError。
                # ASR 是辅助能力，重试用尽后降级成「没听清」优于打断整轮对话——用 diag_log +
                # WARNING 留痕迹（P2-b §1 可重试用尽的处理方式之一是「降级」），不强行改变
                # 这个函数「不抛异常」的调用约定。
                return ""
            logger.info("语音转写瞬时错误 %s，%ss 后重试(%d)", type(e).__name__, _ASR_RETRY_BACKOFF[i], i + 1)
            await asyncio.sleep(_ASR_RETRY_BACKOFF[i])
        except httpx.HTTPStatusError as e:
            if e.response.status_code not in (429,) and e.response.status_code < 500:
                diag_log("agent.voice.transcribe.permanent", e)
                logger.warning("语音转写失败 model=%s base_url=%s → %s",
                               getattr(vm, "model", "?"), getattr(vm, "base_url", "?"),
                               redact(f"HTTP {e.response.status_code}"))
                if raise_errors:
                    raise
                return ""
            if i >= len(_ASR_RETRY_BACKOFF):
                diag_log("agent.voice.transcribe", e)
                logger.warning("语音转写重试 %d 次后仍失败 model=%s：HTTP %s",
                               i, vm.model, e.response.status_code)
                if raise_errors:
                    raise
                return ""
            logger.info("语音转写 HTTP %s，%ss 后重试(%d)",
                        e.response.status_code, _ASR_RETRY_BACKOFF[i], i + 1)
            await asyncio.sleep(_ASR_RETRY_BACKOFF[i])
        except Exception as e:
            # 非瞬时（4xx 鉴权/参数错等）或未知错误：失败回空串（调用方兜底为「没听清」），
            # 但打日志——别再静默吞错（model 名错/端点错/鉴权都靠它排查）。原始异常（可能含
            # base_url/请求细节）只进受限诊断出口，可见日志只留脱敏摘要（P2-b §3/§5）。
            diag_log("agent.voice.transcribe.permanent", e)
            logger.warning("语音转写失败 model=%s base_url=%s → %s",
                           getattr(vm, "model", "?"), getattr(vm, "base_url", "?"),
                           redact(f"{type(e).__name__}: {e}"))
            if raise_errors:
                raise
            return ""
    return ""   # 理论不可达（循环内每条路径都 return），留作类型兜底
