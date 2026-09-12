"""Provider 消息转换与历史缓存工具。

这些函数只负责把内部会话消息投影成 provider 可接受的形状，或为稳定历史
计算缓存边界；它们不参与轮次状态机，也不依赖具体 provider client。集中放在
这里可以避免 ``loop_drivers`` 同时承担消息装配和驱动生命周期管理。
"""
from __future__ import annotations

import copy
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


def _sanitize_openai_tool_history(messages: list) -> tuple[list, dict[str, Any]]:
    """清理 OpenAI 投影中的孤儿工具记录，并返回不含正文的变更摘要。

    旧会话经过截断/压缩后，可能以 role=tool 开头，或只留下 assistant 的部分
    parallel tool_calls。OpenAI 兼容 API 要求工具结果紧跟带有对应 tool_calls 的
    assistant 消息；这类旧记录会直接导致整个请求 400。只改出站副本，不改持久历史。
    """
    def clean_sequence(sequence: list[dict]) -> tuple[list[dict], list[int]]:
        cleaned: list[dict] = []
        retained_indices: list[int] = []
        index = 0
        while index < len(sequence):
            message = sequence[index]
            if not isinstance(message, dict):
                index += 1
                continue

            calls = message.get("tool_calls")
            if message.get("role") != "assistant" or not isinstance(calls, list) or not calls:
                if message.get("role") != "tool":
                    cleaned.append(dict(message))
                    retained_indices.append(index)
                index += 1
                continue

            calls_by_id: dict[str, dict] = {}
            for call in calls:
                if isinstance(call, dict) and call.get("id"):
                    calls_by_id.setdefault(str(call["id"]), call)

            tool_messages: list[tuple[int, dict]] = []
            cursor = index + 1
            while cursor < len(sequence):
                candidate = sequence[cursor]
                if not isinstance(candidate, dict) or candidate.get("role") != "tool":
                    break
                tool_messages.append((cursor, candidate))
                cursor += 1

            matched_ids = {
                str(result.get("tool_call_id"))
                for _, result in tool_messages
                if result.get("tool_call_id")
                and str(result["tool_call_id"]) in calls_by_id
            }
            if matched_ids:
                assistant = dict(message)
                assistant["tool_calls"] = [
                    call for call in calls
                    if isinstance(call, dict)
                    and str(call.get("id") or "") in matched_ids
                    and calls_by_id.get(str(call.get("id") or "")) is call
                ]
                cleaned.append(assistant)
                retained_indices.append(index)
                emitted_ids: set[str] = set()
                for result_index, result in tool_messages:
                    result_id = str(result.get("tool_call_id") or "")
                    if result_id not in matched_ids or result_id in emitted_ids:
                        continue
                    cleaned.append(dict(result))
                    retained_indices.append(result_index)
                    emitted_ids.add(result_id)
            elif message.get("content"):
                # 保留 assistant 的普通文本，但丢弃没有任何结果的调用声明。
                assistant = dict(message)
                assistant.pop("tool_calls", None)
                cleaned.append(assistant)
                retained_indices.append(index)

            # 消费整个相邻工具结果段；未配对项不会在下一轮被误当成合法结果。
            index = cursor

        return cleaned, retained_indices

    is_prompt_messages = hasattr(messages, "fixed_prefix_size")
    if is_prompt_messages:
        conversation = list(messages.conversation)
        dynamic_tail = list(messages.dynamic_tail)
    else:
        conversation = list(messages)
        dynamic_tail = []

    cleaned_conversation, retained = clean_sequence(conversation)
    cleaned_tail, retained_tail = clean_sequence(dynamic_tail)
    changed = (
        cleaned_conversation != conversation
        or cleaned_tail != dynamic_tail
    )

    def changed_indices(
        original: list[dict],
        cleaned: list[dict],
        retained: list[int],
        offset: int = 0,
    ) -> tuple[list[int], int]:
        retained_set = set(retained)
        indexes = [offset + index for index in range(len(original)) if index not in retained_set]
        indexes.extend(
            offset + original_index
            for clean_index, original_index in enumerate(retained)
            if original[original_index] != cleaned[clean_index]
        )
        modified = sum(
            original[original_index] != cleaned[clean_index]
            for clean_index, original_index in enumerate(retained)
        )
        return indexes, modified

    conversation_changes, conversation_modified = changed_indices(
        conversation, cleaned_conversation, retained,
    )
    tail_changes, tail_modified = changed_indices(
        dynamic_tail, cleaned_tail, retained_tail, offset=len(conversation),
    )
    changed_positions = conversation_changes + tail_changes
    diagnostics = {
        "applied": True,
        "changed": changed,
        "removed_messages": (
            len(conversation) - len(retained)
            + len(dynamic_tail) - len(retained_tail)
        ),
        "modified_messages": conversation_modified + tail_modified,
        "first_changed_index": min(changed_positions) if changed_positions else None,
    }

    if not is_prompt_messages:
        return (cleaned_conversation if changed else messages), diagnostics
    if not changed:
        return messages, diagnostics

    from agent.context.assembly import PromptMessages

    old_fixed_size = int(getattr(messages, "fixed_prefix_size", 0) or 0)
    fixed_prefix_size = sum(index < old_fixed_size for index in retained)
    result = PromptMessages(cleaned_conversation, fixed_prefix_size=fixed_prefix_size)
    if cleaned_tail:
        result.set_dynamic_tail(cleaned_tail)
    old_to_new = {old: new for new, old in enumerate(retained)}
    result._cache_anchor_indices = [
        old_to_new[index]
        for index in getattr(messages, "cache_anchor_indices", ())
        if index in old_to_new
    ]
    for name in ("canonical_context", "_canonical_batches", "_canonical_batch_digests"):
        if hasattr(messages, name):
            value = getattr(messages, name)
            setattr(result, name, list(value) if name.startswith("_canonical_") else value)
    if hasattr(messages, "_canonical_batch_metadata"):
        result._canonical_batch_metadata = copy.deepcopy(messages._canonical_batch_metadata)
    return result, diagnostics


