"""飞书 CardKit 卡片流式更新、完成收尾与失败降级。"""
from __future__ import annotations

import asyncio
import json
import time
import uuid

import httpx

from app.core.redaction import diag_log, diag_log_raw, redact
from .cards import _build_card_elements, _make_card_payload
from .messages import _creds_by_id, send_text

_STREAM_PATCH_INTERVAL_S = 0.2

_STREAM_PATCH_MIN_CHARS = 30

_tenant_token_cache: dict[str, tuple[str, float]] = {}   # app_id -> (token, expire_ts)


async def _get_tenant_token(app_id: str, app_secret: str) -> str:
    now = time.time()
    cached = _tenant_token_cache.get(app_id)
    if cached and cached[1] > now + 60:
        return cached[0]
    async with httpx.AsyncClient(timeout=10.0) as cli:
        resp = await cli.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        )
        data = resp.json()
    token = data.get("tenant_access_token", "")
    if not token or data.get("code", -1) != 0:
        # 上游响应体可能回显请求里的 app_id/app_secret 片段，绝不能拼进异常消息（P2-b §5）；
        # 原始体只进受限诊断出口，异常消息只给通用文案。
        diag_log_raw("agent.gateway.feishu._get_tenant_token", f"data={data}")
        raise RuntimeError("飞书 tenant_access_token 获取失败（响应缺 token 字段或 code 非 0）")
    expire = int(data.get("expire", 7200))
    _tenant_token_cache[app_id] = (token, now + expire)
    return token


