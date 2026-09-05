"""Provider 消息转换与历史缓存工具。

这些函数只负责把内部会话消息投影成 provider 可接受的形状，或为稳定历史
计算缓存边界；它们不参与轮次状态机，也不依赖具体 provider client。集中放在
这里可以避免 ``loop_drivers`` 同时承担消息装配和驱动生命周期管理。
"""
from __future__ import annotations

import json
from typing import Any


def _contains_volatile_image(value: Any) -> bool:
    """识别会改变请求前缀的内联图片，不把其后的内容推进缓存断点。"""
    if isinstance(value, dict):
        if value.get("type") == "image":
            source = value.get("source") or {}
            if isinstance(source, dict) and source.get("type") == "base64" and source.get("data"):
                return True
        if value.get("type") == "image_url":
            image_url = value.get("image_url") or {}
            url = image_url.get("url") if isinstance(image_url, dict) else image_url
            if isinstance(url, str) and url.startswith("data:"):
                return True
        return any(_contains_volatile_image(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_volatile_image(item) for item in value)
    return False


def _volatile_message_indices(messages: list) -> set[int]:
    """记录首轮请求中带内联图片的消息位置，后续只折叠这些初始图片。"""
    return {
        index for index, message in enumerate(messages)
        if _contains_volatile_image(message)
    }


def _collapse_volatile_messages(messages: list, indices: set[int]) -> None:
    """模型首轮消费图片后，把初始图片消息收敛为稳定文本。"""
    for index in indices:
        if index < 0 or index >= len(messages):
            continue
        message = messages[index]
        content = message.get("content")
        if not isinstance(content, list) or not _contains_volatile_image(content):
            continue
        text_parts = [
            str(block.get("text"))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
        ]
        message["content"] = "\n".join(text_parts) or "[图片已查看]"


def _history_cache_state(messages: list) -> tuple[int, set[int]]:
    """计算实际请求会使用的稳定边界和缓存断点。"""
    conversation = getattr(messages, "conversation", messages)
    cache_limit = len(conversation)
    if cache_limit <= 0:
        return 0, set()

    volatile_index = next(
        (index for index, message in enumerate(conversation[:cache_limit])
         if _contains_volatile_image(message)),
        None,
    )
    stable_limit = volatile_index if volatile_index is not None else cache_limit
    anchor_indices = {
        index for index in getattr(messages, "cache_anchor_indices", [])
        if 0 <= index < stable_limit
    }
    latest_anchor = stable_limit - 1
    if anchor_indices:
        # 续轮只保留最早 baseline 和当前尾部；不要把中间普通 user 消息提升为断点。
        anchor_indices = {min(anchor_indices)}
    else:
        if latest_anchor >= 0:
            anchor_indices.add(latest_anchor)
        # 新请求需要从稳定 conversation 中找到 baseline；工具结果不能作为 baseline。
        for index in range(stable_limit - 2, -1, -1):
            message = conversation[index]
            if message.get("role") != "user":
                continue
            content = message.get("content")
            blocks = content if isinstance(content, list) else []
            if blocks and all(
                isinstance(block, dict) and block.get("type") == "tool_result"
                for block in blocks
            ):
                continue
            anchor_indices.add(index)
            break
    if latest_anchor >= 0:
        anchor_indices.add(latest_anchor)
    return stable_limit, anchor_indices


def _cache_message_copy(messages: list, rendered: list[dict], stable_limit: int):
    """复制缓存标记后的消息，同时保留 PromptMessages 的动态尾缀边界。"""
    if not hasattr(messages, "conversation"):
        return rendered

    from agent.context.assembly import PromptMessages

    result = PromptMessages(
        rendered[:stable_limit],
        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
    )
    if len(rendered) > stable_limit:
        result.set_dynamic_tail(rendered[stable_limit:])
    result._cache_anchor_indices = list(getattr(messages, "cache_anchor_indices", ()))
    for name in (
        "canonical_context", "_canonical_batches", "_canonical_batch_digests",
        "_canonical_batch_metadata",
    ):
        if hasattr(messages, name):
            setattr(result, name, getattr(messages, name))
    return result


def _with_history_cache(messages: list) -> list:
    """给稳定历史添加 cache_control，不修改原始会话消息。"""
    if not messages:
        return messages

    # 动态尾部每轮都会变化，缓存断点必须落在固定 conversation 的末尾。
    stable_limit, anchor_indices = _history_cache_state(messages)
    if stable_limit <= 0:
        return list(messages)
    remember_anchor = getattr(messages, "remember_cache_anchor", None)
    if remember_anchor is not None:
        for index in sorted(anchor_indices):
            remember_anchor(index)

    new_messages = []
    for index, message in enumerate(messages):
        clone = dict(message)
        content = clone.get("content")
        is_anchor = index in anchor_indices and index < stable_limit
        if isinstance(content, list) and is_anchor and content:
            clone["content"] = content[:-1] + [
                {**content[-1], "cache_control": {"type": "ephemeral"}}
            ]
        elif isinstance(content, str) and is_anchor:
            clone["content"] = [{
                "type": "text", "text": content,
                "cache_control": {"type": "ephemeral"},
            }]
        new_messages.append(clone)

    return _cache_message_copy(messages, new_messages, stable_limit)


def _with_single_history_cache(messages: list) -> list:
    """给稳定 conversation 保留跨 Run baseline 和最新尾部两个历史锚点。"""
    stable_limit, anchor_indices = _history_cache_state(messages)
    if stable_limit <= 0:
        return list(messages)
    remember_anchor = getattr(messages, "remember_cache_anchor", None)
    if remember_anchor is not None:
        for index in sorted(anchor_indices):
            remember_anchor(index)
    new_messages = []
    for index, message in enumerate(messages):
        clone = dict(message)
        content = clone.get("content")
        if index in anchor_indices and index < stable_limit:
            if isinstance(content, list) and content:
                clone["content"] = content[:-1] + [
                    {**content[-1], "cache_control": {"type": "ephemeral"}}
                ]
            elif isinstance(content, str):
                clone["content"] = [{
                    "type": "text", "text": content,
                    "cache_control": {"type": "ephemeral"},
                }]
        elif message.get("role") != "system" and isinstance(content, list):
            clone["content"] = [
                {key: value for key, value in block.items() if key != "cache_control"}
                if isinstance(block, dict) else block
                for block in content
            ]
        new_messages.append(clone)
    return _cache_message_copy(messages, new_messages, stable_limit)


def _openai_tool_result(res: Any, *, allow_images: bool = True) -> tuple[str, list[dict]]:
    """把工具返回的 Anthropic 视觉块转换成 OpenAI 可接受的消息。"""
    if not isinstance(res, list):
        if isinstance(res, str):
            return res, []
        return json.dumps(res, ensure_ascii=False), []

    text_parts: list[str] = []
    image_parts: list[dict] = []
    for block in res:
        if not isinstance(block, dict):
            text_parts.append(str(block))
            continue
        if block.get("type") == "text":
            value = block.get("text")
            if value:
                text_parts.append(str(value))
            continue
        if block.get("type") == "image":
            if not allow_images:
                text_parts.append("[图片结果已返回，但当前模型不支持视觉输入]")
                continue
            source = block.get("source") or {}
            if source.get("type") == "base64" and source.get("data"):
                media = source.get("media_type") or "image/jpeg"
                image_parts.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{media};base64,{source['data']}",
                        "detail": "auto",
                    },
                })
                continue
        # 未知块不要直接丢失，保留不会破坏 OpenAI schema 的摘要。
        text_parts.append(json.dumps(block, ensure_ascii=False))

    return "\n".join(text_parts) or "工具已执行。", image_parts
