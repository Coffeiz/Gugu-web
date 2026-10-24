"""飞书 CardKit 卡片流式更新、完成收尾与失败降级。"""
from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass, field

import httpx

from app.core.redaction import diag_log, diag_log_raw, redact
from .cards import _build_card_elements, _make_card_payload
from .messages import _creds_by_id, send_text

_STREAM_PATCH_INTERVAL_S = 0.2

_STREAM_PATCH_MIN_CHARS = 30
_MERMAID_SOURCE_RE = re.compile(r"```mermaid[ \t]*\r?\n[\s\S]*?```", re.IGNORECASE)

_tenant_token_cache: dict[str, tuple[str, float]] = {}   # app_id -> (token, expire_ts)


@dataclass(frozen=True)
class _MermaidCardImages:
    images: list[tuple[bytes, str]]
    receive_id: str
    channel_id: str | None


@dataclass
class _ToolSummaryStreamState:
    accumulated: str = ""
    pending_final_text: str | None = None
    final_response: object | None = None
    stream_ok: bool = True
    last_patch_ts: float = field(default_factory=time.monotonic)
    last_patched_len: int = 0
    active_element_id: str | None = None
    embedded_image_numbers: set[int] = field(default_factory=set)
    embedded_sources: list[str] = field(default_factory=list)


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


async def _send_queued_mermaid_images(
    images: list[tuple[bytes, str]], receive_id: str, channel_id: str | None,
) -> None:
    """卡片收尾后顺序发送 Mermaid PNG；单张失败只回退该图源码。"""
    if not images:
        return
    from .messages import send_file

    for png, source in images:
        try:
            sent = await send_file(receive_id, png, "mermaid-diagram", "png", channel_id)
        except Exception as exc:
            diag_log("agent.gateway.feishu.mermaid_image", exc)
            sent = False
        if not sent and source:
            try:
                await send_text(receive_id, source, channel_id)
            except Exception as exc:
                diag_log("agent.gateway.feishu.mermaid_fallback", exc)


def _markdown_elements(text: str) -> list[dict]:
    elements = _build_card_elements(text)
    for element in elements:
        element.pop("element_id", None)
    return elements


def _elements_with_live_mermaid_images(
    text: str,
    image_keys: dict[int, tuple[str, str]],
    *,
    keep_active_element: bool = False,
) -> tuple[list[dict], str | None]:
    """将已渲染的 Mermaid fence 原位换成图片，并给后续流式文本分配新元素 ID。"""
    elements: list[dict] = []
    cursor = 0
    diagram_index = 0
    for match in _MERMAID_SOURCE_RE.finditer(text or ""):
        diagram_index += 1
        replacement = image_keys.get(diagram_index)
        if replacement and replacement[0] == match.group(0):
            if match.start() > cursor:
                elements.extend(_markdown_elements(text[cursor:match.start()]))
            elements.append({"tag": "img", "img_key": replacement[1], "mode": "fit_horizontal"})
            cursor = match.end()
    if cursor < len(text or ""):
        elements.extend(_markdown_elements(text[cursor:]))

    if not elements:
        elements = _markdown_elements(text or " ")

    markdown_id = 0
    for element in elements:
        if element.get("tag") == "markdown":
            markdown_id += 1
            element["element_id"] = f"markdown_{markdown_id}"

    active_element_id = None
    if keep_active_element:
        if not elements or elements[-1].get("tag") != "markdown":
            markdown_id += 1
            active_element_id = f"markdown_{markdown_id}"
            elements.append({"tag": "markdown", "content": " ", "element_id": active_element_id})
        else:
            active_element_id = str(elements[-1]["element_id"])
    return elements, active_element_id


async def _upload_mermaid_image(png: bytes, channel_id: str | None) -> str | None:
    from .messages import upload_image

    try:
        return await upload_image(png, channel_id)
    except Exception as exc:
        diag_log("agent.gateway.feishu.mermaid_upload", exc)
        return None


