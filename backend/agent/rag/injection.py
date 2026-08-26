"""RAG 结果到 provider-compatible history 消息的确定性编码。"""
from __future__ import annotations

import asyncio
from collections.abc import Iterable
import logging
from typing import Any

from agent.context.serialization import knowledge_context_block


_log = logging.getLogger("agent.rag")
AUTO_RECALL_TIMEOUT_SECONDS = 3.0
MAX_BACKGROUND_RECALL_TASKS = 32
_background_recall_tasks: set[asyncio.Task] = set()


def _drain_background_task(task: asyncio.Task) -> None:
    """消费超时后仍在后台收尾的召回任务异常，避免任务被 GC 时泄漏异常。"""
    try:
        task.result()
    except BaseException:
        pass
    finally:
        _background_recall_tasks.discard(task)


async def _search_with_timeout(search_awaitable, timeout: float):
    """限制自动召回等待时间，但不取消内部 DB/存储协程。

    取消正在进行的 AsyncSession 查询可能打断 session 的异步退出，导致连接只能由
    GC 回收并触发 ``greenlet is being finalized``。超时后让查询自行完成、由它的
    context manager 释放连接，主 Agent 不再等待它。
    """
    if len(_background_recall_tasks) >= MAX_BACKGROUND_RECALL_TASKS:
        # 避免异常上游把每条消息都变成一个永不收尾的后台任务。
        if hasattr(search_awaitable, "close"):
            search_awaitable.close()
        _log.warning("自动知识召回后台任务达到上限，跳过本次查询，pending=%d",
                     len(_background_recall_tasks))
        raise asyncio.TimeoutError
    task = asyncio.create_task(search_awaitable)
    _background_recall_tasks.add(task)
    task.add_done_callback(_drain_background_task)
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except BaseException:
        if task.done():
            _log.info("自动知识召回超时边界任务已完成，未产生后台堆积")
        else:
            _log.warning("自动知识召回超时，后台任务继续收尾，pending=%d",
                         len(_background_recall_tasks))
        raise
_PASSIVE_HINTS = (
    "以前", "之前", "上次", "曾经", "当时", "历史", "记得", "记忆",
    "讨论过", "聊过", "决定", "为什么定", "回顾", "过去",
    "before", "previous", "history", "remember", "discussed",
)


def _citation_label(item: dict[str, Any]) -> str:
    citation = item.get("citation") or {}
    source = citation.get("source_type") or item.get("source") or "knowledge"
    title = citation.get("title") or item.get("title") or "未命名来源"
    return f"{source} / {title}"


def render_history_context(query: str, results: Iterable[dict[str, Any]]) -> str:
    """把已通过 scope/预算过滤的结果编码成普通文本 history。"""
    rows = [
        "[knowledge-context]",
        "以下是针对当前问题的已检索知识片段，仅作为参考；不要把来源分数当作事实置信度。",
        f"检索问题：{(query or '').strip()}",
    ]
    for index, item in enumerate(results, 1):
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        rows.extend((f"[{index}] {_citation_label(item)}", text))
    rows.append("[/knowledge-context]")
    return "\n".join(rows)


def render_scoped_history_context(
    query: str, results: Iterable[dict[str, Any]], *, label: str,
) -> str:
    """渲染自动召回区块；label 只来自固定 scope 名称，不接收用户输入。"""
    body = render_history_context(query, results)
    if not body:
        return ""
    return body.replace("[knowledge-context]", f"[{label}]").replace(
        "[/knowledge-context]", f"[/{label}]", 1
    )


def build_history_message(query: str, results: Iterable[dict[str, Any]]) -> dict[str, str] | None:
    """生成可直接放在当前 user message 前的 history 消息。

    该函数不负责召回、权限或去重，也不把内部 chunk/hash 元数据发送给模型。
    显式 `search_memory` 仍由工具执行器写入 canonical tool round；本消息只供
    未来自动召回复用，避免在 system-reminder 中复制一套注入逻辑。
    """
    result_list = list(results)
    if not any(str(item.get("text") or "").strip() for item in result_list):
        return None
    return {"role": "user", "content": render_history_context(query, result_list)}


