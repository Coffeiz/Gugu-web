"""上下文压缩模块

当上下文长度接近模型限制时，主动压缩历史消息，保持 system 提示词不变，
确保跨 call 缓存前缀一致。

压缩策略：
- 触发条件：当前上下文长度 > 用户设置的最大上下文长度 × 90%
- 压缩目标：压缩到 token 预算的 20%
- 保护范围：system 提示词完全保留
- 前缀一致：压缩后保持前缀一致，支持跨 call 缓存
"""
from __future__ import annotations

import logging

from .tokens import estimate_tokens, message_text, msg_tokens
from .budget import HARD_TARGET_RATIO, SAFE_BUDGET_RATIO, effective_budget
from .audit import summary_change

logger = logging.getLogger(__name__)

# 压缩配置
# 保留名称供现有测试/诊断读取，实际判定统一走 budget.effective_budget。
COMPACTION_THRESHOLD_RATIO = SAFE_BUDGET_RATIO
COMPACTION_TARGET_RATIO = HARD_TARGET_RATIO  # 压缩到统一的 20%目标
COMPACT_SUMMARY_MAX_TOKENS = 800  # 压缩摘要最大 token 数


async def estimate_context_length(messages: list, system_text: str = "") -> int:
    """估算当前上下文总长度（tokens）。"""
    total = estimate_tokens(system_text) if system_text else 0
    for msg in messages:
        if isinstance(msg, dict):
            # dict 类型消息（如 runner.py 构建的消息）
            total += estimate_tokens(message_text(msg))
        else:
            # ORM ConversationMessage 对象
            total += msg_tokens(msg)
    return total


