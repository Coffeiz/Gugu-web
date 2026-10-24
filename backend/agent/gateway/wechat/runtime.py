"""微信 iLink Bot 网关（个人微信，BYO 每用户自带 bot）。

和飞书/QQ 同模式（BYO + gateway 子进程 + `im:inbound` 队列 + worker run_collect），
但 iLink 是 **HTTP long-poll**（非 WebSocket SDK）：本网关 `getupdates` 长轮询拉消息入队。
凭据是扫码拿的单个 `bot_token`（复用 `user_bots.app_secret` 存），`base_url` 复用 `app_id` 存。

凭据来源分两端（同 qq）：
  - 接收（本网关子进程）：gateway 经环境变量注入 `WECHAT_*`（不走 argv，避免 ps 泄漏）
  - 发送（worker 进程）：按 bot id 现查 `user_bots`

⚠️ iLink **回复必须带入站消息给的 `context_token`**（端到端会话凭证）——入队 payload 带上
`context_token`，worker 回复时透传回 `send_text`。这是和飞书/QQ 唯一的接口差异。

启动（由 gateway 拉起，注入 WECHAT_* 环境变量）：
    WECHAT_BOT_ID=.. WECHAT_BOT_TOKEN=.. WECHAT_BASE_URL=.. WECHAT_OWNER=.. \
      .venv/bin/python -m agent.gateway.wechat
"""
from __future__ import annotations

import asyncio
import os
import signal

from app.core import redis as R
from app.core.redaction import diag_log, redact
from agent.im.media_ingress_wechat import (
    extract_quoted as _extract_quoted,
    ingest_media as _ingest_wechat_media_impl,
    media_url as _wechat_media_url,
)
from .client import DEFAULT_BASE_URL, ILinkClient
from .config_cache import WeixinConfigManager

STREAM = R.IM_INBOUND_STREAM

# 网关进程内 per-user typing_ticket 缓存（2026-07-09 接入 iLink typing 接口）
# 单 bot 单网关进程 → 模块级单例天然 per-bot 隔离；多 user 共享同一 manager
_config_managers: dict[str, WeixinConfigManager] = {}


def _get_config_manager(channel_id: str) -> WeixinConfigManager:
    """按 channel_id 取（首次懒创建）/ 取缓存的 WeixinConfigManager。

    网关子进程的 bot_token 由 gateway 注入到 `WECHAT_BOT_TOKEN` 环境变量，
    所以这里直接读环境变量构造 manager（不用像 worker 那样走 user_bots 现查）。
    """
    if channel_id not in _config_managers:
        import os
        bot_token = os.environ.get("WECHAT_BOT_TOKEN", "")
        base_url = os.environ.get("WECHAT_BASE_URL", "") or DEFAULT_BASE_URL
        _config_managers[channel_id] = WeixinConfigManager(
            {"bot_token": bot_token, "base_url": base_url},
            log=lambda msg: print(msg, flush=True),
        )
    return _config_managers[channel_id]


def _aes128_ecb_decrypt(raw: bytes, key: bytes) -> bytes:
    """iLink 媒体解密：AES-128-ECB（key=16B）+ PKCS7 去填充。"""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    out = dec.update(raw) + dec.finalize()
    if out:
        pad = out[-1]
        if 1 <= pad <= 16 and out[-pad:] == bytes([pad]) * pad:
            out = out[:-pad]
    return out


async def _ingest_wechat_media(items: list, owner: str) -> list:
    return await _ingest_wechat_media_impl(items, owner, _aes128_ecb_decrypt)