async def _do_create_card(app_id: str, app_secret: str, text: str,
                          *, elements: list[dict] | None = None) -> str | None:
    """raw httpx 版 create_card：返回 card_id 或 None。

    已知坑：
      - lark SDK 的 Transport.execute 把 dict body 用 `requests.request(data=...)`（form-encoded）
        发出去，飞书 CardKit 服务端校验 schema 失败返 99992402；包络结构 + data 是 JSON string 又会
        被网关注解成「body is nil」(200610)。SDK 的 create()/acreate()/update() 都不能用。
      - httpx 的 `json=` 自动设 Content-Type 为 application/json（不带 charset），服务端 spec 强制
        `application/json; charset=utf-8`，实测也会触发 200610。必须用 `content=` + 手动设带 charset。
      - 内嵌 card JSON 必须是 schema 2.0 完整结构（schema + header + body.elements），否则
        field validation 失败。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        diag_log("agent.gateway.feishu.tenant_token", e)   # 原始 → 受限诊断出口
        print(f"[feishu] tenant_token 拿失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return None
    body = {"type": "card_json", "data": _make_card_payload(text, elements=elements)}
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.post(
                "https://open.feishu.cn/open-apis/cardkit/v1/cards",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        diag_log("agent.gateway.feishu.create_card", e)   # 原始 → 受限诊断出口
        print(f"[feishu] create_card 异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return None
    if data.get("code") != 0:
        print(f"[feishu] create_card 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return None
    return data.get("data", {}).get("card_id")


async def _do_send_card_message(app_id: str, app_secret: str, receive_id: str,
                                card_id: str) -> bool:
    """把 CardKit card entity 当一条 interactive 消息发出去——这是用户能看到卡片的「桥」步骤。

    仅 create_card 不发，user 端永远看不到；必须 POST /open-apis/im/v1/messages，
    content 是 {"type":"card","data":{"card_id":<card_id>}} 的 JSON-string。

    ⚠ 关键：这里 type 是 "card" 不是 "template"！
    - type="card" + data.card_id = CardKit card entity（我用的，流式更新专用）
    - type="template" + data.template_id = Card Builder GUI 创建的模板（与 API 路线不同）
    之前这里误写成 template 卡 ID 被飞书当 template_id 找，返 200380 "template does not exist"。

    card entity 只能 send 一次（官方 spec "A card entity can only be sent once"），后续靠
    _do_update_card（或 element 级别 streaming update endpoint）改内容。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        diag_log("agent.gateway.feishu.tenant_token", e)   # 原始 → 受限诊断出口
        print(f"[feishu] tenant_token 拿失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    rid_type = "open_id" if str(receive_id).startswith("ou_") else "chat_id"
    body = {
        "receive_id": receive_id,
        "msg_type": "interactive",
        "content": json.dumps({"type": "card", "data": {"card_id": card_id}}, ensure_ascii=False),
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.post(
                f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={rid_type}",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        diag_log("agent.gateway.feishu.send_card_message", e)   # 原始 → 受限诊断出口
        print(f"[feishu] send_card_message 异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] send_card_message 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True

_card_seq: dict[str, int] = {}   # card_id -> 当前最大 sequence（同进程内防乱序；跨进程由各 worker 自管）

_STREAM_TARGET_ELEMENT_ID = "markdown_1"


async def _do_streaming_update_text(app_id: str, app_secret: str, card_id: str,
                                     content: str, sequence: int, uuid: str,
                                     element_id: str = _STREAM_TARGET_ELEMENT_ID) -> bool:
    """element 级别流式更新（PUT /open-apis/cardkit/v1/cards/{cid}/elements/{eid}/content）。

    这是飞书官方的「Streaming Update Text」接口，比整卡 PUT 更轻——服务端自动增量渲染
    typewriter 效果（spec streaming-updates-openapi-overview / 300310 等；要求 card config 中
    streaming_mode=true + element_id 存在 + sequence 单调递增 + uuid 唯一避免冲突）。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        diag_log("agent.gateway.feishu.tenant_token", e)   # 原始 → 受限诊断出口
        print(f"[feishu] tenant_token 拿失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    body = {"content": content, "sequence": sequence, "uuid": uuid}
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.request(
                "PUT",
                f"https://open.feishu.cn/open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        diag_log("agent.gateway.feishu.streaming_update_text", e)   # 原始 → 受限诊断出口
        print(f"[feishu] streaming_update_text 异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] streaming_update_text 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True


async def _do_finalize_streaming_card(app_id: str, app_secret: str, card_id: str,
                                      summary_text: str, sequence: int, uuid: str) -> bool:
    """关闭 CardKit streaming_mode，并设置会话列表 summary。

    这是纯收尾动作：失败不影响用户已经看到的最终卡片正文。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        diag_log("agent.gateway.feishu.tenant_token", e)   # 原始 → 受限诊断出口
        print(f"[feishu] tenant_token 拿失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    preview = (summary_text or "").strip()
    if len(preview) > 80:
        preview = preview[:77] + "..."
    if not preview:
        preview = "✅"
    settings = {
        "config": {
            "streaming_mode": False,
            "summary": {"content": preview},
        },
    }
    body = {
        "settings": json.dumps(settings, ensure_ascii=False),
        "sequence": sequence,
        "uuid": uuid,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.request(
                "PATCH",
                f"https://open.feishu.cn/open-apis/cardkit/v1/cards/{card_id}/settings",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        diag_log("agent.gateway.feishu.finalize_streaming_card", e)   # 原始 → 受限诊断出口
        print(f"[feishu] finalize_streaming_card 异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] finalize_streaming_card 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True


async def _do_update_card(app_id: str, app_secret: str, card_id: str, text: str, *, sequence: int,
                          title: str = "咕咕思考中", streaming_mode: bool = True,
                          elements: list[dict] | None = None) -> bool:
    """raw httpx 版 update_card：节流策略由 caller 控制（每 ≥200ms 或 ≥30 字调一次）。

    HTTP method 是 **PUT**——SDK update() 签名的也是 PUT（cardkit/v1/model/update_card_request
    源码：update_card_request.http_method = HttpMethod.PUT）。
    `sequence` 必须由调用方传入且严格递增——**同一 card_id 下，element 级 streaming update /
    settings PATCH / 整卡 PUT 共用同一套单调递增序列**（之前误以为整卡 PUT 是独立序列空间，
    自己另开一个 `_card_seq[card_id]` 计数器从 1 起，结果实测报 300317 sequence number
    compare failed——飞书服务端按 card_id 维度判断，不分端点）。所以收尾改标题必须复用
    调用方（send_text_stream）手上那个 `_stream_seq_key` 计数器继续往上加，不能自己另起。

    `title`/`streaming_mode`：流式收尾时用来把卡片标题从「咕咕思考中」改成「咕咕」、
    同时关掉 streaming_mode（见 send_text_stream 收尾调用）。
    """
    try:
        token = await _get_tenant_token(app_id, app_secret)
    except Exception as e:
        diag_log("agent.gateway.feishu.tenant_token", e)   # 原始 → 受限诊断出口
        print(f"[feishu] tenant_token 拿失败: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    body = {
        "card": {
            "type": "card_json",
            "data": _make_card_payload(
                text, title=title, streaming_mode=streaming_mode, elements=elements,
            ),
        },
        "sequence": sequence,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.request(
                "PUT",
                f"https://open.feishu.cn/open-apis/cardkit/v1/cards/{card_id}",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
                content=json.dumps(body, ensure_ascii=False),
            )
        data = resp.json()
    except Exception as e:
        diag_log("agent.gateway.feishu.update_card", e)   # 原始 → 受限诊断出口
        print(f"[feishu] update_card 异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False
    if data.get("code") != 0:
        print(f"[feishu] update_card 失败: code={data.get('code')} msg={data.get('msg')}", flush=True)
        return False
    return True


def _stream_fallback_text(text: str, has_files: bool) -> str:
    """模型只调工具（比如发文件）没配文字说明时的兜底，跟 worker.py 非流式路径同一套文案。

    实测踩坑：模型光发文件不说话时 final_text 是空串，之前的 _patch/finalize/rename 全部
    `if final_text:` 短路跳过，导致卡片正文真的是空的——用户得追问「发了吗」模型才在下一轮
    正常说话。worker.py 的非流式路径本来就有这个兜底（有文件配「给你～」），但只在
    `not (platform == "feishu" and stream_sent)` 时才发送，飞书流式成功时被跳过，
    所以流式卡片这边必须自己兜底一次，不能指望 worker.py 那份。"""
    text = (text or "").strip()
    if text:
        return text
    return "给你～" if has_files else "嗯~在的，你说～"


async def _send_tool_summary_stream(
    app_id: str,
    app_secret: str,
    card_id: str,
    token_iter,
    summary,
    *,
    show_intermediate_replies: bool,
) -> tuple[bool, "AgentResponse | None"]:
    """同一卡片串行呈现正文与工具摘要；只供用户主动开启摘要时使用。"""
    stream_seq_key = f"{card_id}:stream"

    def _next_sequence() -> int:
        _card_seq[stream_seq_key] = _card_seq.get(stream_seq_key, 0) + 1
        return _card_seq[stream_seq_key]

    async def _write_elements(elements: list[dict]) -> bool:
        return await _do_update_card(
            app_id,
            app_secret,
            card_id,
            "",
            sequence=_next_sequence(),
            elements=elements,
        )

    summary.bind(_write_elements)
    accumulated = ""
    pending_final_text: str | None = None
    final_resp = None
    stream_ok = True
    last_patch_ts = time.monotonic()
    last_patched_len = 0
    active_element_id = summary.active_text_id

    try:
        async for kind, payload in token_iter:
            if not summary.healthy:
                stream_ok = False
            if kind == "token":
                if not show_intermediate_replies:
                    continue
                accumulated += payload
                needs_card_update = summary.append_text(payload)
                current_element_id = summary.active_text_id
                if not stream_ok or not current_element_id:
                    continue
                if needs_card_update:
                    stream_ok = await summary.flush()
                    last_patch_ts = time.monotonic()
                    last_patched_len = len(summary.active_text)
                    active_element_id = current_element_id
                    continue
                if current_element_id != active_element_id:
                    # 新 Markdown 元素必须先通过整卡更新创建，再调用元素级流式接口。
                    stream_ok = await summary.flush()
                    last_patch_ts = time.monotonic()
                    last_patched_len = len(summary.active_text)
                    active_element_id = current_element_id
                    continue
                now = time.monotonic()
                text = summary.active_text
                if (now - last_patch_ts >= _STREAM_PATCH_INTERVAL_S
                        or len(text) - last_patched_len >= _STREAM_PATCH_MIN_CHARS):
                    _card_seq[stream_seq_key] = _card_seq.get(stream_seq_key, 0) + 1
                    stream_ok = await _do_streaming_update_text(
                        app_id,
                        app_secret,
                        card_id,
                        text,
                        sequence=_card_seq[stream_seq_key],
                        uuid=uuid.uuid4().hex,
                        element_id=current_element_id,
                    )
                    if not stream_ok:
                        summary.mark_failed()
                    last_patch_ts = now
                    last_patched_len = len(text)
            elif kind == "round_end":
                summary.end_round()
                active_element_id = None
            elif kind == "final":
                final_resp = payload
                if payload.cancelled:
                    summary.finish("", cancelled=True)
                    pending_final_text = accumulated
                else:
                    pending_final_text = _stream_fallback_text(
                        payload.text or accumulated,
                        bool(payload.files),
                    )
                    summary.finish(pending_final_text)
    except Exception as exc:
        diag_log("agent.gateway.feishu.tool_summary_stream_consume", exc)
        print(
            f"[feishu] 工具摘要流消费异常: {redact(f'{type(exc).__name__}: {exc}')}",
            flush=True,
        )
        stream_ok = False

    if final_resp is None and accumulated:
        pending_final_text = accumulated
        summary.finish(accumulated)

    if summary.healthy:
        stream_ok = await summary.flush() and stream_ok
    else:
        stream_ok = False

    final_text = pending_final_text or ""
    if stream_ok:
        if final_text:
            _card_seq[stream_seq_key] = _card_seq.get(stream_seq_key, 0) + 1
            finalized = await _do_finalize_streaming_card(
                app_id,
                app_secret,
                card_id,
                final_text,
                sequence=_card_seq[stream_seq_key],
                uuid=uuid.uuid4().hex,
            )
            if not finalized:
                print(
                    f"[feishu] 工具摘要卡片 finalize 失败但保留已更新卡片: card_id={card_id}",
                    flush=True,
                )
        _card_seq[stream_seq_key] = _card_seq.get(stream_seq_key, 0) + 1
        renamed = await _do_update_card(
            app_id,
            app_secret,
            card_id,
            "",
            sequence=_card_seq[stream_seq_key],
            title="咕咕",
            streaming_mode=False,
            elements=summary.elements(),
        )
        if not renamed:
            print(f"[feishu] 工具摘要卡片收尾改标题失败: card_id={card_id}", flush=True)
    # 占位卡片已经作为用户可见消息发送；即使后续卡片更新失败，也要阻止
    # IM Loop 再发一条重复正文。Run 仍完整消费，响应对象照常交给后续收尾。
    return True, final_resp


async def send_text_stream(receive_id: str, token_iter, channel_id: str | None = None,
                          placeholder: str = "咕咕正在想…",
                          show_intermediate_replies: bool = True,
                          tool_summary=None) -> tuple[bool, "AgentResponse | None"]:
    """飞书流式回复（IM 端模拟 SSE）。

    Args:
        receive_id: chat_id（oc_xxx）或 open_id（ou_xxx）
        token_iter: async iterator，yield ("token", str) / ("final", AgentResponse)（agent.runner.run_stream）
        channel_id: user_bot.id
        placeholder: 占位卡片首屏文案
        tool_summary: 可选的 FeishuToolSummaryStream；仅用户开启工具展示时传入

    Returns: (ok, final_response)——ok 表示流式/fallback 是否成功；final_response 是 run_stream
    yield 的 AgentResponse（含 session_id），消费端需要它来续写 Redis 会话映射。如果 token_iter
    没 yield final（异常退出等），final_response 为 None。
    """
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] user_bot {channel_id} 无凭据，流式回复跳过", flush=True)
        return (False, None)
    # 之前的 lark.Client 缓存不再使用——card API 直走 httpx（绕 SDK bug）。
    # _clients 仍保留供 send_text / react / send_file 等其他路径继续用 SDK。

    # 1) 创建占位卡片
    card_id = await _do_create_card(app_id, app_secret, placeholder)
    if not card_id:
        # 权限不够 / 接口失败 → fallback 普通 send_text（攒完 token 后一次性发）
        print(f"[feishu] 流式 fallback：create_card 失败，改走普通 send_text", flush=True)
        accumulated = ""
        final_resp = None
        async for kind, payload in token_iter:
            if kind == "token" and show_intermediate_replies:
                accumulated += payload
            elif kind == "final":
                final_resp = payload
        final_text = _stream_fallback_text(
            final_resp.text if final_resp is not None else accumulated,
            bool(final_resp and final_resp.files),
        )
        if final_text:
            ok = await send_text(receive_id, final_text, channel_id)
            return (ok, final_resp)
        return (False, final_resp)

    # 2) 把 card_id 当一条 interactive 消息发出去——不 send，user 端永远看不到。
    # card entity 官方约束：只能 send 一次（spec 200305），所以后续靠 update_card 改内容。
    if not await _do_send_card_message(app_id, app_secret, receive_id, card_id):
        print(f"[feishu] 流式 fallback：send_card_message 失败，退到普通 send_text", flush=True)
        accumulated = ""
        final_resp = None
        async for kind, payload in token_iter:
            if kind == "token" and show_intermediate_replies:
                accumulated += payload
            elif kind == "final":
                final_resp = payload
        final_text = _stream_fallback_text(
            final_resp.text if final_resp is not None else accumulated,
            bool(final_resp and final_resp.files),
        )
        if final_text:
            ok = await send_text(receive_id, final_text, channel_id)
            return (ok, final_resp)
        return (False, final_resp)

    if tool_summary is not None:
        return await _send_tool_summary_stream(
            app_id,
            app_secret,
            card_id,
            token_iter,
            tool_summary,
            show_intermediate_replies=show_intermediate_replies,
        )

    # 3) 初始化 element 级流式更新的 sequence（sequence 从 1 开始严格递增）
    stream_seq = 0

    _stream_seq_key = f"{card_id}:stream"

    async def _patch(text: str) -> bool:
        """element 级别 streaming update 本地计数器 + 调用。

        uuid 是幂等键——飞书 spec 200770 同 UUID 只生效一次，所以每次 patch 都需要新 UUID。
        """
        _card_seq[_stream_seq_key] = _card_seq.get(_stream_seq_key, 0) + 1
        try:
            return await _do_streaming_update_text(app_id, app_secret, card_id, text,
                                                   sequence=_card_seq[_stream_seq_key],
                                                   uuid=uuid.uuid4().hex)
        except Exception as e:
            diag_log("agent.gateway.feishu.streaming_update_text", e)   # 原始 → 受限诊断出口
            print(f"[feishu] streaming_update_text 异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
            return False

    # 4) 流式消费 token + 节流 patch（element 级接口，服务端自动增量渲染）
    accumulated = ""
    last_patch_ts = time.monotonic()
    last_patched_len = 0
    pending_final_text: str | None = None
    final_resp = None
    stream_ok = True
    try:
        async for kind, payload in token_iter:
            if kind == "token":
                if not show_intermediate_replies:
                    continue
                accumulated += payload
                now = time.monotonic()
                # 节流：时间 OR 长度任一满足就 patch（保证短响应也能及时显示）
                if (now - last_patch_ts >= _STREAM_PATCH_INTERVAL_S
                        or len(accumulated) - last_patched_len >= _STREAM_PATCH_MIN_CHARS):
                    if stream_ok:
                        stream_ok = await _patch(accumulated)
                    last_patch_ts = now
                    last_patched_len = len(accumulated)
            elif kind == "final":
                # final AgentResponse：text 可能比 accumulated 多（出口兜底 sanitize_outbound/strip_disallowed_emoji
                # 在 runner 末尾做过清洗，最终版更准）；如果不同就以 final.text 为准再 patch 一次
                final_resp = payload
                if payload.cancelled:
                    # 用户中途取消 → 卡片保留 partial 内容（不清空，避免给用户错觉"什么都没了"）
                    pending_final_text = accumulated
                    continue
                pending_final_text = _stream_fallback_text(payload.text or accumulated, bool(payload.files))
                # final 先交给发送层，继续消费到生成器自然结束，确保 runner 的
                # session gate 能执行 baseline update。
                continue
    except Exception as e:
        diag_log("agent.gateway.feishu.stream_consume", e)   # 原始 → 受限诊断出口
        print(f"[feishu] 流式消费异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)

    # 5) 收尾：把最终版（final.text 优先；如果 final 没拿到就用 accumulated）patch 进卡片
    final_text = pending_final_text or accumulated
    if stream_ok and final_text and final_text != accumulated:
        stream_ok = await _patch(final_text)
    elif stream_ok and final_text:
        # 已 patch 过同文本 → 不用再 patch，但仍显式结束一下（飞书端 streaming update 幂等）
        stream_ok = await _patch(final_text)
    if stream_ok:
        _card_seq[_stream_seq_key] = _card_seq.get(_stream_seq_key, 0) + 1
        finalized = await _do_finalize_streaming_card(
            app_id, app_secret, card_id, final_text,
            sequence=_card_seq[_stream_seq_key], uuid=uuid.uuid4().hex)
        if not finalized:
            print(f"[feishu] finalize_streaming_card 失败但保留已更新卡片: card_id={card_id}", flush=True)
        # 收尾把标题从「咕咕思考中」改成「咕咕」——思考已经结束，继续挂着思考中的标题很怪。
        # 复用同一个 _stream_seq_key 计数器继续递增（这张卡的 sequence 是跨端点共享的，
        # 见 _do_update_card 里的踩坑记录），不能自己另起一套。
        _card_seq[_stream_seq_key] = _card_seq.get(_stream_seq_key, 0) + 1
        renamed = await _do_update_card(app_id, app_secret, card_id, final_text,
                                        sequence=_card_seq[_stream_seq_key],
                                        title="咕咕", streaming_mode=False)
        if not renamed:
            print(f"[feishu] 收尾改标题失败，保留「咕咕思考中」: card_id={card_id}", flush=True)
    return (stream_ok, final_resp)