async def compact_context(
    messages: list,
    system_text: str,
    context_tokens: int,
    session_id: int | None = None,
    user_id: int | None = None,
    fixed_prefix_size: int = 0,
    overhead_tokens: int = 0,
    protected_from: int | None = None,
) -> tuple[list, bool]:
    """压缩上下文，返回 (压缩后的消息列表, 是否实际执行了压缩)。

    策略：
    1. 保留 system 提示词（不压缩）
    2. 保留最近的消息（约占 20%）
    3. 将更老的消息压缩成摘要
    4. 返回压缩后的 messages，确保前缀一致
    """
    available_context = max(1, int(context_tokens) - max(0, int(overhead_tokens)))
    target_tokens = int(available_context * COMPACTION_TARGET_RATIO)

    # 估算当前上下文长度
    current_length = overhead_tokens + await estimate_context_length(messages, system_text)
    safe_budget = effective_budget(context_tokens, reserved_tokens=overhead_tokens)
    input_length = current_length - overhead_tokens
    if input_length <= safe_budget:
        return messages, False  # 未达到阈值，不压缩

    logger.info("[compaction] session=%s 输入 %d tokens 超过预算 %d（含额外开销=%d），开始压缩",
                session_id, input_length, safe_budget, overhead_tokens)

    # snapshot/system-info 是固定前缀，不属于可压缩的 message history。
    # 普通 list 调用保持 fixed_prefix_size=0，兼容旧历史和单测。
    fixed_prefix_size = max(0, min(int(fixed_prefix_size), len(messages)))
    fixed_prefix = list(messages[:fixed_prefix_size])
    message_history = list(messages[fixed_prefix_size:])

    # 分离消息类型
    summary_msg = None
    normal_msgs = []

    for msg in message_history:
        if msg.get("role") == "summary":
            summary_msg = msg
        else:
            normal_msgs.append(msg)

    # 当前 run 模式下，protected_from 之后的消息是本轮用户输入、工具调用和结果，
    # 必须整体保留；摘要只处理它之前的历史。普通调用保持旧的“从最新往回保留”语义。
    protected_messages: list[dict] | None = None
    if protected_from is not None:
        protected_relative = max(0, int(protected_from) - fixed_prefix_size)
        protected_messages = list(normal_msgs[protected_relative:])

    # 计算保留的消息数量（从最新往回保留）
    # 系统上下文注入不计入保留预算（它总是第一个消息）
    system_injection_idx = -1
    for i, msg in enumerate(normal_msgs):
        if msg.get("role") == "user" and _is_system_injection(msg.get("content", "")):
            system_injection_idx = i
            break

    # 计算可用的 token 预算
    available_tokens = target_tokens
    if system_injection_idx >= 0:
        # 系统上下文注入占用一部分 token
        inj_msg = normal_msgs[system_injection_idx]
        inj_content = inj_msg.get("content", "") if isinstance(inj_msg, dict) else getattr(inj_msg, "content", "") or ""
        injection_tokens = estimate_tokens(inj_content)
        available_tokens -= injection_tokens

    # 当前 run 的受保护后缀不参与历史保留窗口计算，直接原样带回。
    if protected_messages is not None:
        kept_msgs = protected_messages
        kept_indices = set(range(max(0, len(normal_msgs) - len(protected_messages)), len(normal_msgs)))
        compressible_msgs = [
            msg for i, msg in enumerate(normal_msgs)
            if i != system_injection_idx and i not in kept_indices
        ]
        kept_units = []
        used_tokens = sum(estimate_tokens(message_text(msg)) for msg in kept_msgs)
    else:
        kept_msgs = []
        compressible_msgs = []

    # 从最新往回保留消息。工具调用和工具结果是 provider 语义上的一个原子单元，
    # 不能只按单条 message 切预算，否则会把 tool_result 留下而把对应 tool_use
    # 压进摘要，下一轮就会产生非法的孤儿工具消息。
    if protected_messages is None:
        kept_units = []
        used_tokens = 0
        units = _atomic_message_units(normal_msgs, system_injection_idx)
        for unit in reversed(units):
            unit_tokens = sum(estimate_tokens(message_text(normal_msgs[i])) for i in unit)
            if used_tokens + unit_tokens > available_tokens:
                break
            kept_units.append(unit)
            used_tokens += unit_tokens

        kept_units.reverse()
        if not kept_units and units:
            # 即使最新原子单元超预算也必须完整保留，不能退化成只保留其中一条。
            kept_units = [units[-1]]
            used_tokens = sum(estimate_tokens(message_text(normal_msgs[i])) for i in units[-1])

        kept_indices = [i for unit in kept_units for i in unit]
        kept_msgs = [normal_msgs[i] for i in kept_indices]

        # 以实际保留的 message index 划分，避免 injection 位于历史中间时漏掉消息。
        kept_index_set = set(kept_indices)
        compressible_msgs = [
            msg for i, msg in enumerate(normal_msgs)
            if i != system_injection_idx and i not in kept_index_set
        ]

    # 过滤出有内容的消息用于压缩
    compressible_content = []
    for msg in compressible_msgs:
        text = message_text(msg).strip()
        if text:
            role = "用户" if msg.get("role") == "user" else "咕咕"
            compressible_content.append(f"{role}：{text}")

    if not compressible_content:
        logger.warning("[compaction] compressible_content 为空，跳过压缩")
        return messages, False  # 没有可压缩的内容

    # 调用 LLM 生成压缩摘要
    logger.info("[compaction] 调用 LLM 生成摘要，compressible_content=%d 条", len(compressible_content))
    compact_summary = await _generate_compact_summary(
        compressible_content,
        summary_msg.get("content", "") if summary_msg else None,
    )

    if not compact_summary:
        return messages, False  # 压缩失败，返回原消息

    summary_change(
        source="inline_compaction",
        old=(summary_msg or {}).get("content") if summary_msg else None,
        new=compact_summary,
        session_id=session_id,
        before_messages=len(messages),
        after_messages=len(fixed_prefix) + 1 + len(kept_msgs),
        input_tokens=input_length,
        safe_budget=safe_budget,
    )

    # 构建压缩后的消息列表
    new_messages = list(fixed_prefix)

    # 保留系统上下文注入（如果存在）
    if system_injection_idx >= 0:
        new_messages.append(normal_msgs[system_injection_idx])

    # 添加压缩摘要
    compact_summary_msg = {
        "role": "user",
        "content": f"<compacted-summary>\n{compact_summary}\n</compacted-summary>"
    }
    new_messages.append(compact_summary_msg)

    # 保留最近的消息
    new_messages.extend(kept_msgs)

    logger.info("[compaction] session=%s 压缩完成：%d 条 → %d 条，保留 %d tokens",
                session_id, len(normal_msgs), len(new_messages), used_tokens)

    # 验证压缩后的前缀一致性
    consistent, reason = validate_compacted_shape(new_messages)
    if not consistent:
        logger.warning("[compaction] session=%s 前缀不一致: %s，返回原消息", session_id, reason)
        return messages, False

    return new_messages, True


