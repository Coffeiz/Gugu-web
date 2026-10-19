"""飞书消息与卡片事件适配。"""
from __future__ import annotations

import json
import time
from typing import Callable, NamedTuple

import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

from app.core import redis as R
from app.core.redaction import diag_log, redact
from agent.im.media_ingress_feishu import (
    download_and_stage as _download_and_stage,
    ingest_media as _ingest_media_impl,
    ingest_post as _ingest_post_impl,
)
STREAM = R.IM_INBOUND_STREAM

_FEISHU_STALE_MSG_THRESHOLD_MS = 20_000


class _EventServices(NamedTuple):
    """由运行时注入的同步回调能力，避免事件适配层反向依赖出站模块。"""

    runner: object
    do_send: Callable
    do_react: Callable


def _ingest_media(client, msg, owner: str) -> tuple[str, list]:
    return _ingest_media_impl(client, msg, owner, _download_and_stage)


def _ingest_post(client, msg, owner: str) -> tuple[str, list]:
    return _ingest_post_impl(client, msg, owner, _download_and_stage)


def _extract_card_text(content) -> str:
    """从卡片 JSON 里递归拍平抽取可读文字（markdown/text 节点），跳过 table 等非叙述性组件。

    直接从整个 content 开始递归，不假设 elements 在哪一层——旧版非流式卡片是扁平的
    `{"elements": [...]}`，咕咕现在的流式卡片是 CardKit schema 2.0 的
    `{"schema": "2.0", "body": {"elements": [...]}}`，elements 嵌在 body 里一层。
    之前只从 `content["elements"]` 起步，流式卡片这层结构对不上，导致引用咕咕自己的
    流式回复时永远抽出空文本（[空消息]）。递归整个 content 两种结构都能兼容。
    """
    parts: list[str] = []

    def _collect(v):
        if isinstance(v, dict):
            if v.get("tag") in ("markdown", "text"):
                parts.append(v.get("content") or v.get("text") or "")
            else:
                for v2 in v.values():
                    _collect(v2)
        elif isinstance(v, list):
            for v2 in v:
                _collect(v2)

    _collect(content)
    return "\n".join(p for p in parts if p).strip()


def _ingest_interactive(msg) -> str:
    """用户转发一张卡片消息过来：只提取可读文字，不下载卡片内嵌图片（组件结构太杂，暂不处理媒体）。"""
    try:
        c = json.loads(msg.content) if msg.content else {}
    except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
        return "[卡片消息，解析失败]"
    return _extract_card_text(c) or "[卡片消息]"


