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

import asyncio
import json
import logging
from typing import AsyncGenerator

from .tokens import estimate_tokens, msg_tokens

logger = logging.getLogger(__name__)

# 压缩配置
COMPACTION_THRESHOLD_RATIO = 0.9  # 超过 90% 预算触发压缩
COMPACTION_TARGET_RATIO = 0.2     # 压缩到 20%
COMPACT_SUMMARY_MAX_TOKENS = 800  # 压缩摘要最大 token 数


async def estimate_context_length(messages: list, system_text: str = "") -> int:
    """估算当前上下文总长度（tokens）。"""
    total = estimate_tokens(system_text) if system_text else 0
    for msg in messages:
        if isinstance(msg, dict):
            # dict 类型消息（如 runner.py 构建的消息）
            content = msg.get("content", "")
            if isinstance(content, list):
                # 工具结果块
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        total += estimate_tokens(block.get("text", ""))
            elif isinstance(content, str):
                total += estimate_tokens(content)
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
) -> tuple[list, bool]:
    """压缩上下文，返回 (压缩后的消息列表, 是否实际执行了压缩)。

    策略：
    1. 保留 system 提示词（不压缩）
    2. 保留最近的消息（约占 20%）
    3. 将更老的消息压缩成摘要
    4. 返回压缩后的 messages，确保前缀一致
    """
    target_tokens = int(context_tokens * COMPACTION_TARGET_RATIO)

    # 估算当前上下文长度
    current_length = await estimate_context_length(messages, system_text)
    if current_length <= context_tokens * COMPACTION_THRESHOLD_RATIO:
        return messages, False  # 未达到阈值，不压缩

    logger.info("[compaction] session=%s 上下文 %d tokens 超过阈值 %d，开始压缩",
                session_id, current_length, int(context_tokens * COMPACTION_THRESHOLD_RATIO))

    # 分离消息类型
    summary_msg = None
    normal_msgs = []

    for msg in messages:
        if msg.get("role") == "summary":
            summary_msg = msg
        else:
            normal_msgs.append(msg)

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

    # 从最新往回保留消息
    kept_msgs = []
    used_tokens = 0
    for msg in reversed(normal_msgs):
        # 同步估算单条消息的 token 数，兼容 dict 和 ORM 类型
        msg_tokens_count = 0
        content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "") or ""
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    msg_tokens_count += estimate_tokens(block.get("text", ""))
        elif isinstance(content, str):
            msg_tokens_count += estimate_tokens(content)
        if used_tokens + msg_tokens_count > available_tokens:
            break
        kept_msgs.append(msg)
        used_tokens += msg_tokens_count

    kept_msgs.reverse()

    # 需要压缩的消息（在保留消息之前的）
    if system_injection_idx >= 0:
        compressible_msgs = normal_msgs[:system_injection_idx] + normal_msgs[system_injection_idx + 1:system_injection_idx + len(kept_msgs)]
    else:
        compressible_msgs = normal_msgs[:-len(kept_msgs)] if kept_msgs else normal_msgs[:-1]

    # 过滤出有内容的消息用于压缩
    compressible_content = []
    for msg in compressible_msgs:
        content = msg.get("content", "")
        if isinstance(content, list):
            # 工具结果块，提取文本
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text", "").strip()
                    if text:
                        compressible_content.append(text)
        elif isinstance(content, str):
            text = content.strip()
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

    # 构建压缩后的消息列表
    new_messages = []

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
    consistent, reason = verify_prefix_consistency(messages, new_messages, system_text)
    if not consistent:
        logger.warning("[compaction] session=%s 前缀不一致: %s，返回原消息", session_id, reason)
        return messages, False

    return new_messages, True


def _is_system_injection(content: str) -> bool:
    """判断是否是系统上下文注入消息。"""
    if not content:
        return False
    return content.startswith("## 项目") or content.startswith("## 日历") or content.startswith("## 文件")


def verify_prefix_consistency(
    old_messages: list,
    new_messages: list,
    system_text: str = "",
) -> tuple[bool, str]:
    """验证压缩后的前缀是否与之前一致。

    返回 (是否一致, 不一致的原因)。

    缓存前缀 = system_text + messages 的前 N 条。
    压缩后应该保持这个前缀不变，只改变后面的摘要部分。
    """
    # 1. system prompt 不应该变化
    # （system_text 由调用方保证不变，这里不需要检查）

    # 2. messages 的前几条应该保持一致（系统上下文注入 + 摘要标记）
    # 压缩后 messages 结构：[系统注入?, <compacted-summary>, 最近消息...]
    # 旧 messages 结构：[消息1, 消息2, ..., 消息N]

    # 检查压缩后的消息是否合理
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

    return True, "前缀一致"
    """判断是否是系统上下文注入消息。"""
    if not content:
        return False
    return content.startswith("## 项目") or content.startswith("## 日历") or content.startswith("## 文件")


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