def _block_types(message: dict) -> set[str]:
    content = message.get("content") if isinstance(message, dict) else None
    blocks = content if isinstance(content, list) else [content]
    return {
        str(block.get("type"))
        for block in blocks
        if isinstance(block, dict) and block.get("type")
    }


def _has_tool_call(message: dict) -> bool:
    return (
        message.get("role") == "assistant"
        and (bool(message.get("tool_calls")) or bool({"tool_use", "tool_call"} & _block_types(message)))
    )


def _has_tool_result(message: dict) -> bool:
    return message.get("role") == "tool" or "tool_result" in _block_types(message)


def _atomic_message_units(messages: list[dict], excluded_index: int = -1) -> list[list[int]]:
    """按工具往返切分 message index；普通消息仍然各自作为一个单元。"""
    indices = [i for i in range(len(messages)) if i != excluded_index]
    units: list[list[int]] = []
    cursor = 0
    while cursor < len(indices):
        start = indices[cursor]
        unit = [start]
        cursor += 1
        if _has_tool_call(messages[start]):
            while cursor < len(indices) and _has_tool_result(messages[indices[cursor]]):
                unit.append(indices[cursor])
                cursor += 1
        units.append(unit)
    return units


def _is_system_injection(content: str) -> bool:
    """判断是否是系统上下文注入消息（[system-reminder] 包裹或旧格式开头）。"""
    if not isinstance(content, str) or not content:
        return False
    return (content.startswith("[system-reminder]")
            or content.startswith("## 项目")
            or content.startswith("## 日历")
            or content.startswith("## 文件"))


def validate_compacted_shape(new_messages: list) -> tuple[bool, str]:
    """验证压缩结果包含摘要且仍保留至少一条最新消息。"""
    if not new_messages:
        return False, "压缩后消息列表为空"

    # 检查是否有摘要标记
    has_summary = False
    for msg in new_messages:
        content = msg.get("content", "")
        if isinstance(content, str) and "<compacted-summary>" in content:
            has_summary = True
            break

    if not has_summary:
        return False, "压缩后缺少 <compacted-summary> 标记"

    # 检查摘要是否在合理位置（应该在系统注入之后，最近消息之前）
    summary_idx = -1
    for i, msg in enumerate(new_messages):
        content = msg.get("content", "")
        if isinstance(content, str) and "<compacted-summary>" in content:
            summary_idx = i
            break

    if summary_idx == -1:
        return False, "未找到摘要位置"

    # 检查摘要之后是否有最近消息
    recent_msgs_after_summary = len(new_messages) - summary_idx - 1
    if recent_msgs_after_summary == 0:
        return False, "摘要之后没有最近消息"

    return True, "压缩结构有效"


async def _generate_compact_summary(
    content_list: list[str],
    prev_summary: str | None = None,
) -> str:
    """调用 LLM 生成压缩摘要。"""
    if not content_list:
        return ""

    # 构建压缩 prompt
    conv_text = "\n".join(content_list)

    if prev_summary:
        user_text = (
            f"【已有摘要（更早的对话，需与下面新增内容合并、保留全部关键信息）】\n"
            f"{prev_summary}\n\n"
            f"【新增对话】\n{conv_text}"
        )
    else:
        user_text = conv_text

    sys_prompt = (
        "你是一个对话摘要助手。请将以下对话压缩为简洁摘要，要求：\n"
        "1. 保留关键决定、事实和用户偏好\n"
        "2. 保留重要的工具调用结果\n"
        "3. 控制在 300 字以内\n"
        "4. 使用中文，保持自然流畅\n\n"
        "请直接输出摘要，不要添加任何前缀或说明。"
    )

    try:
        from app.core.config import get_settings
        from agent.memory._llm import complete_text
        settings = get_settings()
        summary = await complete_text(sys_prompt, user_text, settings=settings, max_tokens=COMPACT_SUMMARY_MAX_TOKENS)
        return summary.strip() if summary else ""
    except Exception as e:
        logger.warning("[compaction] 摘要生成失败: %s", e)
        return ""