def _fetch_quoted_text(client, parent_id: str) -> str | None:
    """按 parent_id 反查被引用的原消息文字（同步，供 _on_message 直接调用）。
    非文字类型给占位说明；查询失败返回 None，调用方静默跳过、不阻塞主消息。"""
    from lark_oapi.api.im.v1 import GetMessageRequest
    try:
        # card_msg_content_type=user_card_content：不传这个参数时，飞书对 CardKit 动态卡片
        # （引用 card_id 而非内联 elements，咕咕的流式回复卡片就是这种）返回的是一段兼容性占位
        # 文案「请升级至最新版本客户端，以查看内容」，不是卡片真实内容——QwenPaw 同款反查逻辑
        # 也带了这个参数，实测确认是这个字段控制的。
        req = (GetMessageRequest.builder().message_id(parent_id)
              .card_msg_content_type("user_card_content").build())
        resp = client.im.v1.message.get(req)
        if not resp.success() or not resp.data or not resp.data.items:
            return None
        m = resp.data.items[0]
        if m.msg_type == "text":
            try:
                c = json.loads(m.body.content) if (m.body and m.body.content) else {}
            except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
                return "[解析失败]"
            return (c.get("text") or "").strip() or "[空消息]"
        if m.msg_type == "interactive":
            # 咕咕自己发的回复走卡片（见 _do_send 的 _build_card_elements），引用到的大概率是这种——
            # 从卡片 markdown 元素里把文字拼回来（table 组件跳过，不还原成文字，只取叙述性内容）。
            # GetMessage 回来的 elements 是「数组的数组」（分组/分段），不是发送时那种扁平列表，
            # 所以要递归拍平找 markdown 节点，不能只查一层；字段名也被归一化成 {"tag":"text","text":...}。
            try:
                c = json.loads(m.body.content) if (m.body and m.body.content) else {}
            except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
                return "[解析失败]"
            return _extract_card_text(c) or "[空消息]"
        if m.msg_type == "post":
            return "[图文消息]"
        return {"image": "[图片消息]", "file": "[文件消息]", "audio": "[语音消息]", "media": "[视频消息]"}.get(m.msg_type, "[非文字消息]")
    except Exception as e:
        diag_log("agent.gateway.feishu.fetch_quoted_text", e)   # 原始 → 受限诊断出口
        print(f"[feishu] 查引用原消息失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return None


def _header_value(data, name: str):
    """兼容 lark SDK 对象和测试 dict，读取事件 header 字段。"""
    header = getattr(data, "header", None)
    if isinstance(header, dict):
        return header.get(name)
    return getattr(header, name, None)


def _drop_misrouted_event(data, expected_app_id: str, channel_id: str) -> bool:
    """丢弃被 lark SDK 错投到当前子进程的其他 app 事件。"""
    event_app_id = _header_value(data, "app_id")
    if event_app_id and expected_app_id and event_app_id != expected_app_id:
        print(f"[feishu:{channel_id}] 丢弃错投事件 app_id={str(event_app_id)[-6:]}", flush=True)
        return True
    return False


def _drop_stale_event(data, channel_id: str, now_ms: int | None = None) -> bool:
    """丢弃飞书 retry 推来的旧消息，避免同一用户收到迟到重复回复。"""
    create_time = _header_value(data, "create_time")
    if not create_time:
        return False
    try:
        create_ms = int(create_time)
    except (TypeError, ValueError):
        return False
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    age_ms = now - create_ms
    if age_ms > _FEISHU_STALE_MSG_THRESHOLD_MS:
        print(f"[feishu:{channel_id}] 丢弃飞书旧 retry age={age_ms / 1000:.1f}s", flush=True)
        return True
    return False


async def _consume_card_action(owner: str, prompt_id: int, token: str,
                               event_id: str | None, *, bot_id: str = "",
                               platform_user_id: str = "") -> dict:
    """在飞书回调协程中消费统一 Prompt Action。"""
    from uuid import UUID
    from app.db import session as db_session
    from app.services.interactions import consume_action
    from app.services.mcp_secret_inputs import consume_mcp_secret_action

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        raise RuntimeError("数据库不可用")
    async with db_session._SessionLocal() as db:
        user_id = UUID(str(owner))
        result = await consume_mcp_secret_action(
            db, user_id=user_id, prompt_id=prompt_id, token=token,
            event_id=str(event_id or ""), platform="feishu", bot_id=bot_id,
            platform_user_id=platform_user_id, chat_type="c2c", chat_id=None,
        )
        if result is not None:
            return result
        return await consume_action(
            db,
            user_id=user_id,
            prompt_id=prompt_id,
            token=token,
            event_id=event_id,
        )


def _handle_card_action(data, owner: str, services: _EventServices, bot_id: str = ""):
    """处理飞书 card.action.trigger；等待有界时间，只有消费成功才确认完成态。"""
    from concurrent.futures import TimeoutError as FutureTimeoutError
    from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTriggerResponse
    from agent.interactions.feishu import (
        action_presentation,
        build_completed_card_payload,
        decode_action_value,
    )

    event = getattr(data, "event", None)
    operator = getattr(event, "operator", None)
    operator_id = str(getattr(operator, "open_id", "") or "")
    action = getattr(event, "action", None)
    value = getattr(action, "value", None) if action is not None else None
    completed_card = None
    try:
        prompt_id, token = decode_action_value(value)
        option_id, option_label = action_presentation(value)
        header = getattr(data, "header", None)
        event_id = getattr(header, "event_id", None)
        coroutine = _consume_card_action(
            owner, prompt_id, token, event_id, bot_id=bot_id,
            platform_user_id=operator_id,
        )
        future = services.runner.submit(coroutine)
        try:
            consumed = future.result(timeout=2)
        except FutureTimeoutError:
            def _report_late_failure(done_task) -> None:
                try:
                    done_task.result()
                except Exception as exc:
                    diag_log("agent.gateway.feishu.interaction", exc)

            future.add_done_callback(_report_late_failure)
            # 不替换原卡片，保留用户重试入口；不能把尚未确认的动作显示为完成。
            message = "已收到操作，仍在处理中；请稍后查看，暂勿重复点击。"
            return P2CardActionTriggerResponse({"toast": {"type": "info", "content": message}})
        except Exception as exc:
            diag_log("agent.gateway.feishu.interaction", exc)
            message = "操作未能完成，请稍后重试。"
            return P2CardActionTriggerResponse({"toast": {"type": "error", "content": message}})

        result = consumed.get("result") if isinstance(consumed, dict) else None
        status = result.get("status") if isinstance(result, dict) else None
        if status is None and isinstance(consumed, dict):
            status = consumed.get("status")
        if status == "error":
            message = "操作未能完成。"
            completed_card = build_completed_card_payload("操作未能完成，请重新发起该操作。")
        else:
            message = "已收到选择。"
        if option_id == "input_credentials":
            completed_message = "已确认凭据输入；请在当前私聊逐项发送字段值，回复“取消”可终止。"
        elif option_id == "cancel":
            completed_message = "已确认取消。"
        elif option_label:
            completed_message = f"✅ 已确认选择「{option_label}」"
        else:
            # 兼容部署前已发出的旧交互卡片，它们没有携带展示用选项文本。
            completed_message = "✅ 已确认收到选择，咕咕正在继续处理。"
        if completed_card is None:
            completed_card = build_completed_card_payload(completed_message)
    except (LookupError, ValueError):
        message = "这个选项已过期或已经处理过了。"
    except Exception as exc:
        diag_log("agent.gateway.feishu.interaction", exc)
        message = "暂时无法处理这个选项，请回复选项文字。"
    response = {"toast": {"type": "info", "content": message}}
    if completed_card is not None:
        # 飞书回调允许返回新的 raw card。用无按钮状态卡替换原卡，避免重复点击；
        # 真正的幂等性仍由服务端一次性 action token 保证。
        response["card"] = {"type": "raw", "data": completed_card}
    return P2CardActionTriggerResponse(response)


def _feishu_mentions_current_bot(message, open_id: str | None) -> bool:
    """从飞书 at 节点确认是否指向当前 bot；没有结构化节点时不猜测。"""
    if not open_id:
        return False
    mentions = getattr(message, "mentions", None) or []
    if not isinstance(mentions, list):
        return False
    for item in mentions:
        value = item.get("id") if isinstance(item, dict) else getattr(item, "id", None)
        candidate = value.get("open_id") if isinstance(value, dict) else getattr(value, "open_id", None)
        if candidate == open_id or value == open_id:
            return True
    return False


def _feishu_mention_field(item, field: str):
    return item.get(field) if isinstance(item, dict) else getattr(item, field, None)


def _feishu_resolve_mention_text(message, text: str) -> str:
    """将飞书正文里的 @占位符按事件 mentions 映射为显示名。"""
    for item in getattr(message, "mentions", None) or []:
        key = _feishu_mention_field(item, "key")
        name = _feishu_mention_field(item, "name")
        if not isinstance(key, str) or not key or not isinstance(name, str) or not name:
            continue
        text = text.replace(key, f"@{name.lstrip('@＠')}")
    return text


def _feishu_bot_open_id(api_client) -> str | None:
    """启动时读取当前应用机器人的 open_id，供群消息精确判断 @ 目标。"""
    try:
        request = (
            lark.BaseRequest.builder()
            .http_method(lark.HttpMethod.GET)
            .uri("/open-apis/bot/v3/info")
            .token_types({lark.AccessTokenType.TENANT})
            .build()
        )
        response = api_client.request(request)
        if not response.success() or not response.raw or not response.raw.content:
            return None
        body = json.loads(response.raw.content)
        bot = body.get("bot") or (body.get("data") or {}).get("bot") or {}
        open_id = bot.get("open_id")
        return open_id if isinstance(open_id, str) and open_id else None
    except Exception as exc:
        diag_log("agent.gateway.feishu.bot_identity", exc)
        return None


def _make_on_message(
    channel_id: str,
    owner: str,
    api_client,
    services: _EventServices,
    expected_app_id: str = "",
    bot_open_id: str | None = None,
):
    def _secret_preflight(payload: dict) -> bool:
        from agent.im.interaction_text import consume_mcp_secret_payload

        # 回调为同步接口；投递到进程级常驻 loop，避免每条消息创建新 loop，
        # 也避免与卡片 action 分属不同 loop 导致异步连接池反复重建。
        return services.runner.run(consume_mcp_secret_payload(payload))

    def _on_message(data: P2ImMessageReceiveV1) -> None:
        if _drop_misrouted_event(data, expected_app_id, channel_id):
            return
        if _drop_stale_event(data, channel_id):
            return
        ev = data.event
        msg = ev.message
        if not msg:
            return
        mt = msg.message_type
        open_id = ev.sender.sender_id.open_id if (ev.sender and ev.sender.sender_id) else None
        preflight_text = ""
        if mt == "text":
            try:
                preflight_text = ((json.loads(msg.content) if msg.content else {}) or {}).get("text", "").strip()
            except (json.JSONDecodeError, TypeError):
                preflight_text = ""
        normalized_chat_type = "group" if msg.chat_type == "group" else "c2c"
        if _secret_preflight({
            "platform": "feishu", "channel_id": channel_id, "owner_user_id": owner,
            "platform_user_id": open_id or "", "chat_id": msg.chat_id if normalized_chat_type == "group" else None,
            "chat_type": normalized_chat_type, "message_id": msg.message_id,
            "text": preflight_text,
            "attachments": [] if mt == "text" else [{"pending_media": True}],
        }):
            return
        attachments: list = []
        if mt == "text":
            try:
                text = ((json.loads(msg.content) if msg.content else {}) or {}).get("text", "").strip()
            except (json.JSONDecodeError, TypeError):   # 只吞「内容不是合法 JSON」这类预期失败，不裸吞未知异常（P2-b §6）
                text = ""
        elif mt in ("image", "file", "audio", "media"):
            text, attachments = _ingest_media(api_client, msg, owner)
        elif mt == "post":
            text, attachments = _ingest_post(api_client, msg, owner)
        elif mt == "interactive":
            text = _ingest_interactive(msg)
        else:
            return  # 表情/位置/合并转发等暂不处理
        text = _feishu_resolve_mention_text(msg, text)
        if not text and not attachments:
            return
        from agent.runtime import trace
        tid = trace.new_trace()

        # 引用消息：用户「回复」某条历史消息时，parent_id 指向那条被引用的消息——飞书只给 id，
        # 要反查一次内容才知道引用的是什么。引用原文单独存 quoted_text，不拼进 text——
        # runner.py 只把它喂给模型当上下文，ConversationMessage.content/网页展示仍是用户
        # 自己打的话，router/秒回表情继续用原始 text 判关键词（同一份），别再把引用原文拼进
        # 正文（网页气泡纯文本渲染，拼进去会把引用的 markdown 原样摊平显示得很难看，见 devlog
        # 2026-07-10）。
        quoted_text = _fetch_quoted_text(api_client, msg.parent_id) if msg.parent_id else None

        payload = {
            "platform": "feishu",
            "channel_id": channel_id,
            "owner_user_id": owner,      # BYO：bot 即归属
            "platform_user_id": open_id,
            "chat_id": msg.chat_id,
            "chat_type": msg.chat_type,
            "message_id": msg.message_id,
            "text": text,
            "quoted_text": quoted_text,
            "attachments": attachments,
            "trace_id": tid,             # 全链路 trace：worker/工具日志同 id，grep 可串联
        }
        # 飞书 SDK 版本可能把 at 节点解析到 mentions，也可能已将其从 text 中移除。
        # 只把明确指向当前 bot 的 mention 标为 True，不根据可见 @ 文本猜测。
        payload["bot_mentioned"] = _feishu_mentions_current_bot(msg, bot_open_id)
        payload["group_mentioned"] = payload["bot_mentioned"]
        # 隐私：不打印消息原文，只留结构+指纹（见 agent/logsafe.py），同 agent.traj 脱敏口径
        from agent.security import logsafe
        print(f"[feishu:{channel_id}] 收到 {open_id} @ {msg.chat_id} ({mt}): text_len={len(text)} "
              f"fp={logsafe.fingerprint(text)} att={len(attachments)} quoted={bool(msg.parent_id)} trace={tid}", flush=True)

        # 秒回表情：赶在入队/生成之前，用关键词快速判一个即时点上（完整回复随后由 worker 发）
        from agent.im.loop import choose_instant_reaction
        _, emoji = choose_instant_reaction(text, bool(attachments))
        services.do_react(api_client, msg.message_id, emoji)
        # 取消是实时控制信号：必须在 Gateway 侧立刻写入 Redis；其他 shortcut 继续入队，
        # 由 worker 的 IM Loop 统一处理，避免 Gateway 再承担业务回复编排。
        if not attachments:
            from agent.im.loop import apply_im_shortcut_cancel_sync, decide_im_shortcut_sync
            dec = decide_im_shortcut_sync(
                "feishu", open_id, text,
                bot_id=channel_id,
                scope_id=msg.chat_id or open_id,
            )
            if dec["action"] == "cancel":
                apply_im_shortcut_cancel_sync(
                    "feishu", open_id, dec,
                    bot_id=channel_id,
                    scope_id=msg.chat_id or open_id,
                )
                try:
                    services.do_send(api_client, msg.chat_id, dec["reply"])
                except Exception as e:
                    diag_log("agent.gateway.feishu.cancel_reply", e)
                    print(f"[feishu] 取消回复失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
                return
            if dec["action"] == "no_permission":
                # 咕咕在跑别人的 loop，当前用户无权取消：回一句提示，不入队。
                try:
                    services.do_send(api_client, msg.chat_id, dec["reply"])
                except Exception as e:
                    diag_log("agent.gateway.feishu.no_permission_reply", e)
                    print(f"[feishu] 无权取消回复失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
                return
        try:
            from agent.im.models import normalize_payload
            payload = normalize_payload(payload)
            R.produce_sync(STREAM, payload)
        except Exception as e:
            diag_log("agent.gateway.feishu.enqueue", e)   # 原始 → 受限诊断出口
            print(f"[feishu] 入队失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
    return _on_message
