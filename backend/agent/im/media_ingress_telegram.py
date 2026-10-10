"""Telegram Bot API 媒体下载、校验、引用复用与附件暂存。"""
from __future__ import annotations

import mimetypes
import re

from agent.im.media_ingress import MediaIngressResult
from app.core.redaction import diag_log

MAX_TELEGRAM_DOWNLOAD_BYTES = 20_000_000
_MIME_RE = re.compile(r"^[A-Za-z0-9.+-]{1,127}/[A-Za-z0-9.+-]{1,127}$")
_SIZE_LIMIT_NOTICE = "Telegram 单个附件下载上限为 20 MB，超限附件未接收。"
_DOWNLOAD_FAILURE_NOTICE = "有附件暂时无法从 Telegram 下载，请稍后重试或重新发送。"


def _safe_filename(value: object, media_type: str) -> tuple[str, str]:
    filename = str(value or "附件").replace("\\", "/").rsplit("/", 1)[-1]
    filename = "".join(char for char in filename if char.isprintable() and char not in "/\\")[:180]
    if not filename or filename in {".", ".."}:
        filename = "附件"
    if "." in filename and not filename.startswith("."):
        name, ext = filename.rsplit(".", 1)
    else:
        name, ext = filename, ""
    ext = ext.lower()[:10]
    if not ext:
        fallback = {
            "photo": "jpg", "voice": "ogg", "video": "mp4",
            "video_note": "mp4", "animation": "mp4",
        }
        ext = fallback.get(media_type, "bin")
    return name[:160] or "附件", ext


def _mime_type(item: dict, ext: str, media_type: str) -> str:
    candidate = str(item.get("mime_type") or "")
    expected_prefix = {
        "photo": "image/", "voice": "audio/", "audio": "audio/",
        "video": "video/", "video_note": "video/", "animation": "video/",
    }.get(media_type)
    if _MIME_RE.fullmatch(candidate) and (
        expected_prefix is None or candidate.lower().startswith(expected_prefix)
    ):
        return candidate.lower()
    if expected_prefix:
        fallback = {
            "photo": "image/jpeg", "voice": "audio/ogg", "audio": "audio/mpeg",
            "video": "video/mp4", "video_note": "video/mp4", "animation": "video/mp4",
        }
        return fallback[media_type]
    return mimetypes.guess_type(f"attachment.{ext}")[0] or "application/octet-stream"


async def _get_owned_bot_token(owner_id, bot_id: str) -> str | None:
    from sqlalchemy import select

    import app.db.session as db_session
    from app.models import UserBot

    try:
        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            bot = (await db.execute(select(UserBot).where(
                UserBot.id == int(bot_id),
                UserBot.user_id == owner_id,
                UserBot.platform == "telegram",
                UserBot.enabled.is_(True),
            ))).scalars().first()
            return bot.app_secret if bot else None
    except (TypeError, ValueError):
        return None
    except Exception as exc:
        diag_log("agent.im.media_ingress_telegram.bot_token", exc)
        return None


async def _reuse_quoted_attachments(owner_id, items: list[dict]) -> list[str]:
    from app.core import chat_attach

    reused = []
    for item in items:
        source_message_id = item.get("source_platform_message_id")
        if not source_message_id:
            continue
        source_index = item.get("source_attachment_index", 0)
        if not isinstance(source_index, int) or isinstance(source_index, bool):
            source_index = 0
        result = await chat_attach.reuse_attachment(
            owner_id,
            platform="telegram",
            platform_message_id=str(source_message_id),
            attachment_index=source_index,
            extra={"quoted": True},
        )
        if result:
            reused.append(result["attach_id"])
    return reused