def should_passively_recall(query: str) -> bool:
    """只对明显的历史/记忆问题启用被动召回，普通聊天不额外查询。"""
    normalized = (query or "").strip().lower()
    return bool(normalized) and any(hint in normalized for hint in _PASSIVE_HINTS)


async def build_passive_history_message(user_id, query: str) -> dict[str, str] | None:
    """按当前问题做低成本 Memory 被动召回。

    失败只跳过可选知识补充，不阻塞主 Agent；显式 `search_memory` 仍是完整结果和
    canonical tool round 的精确入口。这里固定使用 lexical，避免普通对话因 embedding
    请求增加额外延迟。
    """
    from app.core.config import get_settings

    if not get_settings().search.rag_enabled or not should_passively_recall(query):
        return None
    try:
        from agent.rag.service import search_knowledge

        result = await search_knowledge(
            user_id, query, scope="auto", source="all", strategy="bm25",
            limit=5, mode="passive",
        )
        return build_history_message(query, result.get("results", []))
    except Exception as exc:
        _log.warning("被动知识召回跳过：%s", type(exc).__name__)
        return None


def _history_rag_hashes(history: Iterable[Any]) -> set[str]:
    hashes: set[str] = set()
    for message in history or ():
        content = getattr(message, "content_json", None)
        blocks = content if isinstance(content, list) else []
        for block in blocks:
            if isinstance(block, dict) and block.get("type") == "knowledge-context":
                value = str(block.get("content_hash") or "").strip()
                if value:
                    hashes.add(value)
                for item in block.get("content_hashes") or ():
                    if str(item).strip():
                        hashes.add(str(item).strip())
    return hashes


def _request_scopes(request) -> list[tuple[str, Any]]:
    """根据已完成的 IM context policy 生成召回 scope，不自行扩大权限。"""
    from agent.rag.scope import group_scope, member_scope, owner_scope

    source = str(getattr(request, "source", "web") or "web")
    chat_id = str(getattr(request, "chat_id", "") or "")
    bot_id = str(getattr(request, "platform_bot_id", "") or "")
    if chat_id and source in {"qq", "feishu", "wechat"} and bot_id:
        scopes: list[tuple[str, Any]] = []
        if getattr(request, "im_group_memory_enabled", True):
            scopes.append(("group-rag", group_scope(request.user_id, source, bot_id, chat_id)))
        role = getattr(request, "im_role", None)
        if role == "member" and getattr(request, "im_member_memory_enabled", True):
            member_id = str(getattr(request, "platform_user_id", "") or "")
            if member_id:
                scopes.append(("group-member-rag", member_scope(
                    request.user_id, source, bot_id, chat_id, member_id
                )))
        return scopes
    # owner Web、owner 私聊和没有群上下文的私聊才允许 owner Memory。
    if source == "web" or getattr(request, "im_role", None) == "owner":
        return [("owner-rag", owner_scope(request.user_id))]
    return []


