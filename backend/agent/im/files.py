"""IM 附件回复。

附件发送涉及文件库读取、暂存附件归属、平台大小限制和各 Gateway 的媒体协议，
统一放在这里；文本回复通过 ``agent.im.replies.send_text`` 发出。
"""
from __future__ import annotations

from agent.im.models import PlatformReply
from agent.im.replies import send_text

_FEISHU_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_FEISHU_IMAGE_MAX = 10 * 1024 * 1024
_FEISHU_FILE_MAX = 30 * 1024 * 1024
_WECHAT_FILE_MAX = 30 * 1024 * 1024
_QQ_FILE_MAX = 10 * 1024 * 1024


# 入站附件暂存门面：Gateway 负责下载、解密和转码，这里统一处理 attach_id 生命周期。
async def stage(
    owner,
    name: str,
    ext: str,
    mime: str | None,
    data: bytes,
    *,
    platform: str,
    kind: str | None = None,
) -> dict:
    from app.core import chat_attach

    kwargs = {"platform": platform}
    if kind is not None:
        kwargs["kind"] = kind
    return await chat_attach.stage(owner, name, ext, mime, data, **kwargs)


async def stage_voice(
    owner,
    name: str,
    ext: str,
    mime: str | None,
    data: bytes,
    *,
    duration: float | None,
    platform: str,
) -> dict:
    from app.core import chat_attach

    return await chat_attach.stage_voice(
        owner, name, ext, mime, data, duration=duration, platform=platform
    )


def stage_sync(owner, name: str, ext: str, mime: str | None, data: bytes, *, platform: str) -> dict:
    from app.core import chat_attach

    return chat_attach.stage_sync(owner, name, ext, mime, data, platform=platform)


def stage_voice_sync(
    owner,
    name: str,
    ext: str,
    mime: str | None,
    data: bytes,
    *,
    duration: float | None,
    platform: str,
) -> dict:
    from app.core import chat_attach

    return chat_attach.stage_voice_sync(
        owner, name, ext, mime, data, duration=duration, platform=platform
    )


async def send_files(payload: dict, files: list) -> None:
    """把工具产出的文件按平台发回。"""
    if not files:
        return
    platform = payload.get("platform")
    if platform not in ("feishu", "qqbot", "wechat"):
        print(f"[im] {platform} 暂不支持发文件（{len(files)} 个）", flush=True)
        return
    file_reply = PlatformReply.from_parts(payload, [{"type": "file"}])
    if file_reply.unsupported_capabilities(platform):
        await send_text(payload, "这个平台暂时不能接收文件，我放到文件库里了，你从网页打开吧～")
        return
    if platform == "qqbot" and payload.get("chat_type") == "group":
        await send_text(payload, f"（群里暂不支持发图片/文件，私聊我看 {len(files)} 个文件吧～）")
        return

    import app.db.session as db_session
    from app.models import File
    from app.services.storage import get_storage

    if db_session._engine is None:
        db_session._build_engine()
    for file_item in files:
        file_id = file_item.get("file_id")
        attach_id = file_item.get("attach_id")
        try:
            if file_id:
                async with db_session._SessionLocal() as db:
                    record = await db.get(File, file_id)
                if not record:
                    continue
                display_name, ext, storage_key = (
                    record.display_name, record.ext, record.storage_key
                )
            elif attach_id:
                from app.core import chat_attach
                owner = payload.get("owner_user_id")
                meta = await chat_attach.get_meta(owner, attach_id) if owner else None
                if not meta:
                    continue
                display_name = file_item.get("name") or meta.get("name") or "图片"
                ext, storage_key = meta.get("ext", ""), meta["storage_key"]
            else:
                continue

            fname = f"{display_name}.{ext}"
            if platform == "feishu":
                data = await get_storage().get(storage_key)
                await _send_file_feishu(payload, ext, data, fname)
            elif platform == "qqbot":
                await _send_file_qq(payload, storage_key, ext, display_name, fname)
            else:
                await _send_file_wechat(payload, storage_key, ext, fname)
        except Exception as exc:
            print(
                f"[im] 发文件出错 {file_id or attach_id}: {type(exc).__name__}",
                flush=True,
            )