class _ProgressiveFeishuCard:
    """管理单张飞书卡片的正文流、Mermaid 原位替换和流式收尾。"""

    def __init__(self, app_id: str, app_secret: str, card_id: str, channel_id: str | None) -> None:
        self.app_id = app_id
        self.app_secret = app_secret
        self.card_id = card_id
        self.channel_id = channel_id
        self.sequence_key = f"{card_id}:stream"
        self.accumulated = ""
        self.active_text = ""
        self.active_element_id = _STREAM_TARGET_ELEMENT_ID
        self.image_keys: dict[int, tuple[str, str]] = {}
        self.image_numbers_by_diagram: dict[int, int] = {}
        self.embedded_image_numbers: set[int] = set()
        self.embedded_sources: list[str] = []
        self.stream_ok = True
        self.last_patch_ts = time.monotonic()
        self.last_patched_len = 0

    def _next_sequence(self) -> int:
        _card_seq[self.sequence_key] = _card_seq.get(self.sequence_key, 0) + 1
        return _card_seq[self.sequence_key]

    async def _patch(self, text: str) -> bool:
        try:
            return await _do_streaming_update_text(
                self.app_id,
                self.app_secret,
                self.card_id,
                text,
                sequence=self._next_sequence(),
                uuid=uuid.uuid4().hex,
                element_id=self.active_element_id,
            )
        except Exception as exc:
            diag_log("agent.gateway.feishu.streaming_update_text", exc)
            print(
                f"[feishu] 流式更新异常: {redact(f'{type(exc).__name__}: {exc}')}",
                flush=True,
            )
            return False

    async def append_text(self, text: str) -> None:
        self.accumulated += text
        self.active_text += text
        now = time.monotonic()
        if (now - self.last_patch_ts >= _STREAM_PATCH_INTERVAL_S
                or len(self.active_text) - self.last_patched_len >= _STREAM_PATCH_MIN_CHARS):
            if self.stream_ok:
                self.stream_ok = await self._patch(self.active_text)
            self.last_patch_ts = now
            self.last_patched_len = len(self.active_text)

    async def replace_mermaid(self, payload) -> None:
        diagram_index, image_number, source, png = payload
        image_key = await _upload_mermaid_image(png, self.channel_id)
        if not image_key:
            return
        candidate_keys = dict(self.image_keys)
        candidate_keys[diagram_index] = (source, image_key)
        elements, next_element_id = _elements_with_live_mermaid_images(
            self.accumulated,
            candidate_keys,
            keep_active_element=True,
        )
        if not await _do_update_card(
            self.app_id,
            self.app_secret,
            self.card_id,
            "",
            sequence=self._next_sequence(),
            elements=elements,
        ):
            return
        self.image_keys = candidate_keys
        self.image_numbers_by_diagram[diagram_index] = image_number
        self.embedded_image_numbers.add(image_number)
        self.embedded_sources.append(source)
        self.active_element_id = next_element_id or _STREAM_TARGET_ELEMENT_ID
        self.active_text = self.accumulated.rsplit(source, 1)[-1]
        self.last_patch_ts = time.monotonic()
        self.last_patched_len = len(self.active_text)

    async def finish(self, final_text: str) -> bool:
        if not self.stream_ok:
            return False
        if final_text:
            final_tail = (
                final_text.rsplit(self.embedded_sources[-1], 1)[-1]
                if self.embedded_sources and self.embedded_sources[-1] in final_text
                else self.active_text if self.embedded_sources else final_text
            )
            self.stream_ok = await self._patch(final_tail)
        if not self.stream_ok:
            return False

        if final_text:
            finalized = await _do_finalize_streaming_card(
                self.app_id,
                self.app_secret,
                self.card_id,
                final_text,
                sequence=self._next_sequence(),
                uuid=uuid.uuid4().hex,
            )
            if not finalized:
                print(f"[feishu] finalize_streaming_card 失败但保留已更新卡片: card_id={self.card_id}", flush=True)

        elements = (
            _elements_with_live_mermaid_images(final_text, self.image_keys)[0]
            if self.image_keys else None
        )
        renamed = await _do_update_card(
            self.app_id,
            self.app_secret,
            self.card_id,
            final_text,
            sequence=self._next_sequence(),
            title="咕咕",
            streaming_mode=False,
            elements=elements,
        )
        if not renamed:
            print(f"[feishu] 收尾改标题失败，保留「咕咕思考中」: card_id={self.card_id}", flush=True)
        elif self.image_keys:
            matches = list(_MERMAID_SOURCE_RE.finditer(final_text or ""))
            self.embedded_image_numbers = {
                self.image_numbers_by_diagram[index]
                for index, (source, _image_key) in self.image_keys.items()
                if index <= len(matches) and matches[index - 1].group(0) == source
            }
        return renamed

    def remaining_images(self, images: list[tuple[bytes, str]]) -> list[tuple[bytes, str]]:
        return [
            image for image_number, image in enumerate(images, start=1)
            if image_number not in self.embedded_image_numbers
        ]


