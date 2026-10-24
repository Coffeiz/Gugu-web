"""附件装配：把暂存附件解析成「注入给模型的增广文本 + 前端气泡卡片 + 媒体块」。

这一层站在附件域（`app/core/chat_attach/`）和媒体域（`agent/media/`）之间——
附件域负责「文件是什么、归谁、存在哪」，媒体域负责「能不能喂给模型、怎么喂」，
这里负责把两者接到本轮消息上。

不要和 `agent/context/assembly/` 混淆：那边组装的是**上下文**（历史、提醒、
canonical 消息区），这边组装的是**附件**。
"""
from __future__ import annotations

from app.core import chat_attach
from app.core.chat_attach.file_types import (
    IMAGE_EXTS,
    VIDEO_EXTS,
    model_attachment_name,
)
from agent.media import gates, images as image_processing, video
from agent.media.constants import IMAGE_READ_MAX, MEDIA_MIME, MEDIA_RAW_MAX
from agent.providers.mimo.media import AUDIO_NATIVE_EXTS
from agent.voice_config import voice_recognition_profile

# 单条消息最多带几张图
IMAGE_COUNT = 6
# 消息注入文本类附件（含 doctext 可提取的 PDF/Office）的读取硬上限：
# 最终只注入 32K 字符，32MB 原文绰绰有余；超大文档留给按需 read_file
TEXT_READ_MAX = 32 * 1024 * 1024