async def _send_file_wechat(payload: dict, storage_key: str, ext: str, fname: str) -> None:
    from agent.gateway import wechat
    from app.services.storage import get_storage

    openid = payload.get("platform_user_id")
    if not openid:
        return
    data = await get_storage().get(storage_key)
    if len(data) > _WECHAT_FILE_MAX:
        mb = len(data) / 1048576
        await send_text(payload, f"《{fname}》有 {mb:.0f}MB，超过微信 30MB 上限发不了 😅")
        return
    context_token = payload.get("context_token", "")
    is_image = (ext or "").lower() in _FEISHU_IMAGE_EXTS
    if is_image:
        ok = await wechat.send_image(openid, data, context_token, payload.get("channel_id"))
        label = "图片"
    else:
        ok = await wechat.send_file(openid, data, fname, context_token, payload.get("channel_id"))
        label = "文件"
    from agent import logsafe
    print(
        f"[im] wechat 发{label} fp={logsafe.fingerprint(fname)}: "
        f"{'ok' if ok else '失败'}（{len(data)} bytes）",
        flush=True,
    )
    if not ok:
        await send_text(payload, f"《{fname}》没发出去（微信那边拒了），你去网页/文件库里下载吧。")


async def _send_file_feishu(payload: dict, ext: str, data: bytes, fname: str) -> None:
    from agent.gateway import feishu
    from agent import logsafe

    is_image = (ext or "").lower() in _FEISHU_IMAGE_EXTS
    limit = _FEISHU_IMAGE_MAX if is_image else _FEISHU_FILE_MAX
    if len(data) > limit:
        mb, lim_mb = len(data) / 1048576, limit // 1048576
        print(
            f"[im] feishu 发文件 fp={logsafe.fingerprint(fname)}: "
            f"跳过（{mb:.1f}MB > {lim_mb}MB 上限）",
            flush=True,
        )
        await send_text(payload, f"《{fname}》有 {mb:.0f}MB，超过飞书 {lim_mb}MB 上限发不了 😅 你去网页/文件库里下载吧。")
        return
    display_name = fname.rsplit(".", 1)[0] if "." in fname else fname
    ok = await feishu.send_file(
        payload.get("chat_id"), data, display_name, ext, payload.get("channel_id")
    )
    print(f"[im] feishu 发文件 fp={logsafe.fingerprint(fname)}: {'ok' if ok else '失败'}", flush=True)
    if not ok:
        await send_text(payload, f"《{fname}》没发出去（飞书那边拒了），你去网页/文件库里下载吧。")


async def _send_file_qq(
    payload: dict, storage_key: str, ext: str, display_name: str, fname: str
) -> None:
    from agent.gateway import qq
    from agent import logsafe
    from app.services.storage import get_storage

    openid = payload.get("platform_user_id")
    storage = get_storage()
    url = storage.fetch_url(storage_key)
    if url:
        ok = await qq.send_file(
            openid, None, display_name, ext, payload.get("channel_id"),
            payload.get("message_id"), url=url,
        )
    else:
        data = await storage.get(storage_key)
        if len(data) > _QQ_FILE_MAX:
            await send_text(payload, f"《{fname}》有 {len(data) / 1048576:.0f}MB，超过 QQ 上限（本地存储约 10MB）发不了，去网页/文件库下载吧。")
            return
        ok = await qq.send_file(
            openid, data, display_name, ext, payload.get("channel_id"),
            payload.get("message_id"),
        )
    print(
        f"[im] qq 发文件 fp={logsafe.fingerprint(fname)}: "
        f"{'ok' if ok else '失败'}{'（URL模式）' if url else ''}",
        flush=True,
    )
    if not ok:
        await send_text(payload, f"《{fname}》没发出去（QQ 那边拒了），你去网页/文件库里下载吧。")