async def ingest_telegram_media(
    attachments: list,
    quoted_attachments: list,
    owner_id,
    bot_id: str,
    platform_message_id: str | None,
) -> MediaIngressResult:
    """只下载当前消息附件；引用附件仅复用当前用户已保存的同平台消息附件。"""
    raw_items = [item for item in attachments if isinstance(item, dict)]
    quote_items = [item for item in quoted_attachments if isinstance(item, dict)]
    if not owner_id:
        return MediaIngressResult([], failure_notice=_DOWNLOAD_FAILURE_NOTICE if raw_items else None)

    attachment_ids = await _reuse_quoted_attachments(owner_id, quote_items)
    if not raw_items:
        return MediaIngressResult(attachment_ids)

    token = await _get_owned_bot_token(owner_id, bot_id)
    if not token:
        return MediaIngressResult(attachment_ids, failure_notice=_DOWNLOAD_FAILURE_NOTICE)

    from agent.im import files as im_attachments
    from app.services.telegram_bot_api import TelegramBotApiError, call, download_file

    size_limit_exceeded = False
    failed_count = 0
    total_bytes = 0
    for item_index, item in enumerate(raw_items):
        file_id = item.get("file_id")
        if not isinstance(file_id, str) or not file_id or len(file_id) > 512:
            failed_count += 1
            continue
        declared_size = item.get("file_size")
        if isinstance(declared_size, int) and not isinstance(declared_size, bool) and declared_size > MAX_TELEGRAM_DOWNLOAD_BYTES:
            size_limit_exceeded = True
            continue

        try:
            file_info = await call(token, "getFile", payload={"file_id": file_id})
            if not isinstance(file_info, dict):
                failed_count += 1
                continue
            remote_size = file_info.get("file_size")
            if isinstance(remote_size, int) and not isinstance(remote_size, bool) and remote_size > MAX_TELEGRAM_DOWNLOAD_BYTES:
                size_limit_exceeded = True
                continue
            data = await download_file(
                token,
                str(file_info.get("file_path") or ""),
                max_bytes=MAX_TELEGRAM_DOWNLOAD_BYTES,
            )
            if not data:
                failed_count += 1
                continue
            if isinstance(remote_size, int) and not isinstance(remote_size, bool) and len(data) != remote_size:
                failed_count += 1
                continue
            total_bytes += len(data)
            if total_bytes > MAX_TELEGRAM_DOWNLOAD_BYTES:
                size_limit_exceeded = True
                continue

            name, ext = _safe_filename(item.get("file_name"), str(item.get("media_type") or ""))
            media_type = str(item.get("media_type") or "")
            mime = _mime_type(item, ext, media_type)
            stage_kwargs = {
                "platform": "telegram",
                "platform_message_id": platform_message_id,
                "attachment_index": int(item.get("source_attachment_index", item_index)),
            }
            if media_type == "photo":
                stage_kwargs["kind"] = "image"

            if media_type == "voice":
                from app.core import media_transcode
                from app.core.config import get_settings
                from agent import providers
                from agent.llm.modelctx import effective_ai

                converted = media_transcode.to_provider_audio(
                    data, ext, mime, providers.adapter_for(effective_ai(get_settings()))
                )
                if converted is not None:
                    data, ext, mime, name = converted[0], "mp3", "audio/mpeg", "语音"
                duration_value = item.get("duration")
                duration = float(duration_value) if isinstance(duration_value, (int, float)) else None
                meta = await im_attachments.stage_voice(
                    owner_id, name, ext, mime, data, duration=duration,
                    platform="telegram", platform_message_id=platform_message_id,
                    attachment_index=int(item.get("source_attachment_index", item_index)),
                )
            else:
                meta = await im_attachments.stage(
                    owner_id, name, ext, mime, data, **stage_kwargs,
                )
            attachment_ids.append(meta["attach_id"])
        except TelegramBotApiError as exc:
            diag_log("agent.im.media_ingress_telegram.download", exc)
            if exc.operation == "getFile" and exc.status_code == 413:
                size_limit_exceeded = True
            else:
                failed_count += 1
        except Exception as exc:
            diag_log("agent.im.media_ingress_telegram.stage", exc)
            failed_count += 1

    notice_parts = []
    if size_limit_exceeded:
        notice_parts.append(_SIZE_LIMIT_NOTICE)
    if failed_count:
        notice_parts.append(_DOWNLOAD_FAILURE_NOTICE)
    return MediaIngressResult(
        attachment_ids,
        size_limit_exceeded=size_limit_exceeded,
        failure_notice="\n".join(notice_parts) or None,
    )