# ── 接收（网关子进程，long-poll）────────────────────────────────────────────────
async def _handle_msg(msg: dict, channel_id: str, owner: str, client) -> None:
    if msg.get("message_type") != 1:   # 只处理 用户→bot（2=bot 自己发的，跳过，否则自问自答）
        return
    from_user = msg.get("from_user_id", "")
    context_token = msg.get("context_token", "")
    group_id = msg.get("group_id", "")
    items = msg.get("item_list") or []
    text = "".join(
        (it.get("text_item") or {}).get("text", "")
        for it in items
    ).strip()
    # 语音消息（type==3）：iLink 自带 ASR 转写在 item.voice_item.text，直接当对话文本注入，
    # 不用像图片那样走 CDN + AES-128-ECB 下载解密（微信官方已经转好文字了）。转写偶尔为空
    # （ASR 失败/听不清）给个兜底提示，不静默丢消息。
    voice_parts = []
    for it in items:
        if it.get("type") != 3:
            continue
        vt = (it.get("voice_item") or {}).get("text", "").strip()
        voice_parts.append(
            f"🎤 用户发来一条语音（已转文字）：「{vt}」。请直接听懂这段话并自然回应——"
            f"这是对话内容，不是文件，别问「要不要保存」这类话。"
            if vt else "🎤 用户发来一条语音，但转写失败/没听清，麻烦让用户用文字重新说一下。"
        )
    if voice_parts:
        text = (text + "\n\n" if text else "") + "\n\n".join(voice_parts)
    # 非文本项（图片/文件）：iLink 媒体 AES-128-ECB + CDN，下载解密暂存（图片已支持，见 _ingest）。
    # 语音（type==3）已在上面转成文本处理，这里排除掉，不再走媒体暂存流程。
    non_text = [it for it in items if it.get("type") not in (1, 3)]
    if not from_user:
        return
    if not text and not non_text:   # 真空消息
        return

    # 引用消息：把被引用原文单独塞 quoted_text，引用图片等媒体继续按普通附件入队。
    quoted_text = None
    quoted_items = []
    has_quote = False
    for it in items:
        quoted, quoted_media = _extract_quoted(it.get("ref_msg"))
        if quoted or quoted_media:
            quoted_text = quoted
            quoted_items = quoted_media
            has_quote = True
            break

    # 下载+解密+暂存媒体：当前消息附件 + 引用里的图片附件一并入队。
    media_items = non_text + quoted_items
    # 凭据输入必须早于媒体下载/暂存拦截；微信 worker 的统一 dispatch 已有
    # 同一检查，这里再前移到 gateway，避免敏感态消息产生媒体副作用。
    from agent.im.interaction_text import consume_mcp_secret_payload

    if await consume_mcp_secret_payload({
        "platform": "wechat", "channel_id": channel_id, "owner_user_id": owner,
        "platform_user_id": from_user, "message_id": context_token,
        "chat_type": "group" if group_id else "c2c", "chat_id": group_id or None,
        "context_token": context_token, "text": text,
        "attachments": [{"pending_media": True}] if media_items else [],
    }):
        return
    attachments = await _ingest_wechat_media(media_items, owner) if media_items else []
    from agent.runtime import trace
    tid = trace.new_trace()
    # 隐私：不打印消息原文，只留结构+指纹（见 agent/logsafe.py），同 agent.traj 脱敏口径
    from agent.security import logsafe
    print(f"[wechat:{channel_id}] 收到 {from_user}: text_len={len(text)} fp={logsafe.fingerprint(text)} "
          f"att={len(attachments)} quoted={has_quote} trace={tid}", flush=True)
    if not text and not attachments:   # 只有不支持的媒体、啥也没取到 → 不入队（agent 无内容）
        return
    if text.strip() and not attachments:
        from agent.im.shortcuts import apply_im_shortcut_cancel, decide_im_shortcut

        scope_id = group_id or from_user
        dec = await decide_im_shortcut(
            "wechat",
            from_user,
            text,
            bot_id=channel_id,
            scope_id=scope_id,
        )
        if dec.get("action") in {"cancel", "no_permission"}:
            if dec["action"] == "cancel":
                await apply_im_shortcut_cancel(
                    "wechat",
                    from_user,
                    dec,
                    bot_id=channel_id,
                    scope_id=scope_id,
                )
            from agent.gateway import wechat

            await wechat.send_text(
                from_user,
                str(dec.get("reply") or ""),
                channel_id=channel_id,
                context_token=context_token,
            )
            return
    # typing_ticket（per-user, 24h 有效）——同步等 + 超时兜底，避免 race condition
    # （OpenClaw 做法也是同步 await，但 Gugu-web 这里加 500ms 上限防网络抖动拖慢 gateway 拉消息节奏）
    # 拿不到时 worker 端按空 ticket 走"不发 typing"分支（与 OpenClaw 退化策略一致）
    typing_ticket = ""
    try:
        cfg = await asyncio.wait_for(
            _get_config_manager(channel_id).get_for_user(from_user, context_token),
            timeout=0.5,
        )
        typing_ticket = cfg.get("typing_ticket", "") or ""
    except Exception as e:
        # `asyncio.TimeoutError` 就是内建 `TimeoutError`，已被 `Exception` 覆盖，原元组冗余
        # （P2-b §6 反模式）。best-effort：拿不到 ticket 退化成不发 typing，不挡入队主流程。
        diag_log("agent.gateway.wechat.typing_ticket", e)
        print(f"[wechat] typing_ticket 获取超时/失败（不影响主流程）: "
              f"{redact(f'{type(e).__name__}: {e}')}", flush=True)

    payload = {
        "platform": "wechat",
        "channel_id": channel_id,
        "owner_user_id": owner,             # BYO：bot 归属即用户，worker 直接用
        "platform_user_id": from_user,      # 微信用户 id（xxx@im.wechat）
        "message_id": context_token,        # iLink 无独立 msg_id，用 context_token 作标识/去重
        "chat_type": "group" if group_id else "c2c",
        "wechat_group_id": group_id,
        "context_token": context_token,     # ⚠️ iLink 回复必需，worker 透传回 send_text
        "text": text,
        "quoted_text": quoted_text,
        "attachments": attachments,
        "trace_id": tid,                    # 全链路 trace：worker/工具日志同 id，grep 可串联
        "typing_ticket": typing_ticket,     # 空 = 不发 typing（worker 端按空 ticket 退化）
    }
    # 取消/无权取消在 Gateway 即时处理，其他 intent 仍交给 worker 的 IM Loop。
    try:
        from agent.im.models import normalize_payload
        payload = normalize_payload(payload)
        await R.produce(STREAM, payload)
    except Exception as e:
        # 不重试：Redis stream XADD 没有幂等键，重推同一 payload 会造成 worker 端重复处理这条
        # 消息（非幂等写，P2-b §4-A 幂等前提）。丢这一条比重复处理更安全，原始异常留受限出口
        # 供排查，可见日志只留脱敏摘要。
        diag_log("agent.gateway.wechat.enqueue", e)
        print(f"[wechat] 入队失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)


async def _serve_async(channel_id: str, owner: str, bot_token: str, base_url: str) -> None:
    client = ILinkClient(bot_token, base_url)
    await client.start()
    print(f"[wechat:{channel_id}] 网关就绪（owner={owner}），long-poll 中…", flush=True)
    cursor = ""
    try:
        while True:
            try:
                resp = await client.getupdates(cursor)
                cursor = resp.get("get_updates_buf", cursor) or cursor
                for msg in (resp.get("msgs") or []):
                    await _handle_msg(msg, channel_id, owner, client)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # getupdates 是幂等读（long-poll 拉取，游标没推进就不会丢/重消息），无界重试是
                # 安全的——不区分 4xx/5xx：哪怕是永久性错误（如 token 失效），网关也应该继续
                # 挂着重试而不是退出进程（同 openclaw 网关退化策略），只是每次都留诊断记录。
                diag_log("agent.gateway.wechat.long_poll", e)
                print(f"[wechat:{channel_id}] long-poll 异常: "
                      f"{redact(f'{type(e).__name__}: {e}')}，3s 后重试", flush=True)
                await asyncio.sleep(3)
    finally:
        await client.stop()


def serve() -> None:
    channel_id = os.environ.get("WECHAT_BOT_ID", "")
    owner = os.environ.get("WECHAT_OWNER", "")
    bot_token = os.environ.get("WECHAT_BOT_TOKEN", "")
    base_url = os.environ.get("WECHAT_BASE_URL", "") or DEFAULT_BASE_URL
    if not bot_token:
        raise SystemExit("缺少 WECHAT_BOT_TOKEN 环境变量（应由 gateway 注入）。")
    print(f"[wechat:{channel_id}] 网关启动…", flush=True)
    # 注册 SIGTERM handler——gateway 发 SIGTERM 时优雅退出（先 notifystop、再退出），
    # 避免上游服务器侧 long-poll 悬挂等 35s 超时才发现连接断了。
    # asyncio.run 跑在子线程没法直接装 signal handler，所以通过 main_thread_loop 桥接：
    # SIGTERM 到达时把 notifystop 调度进 running loop 跑（独立 timeout，不受主退出流程影响）。
    loop_holder: dict = {}

    def _on_sigterm(signum, frame):
        loop = loop_holder.get("loop")
        if loop is None or loop.is_closed():
            return
        # notifystop 用独立 timeout（参考 OpenClaw api/api.ts notifyStop 注释——「使用独立超时，
        # 这样 OpenClaw 已经 abort long-poll 后请求也能完成」），这里 create_task 让它在 loop 里跑
        async def _notify():
            try:
                cli = ILinkClient(bot_token=bot_token, base_url=base_url)
                await cli.start()
                try:
                    await asyncio.wait_for(cli.notify_stop(), timeout=5.0)
                finally:
                    await cli.stop()
                print(f"[wechat:{channel_id}] notifystop 已发", flush=True)
            except Exception as e:
                # best-effort：进程反正要退出了，通知上游失败也不影响本进程收尾。
                diag_log("agent.gateway.wechat.notify_stop", e)
                print(f"[wechat:{channel_id}] notifystop 失败（忽略）: "
                      f"{redact(f'{type(e).__name__}: {e}')}", flush=True)

        try:
            asyncio.run_coroutine_threadsafe(_notify(), loop)
        except Exception:
            pass

    signal.signal(signal.SIGTERM, _on_sigterm)
    signal.signal(signal.SIGINT, _on_sigterm)

    asyncio.run(_serve_async_with_start_notify(channel_id, owner, bot_token, base_url, loop_holder))


async def _serve_async_with_start_notify(channel_id: str, owner: str, bot_token: str,
                                          base_url: str, loop_holder: dict) -> None:
    """在主 loop 里跑：先 notifystart → 然后把 loop 引用交给 SIGTERM handler → 跑原 long-poll 主循环。"""
    loop_holder["loop"] = asyncio.get_running_loop()
    try:
        cli = ILinkClient(bot_token=bot_token, base_url=base_url)
        await cli.start()
        try:
            await cli.notify_start()
            print(f"[wechat:{channel_id}] notifystart 已发", flush=True)
        except Exception as e:
            # best-effort：notifystart 只是告知上游，失败不该挡后面 long-poll 主循环启动。
            diag_log("agent.gateway.wechat.notify_start", e)
            print(f"[wechat:{channel_id}] notifystart 失败（不影响主流程）: "
                  f"{redact(f'{type(e).__name__}: {e}')}", flush=True)
        finally:
            await cli.stop()
    except Exception as e:
        # best-effort：整个启动通知阶段失败也不该阻止网关进主循环收消息。
        diag_log("agent.gateway.wechat.start_notify_phase", e)
        print(f"[wechat:{channel_id}] 启动通知阶段异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)

    await _serve_async(channel_id, owner, bot_token, base_url)