async def _replace_tool_summary_mermaid(summary, channel_id: str | None, payload) -> bool:
    _diagram_index, _image_number, source, png = payload
    image_key = await _upload_mermaid_image(png, channel_id)
    if not image_key or not summary.replace_active_text_with_image(source, image_key):
        return False
    return await summary.flush()


async def _append_tool_summary_token(
    app_id: str,
    app_secret: str,
    card_id: str,
    summary,
    state: _ToolSummaryStreamState,
    payload: str,
) -> None:
    state.accumulated += payload
    needs_card_update = summary.append_text(payload)
    current_element_id = summary.active_text_id
    if not state.stream_ok or not current_element_id:
        return
    if needs_card_update or current_element_id != state.active_element_id:
        state.stream_ok = await summary.flush()
        state.last_patch_ts = time.monotonic()
        state.last_patched_len = len(summary.active_text)
        state.active_element_id = current_element_id
        return

    now = time.monotonic()
    active_text = summary.active_text
    if (now - state.last_patch_ts >= _STREAM_PATCH_INTERVAL_S
            or len(active_text) - state.last_patched_len >= _STREAM_PATCH_MIN_CHARS):
        _card_seq[f"{card_id}:stream"] = _card_seq.get(f"{card_id}:stream", 0) + 1
        state.stream_ok = await _do_streaming_update_text(
            app_id,
            app_secret,
            card_id,
            active_text,
            sequence=_card_seq[f"{card_id}:stream"],
            uuid=uuid.uuid4().hex,
            element_id=current_element_id,
        )
        if not state.stream_ok:
            summary.mark_failed()
        state.last_patch_ts = now
        state.last_patched_len = len(active_text)


async def _handle_tool_summary_mermaid(
    summary, state: _ToolSummaryStreamState, channel_id: str | None, payload,
) -> None:
    _diagram_index, image_number, source, _png = payload
    replaced = await _replace_tool_summary_mermaid(summary, channel_id, payload)
    if replaced:
        state.embedded_image_numbers.add(image_number)
        state.embedded_sources.append(source)
        state.active_element_id = summary.active_text_id
        state.last_patch_ts = time.monotonic()
        state.last_patched_len = len(summary.active_text)
    elif not summary.healthy:
        state.stream_ok = False
        summary.mark_failed()