def sanitize_openai_tool_history(messages: list) -> list:
    """在 OpenAI Chat Completions 请求边界移除孤儿或不完整的工具轮次。"""
    cleaned, _diagnostics = _sanitize_openai_tool_history(messages)
    return cleaned


def render_openai_request_history(
    messages: list,
    adapter,
    *,
    with_diagnostics: bool = False,
) -> list | tuple[list, dict[str, Any]]:
    """生成清洗后的 OpenAI provider 历史投影。

    缓存策略、LoopScope 和实际 Chat Completions 请求必须共用这个投影；调用方应在
    此步骤之后再计算/插入缓存锚点，避免清理历史后请求前缀与诊断指纹不一致。
    """
    rendered = adapter.render_history(messages)
    cleaned, diagnostics = _sanitize_openai_tool_history(rendered)
    return (cleaned, diagnostics) if with_diagnostics else cleaned


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


def _without_cache_control(value: Any) -> Any:
    """递归移除 provider 缓存标记，供动态尾缀出站前清理。"""
    if isinstance(value, dict):
        return {
            key: _without_cache_control(item)
            for key, item in value.items()
            if key != "cache_control"
        }
    if isinstance(value, list):
        return [_without_cache_control(item) for item in value]
    return value


def _cache_message_copy(messages: list, rendered: list[dict]):
    """复制缓存标记后的消息，同时保留 PromptMessages 的动态尾缀边界。"""
    if not hasattr(messages, "conversation"):
        return rendered

    from agent.context.assembly import PromptMessages

    # 缓存锚点可以因内联图片而提前截止，但 conversation 与 provider-only
    # dynamic_tail 的边界仍由 PromptMessages 自己定义，两者不能混用。
    conversation_count = len(messages.conversation)
    result = PromptMessages(
        rendered[:conversation_count],
        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
    )
    if len(rendered) > conversation_count:
        result.set_dynamic_tail([
            _without_cache_control(message)
            for message in rendered[conversation_count:]
        ])
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
        return _cache_message_copy(messages, list(messages))
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

    return _cache_message_copy(messages, new_messages)


def _with_single_history_cache(messages: list) -> list:
    """给稳定 conversation 只保留一个最新历史锚点。

    Qwen 的 OpenAI 兼容端点对多个历史 ``cache_control`` 锚点命中不稳定；
    system 前缀由调用方单独标记，这里不能再把 baseline 和最新尾部同时标记。
    """
    stable_limit, anchor_indices = _history_cache_state(messages)
    if stable_limit <= 0:
        return _cache_message_copy(messages, list(messages))
    # _history_cache_state 还会返回旧 baseline，供其它 provider 跨续轮使用；
    # Qwen 只能发送最新一个历史锚点，避免 provider 在工具续轮中回退到旧短前缀。
    latest_history_anchor = max(anchor_indices) if anchor_indices else None
    if latest_history_anchor is not None:
        anchor_indices = {latest_history_anchor}
    remember_anchor = getattr(messages, "remember_cache_anchor", None)
    replace_anchors = getattr(messages, "replace_cache_anchors", None)
    if replace_anchors is not None:
        replace_anchors(anchor_indices)
    elif remember_anchor is not None:
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
    return _cache_message_copy(messages, new_messages)


def _with_system_cache_control(messages: list) -> list:
    """只在 provider 请求副本上标记连续 system 前缀，避免污染会话 history。"""
    conversation_count = len(getattr(messages, "conversation", messages))
    result = copy.deepcopy(list(messages))
    for message in result[:conversation_count]:
        if message.get("role") != "system":
            break
        content = message.get("content")
        if isinstance(content, str):
            message["content"] = [{
                "type": "text", "text": content,
                "cache_control": {"type": "ephemeral"},
            }]
        elif isinstance(content, list) and content and "cache_control" not in content[-1]:
            message["content"] = [
                *content[:-1],
                {**content[-1], "cache_control": {"type": "ephemeral"}},
            ]
    # _cache_message_copy 统一负责恢复 PromptMessages 边界并清理 dynamic_tail。
    return _cache_message_copy(messages, result)


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