async def resolve_for_message(user_id, attach_ids: list, base_message: str, *, model_cfg=None) -> tuple[str, list, list, list]:
    """把附件解析成：① 注入给模型的增广文本（文本读内容、图片/二进制给提示）
    ② 给前端气泡的附件卡片列表 ③ 图片块列表（仅 image 模型能力开启时提供）。
    失效/过期的 attach_id 跳过。

    `model_cfg`：**这轮真正要跑的模型**（IM 走 pick_model 选 pool/router，可能 ≠ 顶层 ai）。
    传了就按它判 image / media，避免「门控用静态 ai、实跑用别的模型」→ 喂图却看不了 / 不喂却能看
    的不一致（图时好时坏的根因）。没传则退回顶层 settings.ai（web 路一直用激活模型，一致）。"""
    if not attach_ids:
        return base_message, [], [], []
    if model_cfg is not None:
        image = gates.image_enabled(model_cfg)
        video_ok = gates.video_enabled(model_cfg)
        audio_ok = gates.audio_enabled(model_cfg)
    else:
        image = gates.image_enabled()
        video_ok = gates.video_enabled()
        audio_ok = gates.audio_enabled()
    voice_ok, voice_max_bytes = await voice_recognition_profile(user_id)
    provider_media_limits = gates.media_limits_for(model_cfg)
    audio_raw_max = (
        voice_max_bytes if voice_ok and not audio_ok
        else provider_media_limits.audio_max_bytes
    )
    parts = [base_message] if base_message else []
    cards = []
    images: list = []      # [{media_type, b64}]，仅 image 能力开启时填
    media_items: list = []  # [{type:'audio'|'video', mime, b64}]，仅对应维度开启时填
    for aid in attach_ids:
        meta = await chat_attach.get_meta(user_id, aid)
        if not meta:
            continue
        cards.append({
            "attach_id": meta["attach_id"], "name": meta["name"], "ext": meta["ext"],
            "size_bytes": meta["size"], "kind": meta["kind"], "upload": True,
            "mime": meta.get("mime"),
            "qq_face": bool(meta.get("qq_face")),
            "quoted": bool(meta.get("quoted")),
            "duration": meta.get("duration"),   # 语音条用：前端显示时长 + 渲染成播放条
            "img_width": meta.get("img_width"), "img_height": meta.get("img_height"),
        })
        fname = model_attachment_name(meta)
        tag = f"《{fname}》(attach_id={meta['attach_id']})"
        if meta["kind"] == "text":
            # 消费侧硬门：文本/PDF/Office 在 read_text 里都是先整包 read_bytes 再提取、
            # 最后才截到 32K 字符；超限直接不读，超大文档留给按需 read_file。
            if meta["size"] > TEXT_READ_MAX:
                # 提示别承诺 read_file：文本读取预算为 32MB，PDF/Office 提取预算为 30MB。
                parts.append(f"\n\n📎 用户上传的文件{tag}（正文过大，超过 {TEXT_READ_MAX // 1048576}MB，未直接读取；"
                             f"可保存到文件库——用户要存就 save_uploaded_file(attach_id)——后续按需处理；"
                             f"read_file 对 PDF/Office 的提取上限更小，不要反复尝试读取全文）。")
            else:
                parts.append(f"\n\n📎 用户上传的文件{tag}，内容如下：\n```\n{await chat_attach.read_text(meta)}\n```")
        elif meta["kind"] == "image":
            ext = (meta.get("ext") or "").lower()
            img_why = None
            # image 能力开启 + 受支持格式 + 没超张数 → 喂给模型真看（超体积/超大尺寸自动压缩）
            if image and ext in IMAGE_EXTS and len(images) < IMAGE_COUNT:
                try:
                    import base64
                    image_limit = provider_media_limits.image_max_bytes
                    if image_limit is not None and meta["size"] > image_limit:
                        raise ValueError(
                            f"图片超过当前 Provider 的单图上限（{image_limit // 1_000_000}MB）"
                        )
                    # 消费侧硬门：图片同样按 meta["size"] 读前拒绝（IMAGE_READ_MAX 与
                    # read_file 看图同一口径），超限走下方「没法直接看」文字提示。
                    if meta["size"] > IMAGE_READ_MAX:
                        raise ValueError(f"文件超过 {IMAGE_READ_MAX // 1048576}MB 读取上限")
                    raw = await chat_attach.read_bytes(meta)
                    fitted = image_processing.fit_image(raw, ext, model_cfg=model_cfg)
                    if fitted:
                        data, img_media_type = fitted   # 别用 `media`——那是音视频列表，会被覆盖成字符串 → aug_media 变 str → transcribe 崩
                        images.append({"media_type": img_media_type,
                                       "b64": base64.b64encode(data).decode()})
                        parts.append(f"\n\n📎 用户上传了图片{tag}（见随附图像）；"
                                     f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
                        continue
                except ValueError as e:
                    # 明确的拒绝原因（如超限）要保留下来，不能吞成「格式不支持」
                    img_why = str(e)
                except Exception:
                    pass   # 读图/压缩失败 → 退回文字提示
            if not image:
                # 没有任何能看图的模型 → **当普通文件处理**：正常收下、按需保存，
                # 别向用户抱怨「看不了图 / 看不到内容」（那样体验很差，用户只是想发个文件）。
                parts.append(f"\n\n📎 用户发来图片{tag}（图片文件；当前没有能看图的模型，"
                             f"**就当普通文件正常处理**——别说「看不了图 / 看不到内容」，正常回应；"
                             f"用户要存就 save_uploaded_file(attach_id) 存进文件库）。")
            else:
                # image 能力开启但这张没喂成（格式不支持 / 超限 / 读图失败）
                parts.append(f"\n\n📎 用户上传了图片{tag}（这张没法直接看：{img_why or '格式不支持'}）；"
                             f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
        elif meta["kind"] in ("audio", "video", "voice"):
            is_voice = meta["kind"] == "voice"
            is_video = meta["kind"] == "video"
            noun = "语音" if is_voice else ("视频" if is_video else "音频")
            ext = (meta.get("ext") or "").lower()
            native = ext in (VIDEO_EXTS if is_video else AUDIO_NATIVE_EXTS)   # 语音转码后是 mp3，按音频判原生
            # 能喂 base64 给模型的条件：① 主模型对应维度开启（视频→video，音频→audio，
            # 走 OpenAI 兼容媒体块 / MiniMax M3 原生块）；② 配了独立语音识别模型（仅音频/语音，
            # 交 transcribe 转文字）。视频仍只走 ①（ASR 听不了画面）。
            can_feed = (video_ok if is_video else audio_ok) or (voice_ok and not is_video)
            # 格式：配了语音识别模型时音频/语音**不必原生**——voice.transcribe 会用 ffmpeg 把任意格式
            # （webm/amr/mp4…）转 wav 再送。网页 Chrome 录的就是 webm，过去卡在这。视频无转写仍需原生交 mimo。
            # 视频格式是否被当前 Provider 接受由 MediaLimits.video_mimes 统一判断；
            # 不要先按音频原生格式集合过滤视频，否则不支持的视频会落到“转成 mp3”提示。
            fmt_ok = is_video or native or (voice_ok and not is_video)
            why = None
            if can_feed and fmt_ok:
                try:
                    import base64
                    mime = MEDIA_MIME.get(ext) or meta.get("mime") or (
                        f"video/{ext}" if is_video and ext else "application/octet-stream"
                    )
                    # 消费侧硬门：一律先用暂存元数据里的 meta["size"] 拒绝，再碰
                    # read_bytes——不要为了一个注定要拒绝的大文件先把整包读进内存
                    # （视频 500MB / 音频 36MB，均为读前拦截，code review 两轮指出）。
                    video_cfg = model_cfg
                    if is_video and video_cfg is None:
                        try:
                            from app.core.config import get_settings
                            video_cfg = get_settings().ai
                        except Exception:
                            video_cfg = None
                    if is_video:
                        video.validate_video_source(meta["size"], mime, video_cfg)
                        # 时长闸门前置到「读字节之前」：按暂存路径探测（ffprobe 按需
                        # seek，不落临时文件），超限直接拒——不用为了拒绝一个超长视频
                        # 先把整份读进内存。探测结果透传给 prepare_video_media。
                        video_probe = await video.probe_video_at(meta.get("storage_key"))
                        if video_probe is not None:
                            video.check_video_duration(video_probe.get("duration"), video_cfg)
                    if not is_video and meta["size"] > audio_raw_max:
                        raise ValueError("这条音频太大（超过上限），没法直接听")
                    if is_video:
                        # 视频决策（压缩阈值/base64 vs mm_file/大小上限）全部在 prepare_video_media
                        # 里——read_file 读文件库视频（media_reader.py 的 read_video）复用同一份逻辑，
                        # 这里不重复维护一套阈值判断。
                        from agent.media.budget import VIDEO_MEMORY_BUDGET
                        from agent.media.video_source import prepare_video_path
                        from app.services.storage import get_storage
                        limits = gates.media_limits_for(video_cfg)
                        local = (get_storage().local_path(meta["storage_key"])
                                 if meta.get("storage_key") and limits.prefer_file_upload
                                 and meta["size"] > limits.base64_max else None)
                        if local is not None:
                            item = await prepare_video_path(local, mime, meta.get("name") or "video.mp4",
                                video_cfg, storage_key=meta.get("storage_key"), user_id=user_id, probe=video_probe)
                        else:
                            async with VIDEO_MEMORY_BUDGET.reserve(meta["size"] * 4):
                                raw = await chat_attach.read_bytes(meta)
                                item = await video.prepare_video_media(
                                    raw, mime, meta.get("name") or "video.mp4", video_cfg,
                                    storage_key=meta.get("storage_key"), user_id=user_id,
                                    duration=(video_probe or {}).get("duration"), probe=video_probe)
                        media_items.append(item)
                    else:
                        raw = await chat_attach.read_bytes(meta)
                        # MiniMax ASR 使用 multipart 原始字节，可走官方 50 MiB 上限；
                        # 其他路径继续使用原有 base64 字节门槛。
                        audio_item = {
                            "type": "audio", "mode": "base64", "mime": mime,
                            "ext": ext, "attach_id": meta["attach_id"],
                            "kind": meta["kind"], "voice_recognition_enabled": voice_ok,
                        }
                        audio_inline_max = provider_media_limits.audio_max_bytes if audio_ok else MEDIA_RAW_MAX
                        if len(raw) <= audio_inline_max:
                            audio_item["b64"] = base64.b64encode(raw).decode()
                        else:
                            audio_item["raw"] = raw
                        media_items.append(audio_item)
                    if is_voice:
                        # 语音是「对话里说的话」，不是要存的文件——明确叫咕咕直接听内容回应，别问存不存。
                        parts.append(f"\n\n🎤 用户给你发来一条语音{tag}（已随附）。请**直接听里面说了什么并自然回应**——"
                                     f"这是对话内容，不是文件，别问「要不要保存」这类话。")
                    else:
                        parts.append(f"\n\n📎 用户上传了{noun}{tag}（已随附{noun}，你可直接听/看内容）；"
                                     f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
                    continue
                except ValueError as e:
                    # 视频超限 / mm_file 上传失败：明确拒绝，给出具体原因
                    why = str(e)
                except Exception:
                    pass   # 读取/编码失败 → 退文字提示
            if not can_feed:
                why = f"没法处理{noun}（需主模型开启对应多模态维度，或在后台配「语音识别模型」）"
            elif not fmt_ok:
                why = f"这条{noun}是 {ext or '未知'} 格式、得先转成 mp3 才能听——服务器没装 ffmpeg 转不了（装上 ffmpeg 即可听内容）"
            elif why is None:
                why = f"这条{noun}太大（超过上限），没法直接听/看"
            tail = "" if is_voice else "；若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。"
            parts.append(f"\n\n📎 用户发来{noun}{tag}。{why}。{tail}")
        else:
            parts.append(f"\n\n📎 用户上传了文件{tag}，二进制内容读不了；"
                         f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
    return "".join(parts), cards, images, media_items


def build_user_content(text: str, images: list, use_anthropic: bool, media: list | None = None,
                       image_detail: str = "auto"):
    """把增广文本 + 图片块（+ mimo 音视频块）拼成发给模型的 user content。
    无图无媒体 → 纯字符串（与旧行为一致）；否则 → 内容块列表（按 provider 格式）。
    `media`（音/视频）在 OpenAI 路使用 MiMo 扩展块，在 Anthropic 路使用 MiniMax 原生块。"""
    from agent.media.video import media_item_to_content_block

    media = media or []
    if image_detail not in {"auto", "low", "high", "original"}:
        image_detail = "auto"
    if not images and not media:
        return text
    if use_anthropic:
        parts = [{"type": "text", "text": text}] if text else []
        for im in images:
            parts.append({"type": "image", "source": {
                "type": "base64", "media_type": im["media_type"], "data": im["b64"]}})
        for m in media:
            block = media_item_to_content_block(m, use_anthropic=True)
            if block:
                parts.append(block)
            # 数据异常 / 当前协议不支持该媒体 → 跳过该块，不崩
        return parts
    parts = [{"type": "text", "text": text}] if text else []
    for im in images:
        parts.append({"type": "image_url", "image_url": {
            "url": f"data:{im['media_type']};base64,{im['b64']}",
            "detail": image_detail}})
    for m in media:
        block = media_item_to_content_block(m, use_anthropic=False)
        if block:
            parts.append(block)
    return parts