async def _send_tool_summary_stream(
    app_id: str,
    app_secret: str,
    card_id: str,
    token_iter,
    summary,
    *,
    mermaid: _MermaidCardImages,
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
    state = _ToolSummaryStreamState(active_element_id=summary.active_text_id)

    try:
        async for kind, payload in token_iter:
            if not summary.healthy:
                state.stream_ok = False
            if kind == "token":
                await _append_tool_summary_token(app_id, app_secret, card_id, summary, state, payload)
            elif kind == "round_end":
                summary.end_round()
                state.active_element_id = None
            elif kind == "mermaid_image":
                await _handle_tool_summary_mermaid(summary, state, mermaid.channel_id, payload)
            elif kind == "final":
                state.final_response = payload
                if payload.cancelled:
                    summary.finish("", cancelled=True)
                    state.pending_final_text = state.accumulated
                else:
                    state.pending_final_text = _stream_fallback_text(
                        payload.text or state.accumulated,
                        bool(payload.files),
                    )
                    final_tail = (
                        state.pending_final_text.rsplit(state.embedded_sources[-1], 1)[-1]
                        if state.embedded_sources and state.embedded_sources[-1] in state.pending_final_text
                        else summary.active_text if state.embedded_sources else state.pending_final_text
                    )
                    summary.finish(final_tail)
    except Exception as exc:
        diag_log("agent.gateway.feishu.tool_summary_stream_consume", exc)
        print(
            f"[feishu] 工具摘要流消费异常: {redact(f'{type(exc).__name__}: {exc}')}",
            flush=True,
        )
        state.stream_ok = False

    if state.final_response is None and state.accumulated:
        state.pending_final_text = state.accumulated
        summary.finish(state.accumulated)

    if summary.healthy:
        state.stream_ok = await summary.flush() and state.stream_ok
    else:
        state.stream_ok = False

    final_text = state.pending_final_text or ""
    renamed = False
    if state.stream_ok:
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
        elements = summary.elements()
        _card_seq[stream_seq_key] = _card_seq.get(stream_seq_key, 0) + 1
        renamed = await _do_update_card(
            app_id,
            app_secret,
            card_id,
            "",
            sequence=_card_seq[stream_seq_key],
            title="咕咕",
            streaming_mode=False,
            elements=elements,
        )
        if not renamed:
            print(f"[feishu] 工具摘要卡片收尾改标题失败: card_id={card_id}", flush=True)
    remaining_images = [
        image for image_number, image in enumerate(mermaid.images, start=1)
        if image_number not in state.embedded_image_numbers
    ]
    await _send_queued_mermaid_images(remaining_images, mermaid.receive_id, mermaid.channel_id)
    # 占位卡片已经作为用户可见消息发送；即使后续卡片更新失败，也要阻止
    # IM Loop 再发一条重复正文。Run 仍完整消费，响应对象照常交给后续收尾。
    return True, state.final_response


async def send_text_stream(receive_id: str, token_iter, channel_id: str | None = None,
                          placeholder: str = "咕咕正在想…",
                          tool_summary=None,
                          show_intermediate_replies: bool = True,
                          mermaid_theme_preferences: dict | None = None) -> tuple[bool, "AgentResponse | None"]:
    """飞书流式回复（IM 端模拟 SSE）。

    Args:
        receive_id: chat_id（oc_xxx）或 open_id（ou_xxx）
        token_iter: async iterator，yield ("token", str) / ("final", AgentResponse)（agent.runner.run_stream）
        channel_id: user_bot.id
        placeholder: 占位卡片首屏文案
        tool_summary: 可选的 FeishuToolSummaryStream；仅用户开启工具展示时传入
        show_intermediate_replies: 是否允许在缺少 final 事件时回退发送已收到的中间文本

    Returns: (ok, final_response)——ok 表示流式/fallback 是否成功；final_response 是 run_stream
    yield 的 AgentResponse（含 session_id），消费端需要它来续写 Redis 会话映射。如果 token_iter
    没 yield final（异常退出等），final_response 为 None。
    """
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] user_bot {channel_id} 无凭据，流式回复跳过", flush=True)
        return (False, None)

    # 先原样流出 Mermaid 源码；完整 fence 渲染成功后，通过整卡更新原位替换为图片。
    from agent.im.mermaid import ProgressiveMermaidTokenFilter

    mermaid_filter = ProgressiveMermaidTokenFilter(
        theme_preferences=mermaid_theme_preferences,
        preserve_source=True,
    )
    token_iter = mermaid_filter.events(token_iter)
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
            if kind == "token":
                accumulated += payload
            elif kind == "final":
                final_resp = payload
        if final_resp is not None and final_resp.cancelled:
            partial_text = accumulated.strip()
            sent = await send_text(receive_id, partial_text, channel_id) if partial_text else False
            await _send_queued_mermaid_images(mermaid_filter.images, receive_id, channel_id)
            return (sent, final_resp)
        final_text = _stream_fallback_text(
            final_resp.text if final_resp is not None else (
                accumulated if show_intermediate_replies else ""
            ),
            bool(final_resp and final_resp.files),
        )
        if final_text:
            ok = await send_text(receive_id, final_text, channel_id)
            await _send_queued_mermaid_images(mermaid_filter.images, receive_id, channel_id)
            return (ok, final_resp)
        await _send_queued_mermaid_images(mermaid_filter.images, receive_id, channel_id)
        return (False, final_resp)

    # 2) 把 card_id 当一条 interactive 消息发出去——不 send，user 端永远看不到。
    # card entity 官方约束：只能 send 一次（spec 200305），所以后续靠 update_card 改内容。
    if not await _do_send_card_message(app_id, app_secret, receive_id, card_id):
        print(f"[feishu] 流式 fallback：send_card_message 失败，退到普通 send_text", flush=True)
        accumulated = ""
        final_resp = None
        async for kind, payload in token_iter:
            if kind == "token":
                accumulated += payload
            elif kind == "final":
                final_resp = payload
        if final_resp is not None and final_resp.cancelled:
            partial_text = accumulated.strip()
            sent = await send_text(receive_id, partial_text, channel_id) if partial_text else False
            await _send_queued_mermaid_images(mermaid_filter.images, receive_id, channel_id)
            return (sent, final_resp)
        final_text = _stream_fallback_text(
            final_resp.text if final_resp is not None else (
                accumulated if show_intermediate_replies else ""
            ),
            bool(final_resp and final_resp.files),
        )
        if final_text:
            ok = await send_text(receive_id, final_text, channel_id)
            await _send_queued_mermaid_images(mermaid_filter.images, receive_id, channel_id)
            return (ok, final_resp)
        await _send_queued_mermaid_images(mermaid_filter.images, receive_id, channel_id)
        return (False, final_resp)

    if tool_summary is not None:
        result = await _send_tool_summary_stream(
            app_id,
            app_secret,
            card_id,
            token_iter,
            tool_summary,
            mermaid=_MermaidCardImages(mermaid_filter.images, receive_id, channel_id),
        )
        return result

    # 3) 初始化 element 级流式更新的 sequence（sequence 从 1 开始严格递增）
    # 4) 流式消费 token + 节流 patch（element 级接口，服务端自动增量渲染）
    card_stream = _ProgressiveFeishuCard(app_id, app_secret, card_id, channel_id)
    pending_final_text: str | None = None
    final_resp = None
    try:
        async for kind, payload in token_iter:
            if kind == "token":
                await card_stream.append_text(payload)
            elif kind == "mermaid_image":
                await card_stream.replace_mermaid(payload)
            elif kind == "final":
                # final AgentResponse：text 可能比 accumulated 多（出口兜底 sanitize_outbound/strip_disallowed_emoji
                # 在 runner 末尾做过清洗，最终版更准）；如果不同就以 final.text 为准再 patch 一次
                final_resp = payload
                if payload.cancelled:
                    # 用户中途取消 → 卡片保留 partial 内容（不清空，避免给用户错觉"什么都没了"）
                    pending_final_text = card_stream.accumulated
                    continue
                pending_final_text = _stream_fallback_text(
                    payload.text or card_stream.accumulated,
                    bool(payload.files),
                )
                # final 先交给发送层，继续消费到生成器自然结束，确保 runner 的
                # session gate 能执行 baseline update。
                continue
    except Exception as e:
        diag_log("agent.gateway.feishu.stream_consume", e)   # 原始 → 受限诊断出口
        print(f"[feishu] 流式消费异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)

    # 5) 收尾；未能原位嵌入的 PNG 才作为独立图片消息回退。
    final_text = pending_final_text or card_stream.accumulated
    await card_stream.finish(final_text)
    remaining_images = card_stream.remaining_images(mermaid_filter.images)
    await _send_queued_mermaid_images(remaining_images, receive_id, channel_id)
    return (card_stream.stream_ok, final_resp)