async def build_automatic_rag_context(
    request, query: str, *, history: Iterable[Any] = (), snapshot_text: str = "",
) -> dict[str, Any]:
    """每条用户消息执行一次低成本 lexical 自动召回。

    返回本轮稳定 conversation 消息和可持久化的 canonical blocks。调用方应把
    ``tail`` 放在当前用户消息之后，并作为本轮 turn batch 的一部分；这样本轮组装与
    下一轮从 history 重建时保持相同的消息边界。召回失败只跳过可选上下文，
    不阻塞主 Agent；结果按 scope 顺序合并并共享 3000 字符上限。
    """
    from app.core.config import get_settings

    if not get_settings().search.rag_enabled:
        return {"tail": [], "blocks": [], "scope_hits": [], "injected": False,
                "disabled": True}
    query = (query or "").strip()
    if not query:
        return {"tail": [], "blocks": [], "scope_hits": [], "injected": False}
    try:
        from agent.rag.service import MAX_OUTPUT_CHARS, search_knowledge
        from agent.rag.models import content_hash

        seen = _history_rag_hashes(history)
        remaining = MAX_OUTPUT_CHARS
        tail: list[dict[str, str]] = []
        blocks: list[dict[str, Any]] = []
        scope_hits: list[dict[str, Any]] = []
        from app.core.redaction import diag_log

        requested_scopes = _request_scopes(request)
        if not requested_scopes:
            return {"tail": [], "blocks": [], "scope_hits": [], "injected": False}
        labels = [label for label, _ in requested_scopes]
        label = "+".join(labels)
        scopes = [scope for _, scope in requested_scopes]
        try:
            try:
                # 自动召回是可选增强，不能阻塞主 Agent 或让 IM 一直停在“思考中”。
                # 显式 search_memory 工具仍保留自己的完整等待语义。
                result = await _search_with_timeout(
                    search_knowledge(
                        request.user_id, query, scope=scopes, source="all",
                        strategy="bm25", limit=5, mode="automatic",
                    ),
                    AUTO_RECALL_TIMEOUT_SECONDS,
                )
                if not isinstance(result, dict):
                    raise TypeError("RAG 返回值不是对象")
            except asyncio.TimeoutError:
                _log.warning("自动知识召回超时，跳过合并 scope")
                scope_hits.append({"scope": label, "candidate_count": 0, "hit_count": 0,
                                   "timeout": True})
                return {"tail": [], "blocks": [], "scope_hits": scope_hits, "injected": False}
            except Exception as exc:
                # 单一来源（例如项目索引）异常不能让群记忆/其他 scope 全部失效。
                # 原始异常只进入受限诊断出口，普通日志只保留类型和 scope。
                diag_log(f"agent.rag.auto_recall.{label}", exc)
                scope_hits.append({"scope": label, "candidate_count": 0, "hit_count": 0,
                                   "error": type(exc).__name__})
                return {"tail": [], "blocks": [], "scope_hits": scope_hits, "injected": False}
            selected: list[dict[str, Any]] = []
            for item in result.get("results", []):
                item_hash = str(item.get("content_hash") or content_hash(str(item.get("text") or "")))
                if item_hash in seen:
                    continue
                text = str(item.get("text") or "").strip()
                if not text or remaining <= 0:
                    break
                text = text[:remaining].rstrip()
                if not text:
                    break
                selected.append({**item, "text": text, "content_hash": item_hash})
                seen.add(item_hash)
                remaining -= len(text)
            scope_hits.append({"scope": label, "candidate_count": result.get("candidate_count", 0),
                               "hit_count": len(selected)})
            if not selected:
                return {"tail": [], "blocks": [], "scope_hits": scope_hits, "injected": False}
            rendered = render_scoped_history_context(query, selected, label=label)
            block = knowledge_context_block(
                scope=label,
                text=rendered,
                content_hash=content_hash(rendered),
                content_hashes=[item["content_hash"] for item in selected],
            )
            # 当前轮和持久化历史必须从同一个 canonical block 渲染，不能一处
            # 直接写纯文本、另一处恢复成 knowledge-context block。
            tail.append({"role": "user", "content": [block]})
            blocks.append(block)
        except asyncio.TimeoutError:
            return {"tail": [], "blocks": [], "scope_hits": scope_hits, "injected": False}
        return {"tail": tail, "blocks": blocks, "scope_hits": scope_hits,
                "injected": bool(tail)}
    except Exception as exc:
        _log.warning("自动知识召回跳过：%s", type(exc).__name__)
        return {"tail": [], "blocks": [], "scope_hits": [], "injected": False}
__all__ = [
    "build_history_message",
    "build_passive_history_message",
    "build_automatic_rag_context",
    "render_history_context",
    "render_scoped_history_context",
    "should_passively_recall",
]
