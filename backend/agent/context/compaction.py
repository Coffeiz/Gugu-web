"""上下文压缩模块。

正常路径由 provider 的实际响应决定是否发生溢出；溢出后压缩旧 history 并重试当前
round。run 收尾时，provider 实际输入达到模型预算的 90% 才异步更新 baseline，避免
用本地估算提前改变上下文。压缩只保留最近一段完整 history，其余旧 history
按当前模型输入/输出预算滚动合并为摘要；system 前缀和当前 run 后缀始终保留。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from .tokens import content_text, message_text
from .tokens import estimate_tokens
from .audit import summary_change
from .canonical_context import tool_call_ids, tool_result_ids
from .summary_format import SUMMARY_CLOSE, SUMMARY_OPEN, format_compacted_summary

logger = logging.getLogger(__name__)

RECENT_HISTORY_KEEP_CHARS = 20_000  # 压缩后保留的最近完整 history 字符上限


@dataclass(frozen=True)
class CompactionLimits:
    """本轮模型的压缩输入/输出预算。"""

    context_tokens: int
    input_tokens: int
    output_tokens: int


def resolve_compaction_limits(model_cfg) -> CompactionLimits:
    """按实际模型配置计算摘要请求预算。

    输入预算为总上下文扣除模型输出预算，避免摘要请求本身挤占输出空间。
    """
    configured_context = getattr(model_cfg, "context_tokens", None)
    if configured_context is None or int(configured_context) <= 1:
        raise ValueError("模型缺少有效的 context_tokens")
    context = int(configured_context)
    configured_output = getattr(model_cfg, "max_tokens", None)
    if configured_output is None or int(configured_output) <= 0:
        raise ValueError("模型缺少有效的 max_tokens")
    output = min(int(configured_output), context - 1)
    return CompactionLimits(
        context_tokens=context,
        input_tokens=max(1, context - output),
        output_tokens=output,
    )


@dataclass(frozen=True)
class CompactionResult:
    """一次压缩尝试的结构化结果。"""

    messages: list
    changed: bool
    return_reason: str
    before_tokens: int | None
    after_tokens: int | None


def _result(messages: list, changed: bool, reason: str,
            before_tokens: int | None, after_tokens: int | None = None) -> CompactionResult:
    return CompactionResult(
        messages=messages,
        changed=changed,
        return_reason=reason,
        before_tokens=before_tokens,
        after_tokens=before_tokens if after_tokens is None else after_tokens,
    )


async def compact_context(
    messages: list,
    session_id: int | None = None,
    fixed_prefix_size: int = 0,
    protected_from: int | None = None,
    *,
    model_cfg,
) -> CompactionResult:
    """压缩上下文，返回 (压缩后的消息列表, 是否实际执行了压缩)。

    策略：
    1. 保留固定前缀（不压缩）
    2. 保留最近约 20k 字符的完整 history，工具轮次保持原子性
    3. 将更老的全部消息分块滚动压缩成一条摘要
    4. 返回压缩后的 messages，确保前缀一致
    """
    logger.info(
        "[compaction] session=%s 输入预算分项=%s，开始压缩",
        session_id,
        {"providerUsage": "required"},
    )
    limits = resolve_compaction_limits(model_cfg)
    # 保留窗口是历史结构策略，不等同于摘要请求的输入预算；摘要请求本身使用
    # limits.input_tokens，随本轮模型 context_tokens/max_tokens 变化。
    recent_char_limit = min(RECENT_HISTORY_KEEP_CHARS, max(1, limits.context_tokens // 2))

    # snapshot/system-info 是固定前缀，不属于可压缩的 message history。
    # 普通 list 调用保持 fixed_prefix_size=0，兼容旧历史和单测。
    fixed_prefix_size = max(0, min(int(fixed_prefix_size), len(messages)))
    fixed_prefix = list(messages[:fixed_prefix_size])
    message_history = _drop_orphan_tool_results(list(messages[fixed_prefix_size:]))

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
        if msg.get("role") in {"user", "system"} and _is_system_injection(msg.get("content", "")):
            system_injection_idx = i
            break

    # 当前 run 的受保护后缀不参与历史保留窗口计算，直接原样带回；
    # 其之前最近约 20k 字符的完整 history 也保留。这里使用字符上限，
    # 不把本地 token 估算混入上下文决策。
    if protected_messages is not None:
        protected_start = max(0, len(normal_msgs) - len(protected_messages))
        prior_units = _atomic_message_units(normal_msgs[:protected_start],
                                            system_injection_idx if system_injection_idx < protected_start else -1)
        kept_prior_units = []
        prior_chars = 0
        for unit in reversed(prior_units):
            unit_chars = sum(len(message_text(normal_msgs[i])) for i in unit)
            if prior_chars + unit_chars > recent_char_limit:
                if not kept_prior_units:
                    continue
                break
            kept_prior_units.append(unit)
            prior_chars += unit_chars
        kept_prior_units.reverse()
        kept_prior_indices = [i for unit in kept_prior_units for i in unit]
        kept_indices = set(kept_prior_indices) | set(range(protected_start, len(normal_msgs)))
        kept_msgs = [normal_msgs[i] for i in kept_prior_indices] + protected_messages
        compressible_msgs = [
            msg for i, msg in enumerate(normal_msgs)
            if i != system_injection_idx and i not in kept_indices
        ]
        kept_units = []
        used_chars = sum(len(message_text(msg)) for msg in kept_msgs)
    else:
        kept_msgs = []
        compressible_msgs = []
        kept_units = []
        used_chars = 0

    # 从最新往回保留消息。工具调用和工具结果是 provider 语义上的一个原子单元，
    # 不能只按单条 message 切预算，否则会把 tool_result 留下而把对应 tool_use
    # 压进摘要，下一轮就会产生非法的孤儿工具消息。
    if protected_messages is None:
        kept_units = []
        used_chars = 0
        units = _atomic_message_units(normal_msgs, system_injection_idx)
        for unit in reversed(units):
            unit_chars = sum(len(message_text(normal_msgs[i])) for i in unit)
            if used_chars + unit_chars > recent_char_limit:
                break
            kept_units.append(unit)
            used_chars += unit_chars

        kept_units.reverse()
        if not kept_units and units:
            # 即使最新原子单元超预算也必须完整保留，不能退化成只保留其中一条。
            kept_units = [units[-1]]
            used_chars = sum(len(message_text(normal_msgs[i])) for i in units[-1])

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
        result = _result(messages, False, "no_compressible_history", None)
        return result

    # 调用 LLM 生成压缩摘要
    logger.info("[compaction] 调用 LLM 生成摘要，compressible_content=%d 条", len(compressible_content))
    compact_summary = await _generate_compact_summary(
        compressible_content,
        summary_msg.get("content", "") if summary_msg else None,
        model_cfg=model_cfg,
    )

    summary_ok, summary_reason = validate_compact_summary(
        compact_summary,
        max_output_tokens=limits.output_tokens,
    )
    if not summary_ok:
        logger.warning("[compaction] session=%s 摘要候选校验失败: %s", session_id, summary_reason)
        result = _result(messages, False, "summary_validation_failed", None)
        return result

    summary_change(
        source="inline_compaction",
        old=(summary_msg or {}).get("content") if summary_msg else None,
        new=compact_summary,
        session_id=session_id,
        before_messages=len(messages),
        after_messages=len(fixed_prefix) + 1 + len(kept_msgs),
        provider_usage_required=True,
    )

    # 构建压缩后的消息列表
    new_messages = list(fixed_prefix)

    # 保留系统上下文注入（如果存在）
    if system_injection_idx >= 0:
        new_messages.append(normal_msgs[system_injection_idx])

    # 添加压缩摘要
    compact_summary_msg = {
        "role": "user",
        "content": format_compacted_summary(compact_summary),
    }
    new_messages.append(compact_summary_msg)

    # 保留最近约 20k 字符的完整消息单元
    new_messages.extend(kept_msgs)

    logger.info("[compaction] session=%s 压缩完成：%d 条 → %d 条，保留 %d 字符",
                session_id, len(normal_msgs), len(new_messages), used_chars)

    # 验证压缩后的前缀一致性
    consistent, reason = validate_compacted_shape(new_messages)
    if not consistent:
        logger.warning("[compaction] session=%s 前缀不一致: %s，返回原消息", session_id, reason)
        result = _result(messages, False, "shape_validation_failed", None)
        return result

    # provider usage 不会在这里重新调用；下一次请求由 provider 作为唯一裁判。
    result = _result(new_messages, True, "compacted", None, None)
    return result


def _atomic_message_units(messages: list[dict], excluded_index: int = -1) -> list[list[int]]:
    """按匹配的工具往返切分 message index；普通消息仍然各自作为一个单元。

    只有相邻消息且调用/result id 有交集时才归为一个工具单元。这样异常历史中的
    孤儿 result 不会因为“看起来像 result”而被压缩边界误保留。
    """
    indices = [i for i in range(len(messages)) if i != excluded_index]
    units: list[list[int]] = []
    cursor = 0
    while cursor < len(indices):
        start = indices[cursor]
        unit = [start]
        cursor += 1
        pending_call_ids = set(tool_call_ids(messages[start]))
        while pending_call_ids and cursor < len(indices):
            result_ids = tool_result_ids(messages[indices[cursor]])
            matched = pending_call_ids & result_ids
            if not matched:
                break
            unit.append(indices[cursor])
            pending_call_ids.difference_update(matched)
            cursor += 1
        units.append(unit)
    return units


def _drop_orphan_tool_results(messages: list[dict]) -> list[dict]:
    """删除没有紧邻匹配调用的 tool_result，保留其他 block 原样。

    这是压缩前的兼容清理，不负责把 provider wire format 重新渲染；它只处理
    已知非法的孤儿结果，避免结果被最新窗口保留并在下一次请求中触发 400。
    """
    cleaned: list[dict] = []
    pending_call_ids: frozenset[str] = frozenset()
    for message in messages:
        current = dict(message)
        result_ids = tool_result_ids(current)
        call_ids = tool_call_ids(current)
        if result_ids:
            matched = pending_call_ids & result_ids
            content = current.get("content")
            blocks = content if isinstance(content, list) else None
            if not matched:
                if current.get("role") == "tool":
                    pending_call_ids = frozenset()
                    continue
                if blocks is not None:
                    blocks = [
                        block for block in blocks
                        if not (
                            isinstance(block, dict)
                            and block.get("type") == "tool_result"
                        )
                    ]
                    if blocks:
                        current["content"] = blocks
                    else:
                        pending_call_ids = frozenset()
                        continue
            elif blocks is not None:
                current["content"] = [
                    block for block in blocks
                    if not (
                        isinstance(block, dict)
                        and block.get("type") == "tool_result"
                        and str(block.get("tool_call_id") or block.get("tool_use_id") or "")
                        not in matched
                    )
                ]
        cleaned.append(current)
        if result_ids:
            # 一个 assistant 可以并行发起多个调用，连续 result 必须共享同一
            # pending 集合；不能在第一个 result 后用空的 call_ids 覆盖它。
            pending_call_ids = pending_call_ids - matched
        else:
            pending_call_ids = call_ids
    return cleaned


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
        if isinstance(content, str) and SUMMARY_OPEN in content:
            has_summary = True
            break

    if not has_summary:
        return False, "压缩后缺少 <compacted-summary> 标记"

    # 检查摘要是否在合理位置（应该在系统注入之后，最近消息之前）
    summary_idx = -1
    for i, msg in enumerate(new_messages):
        content = msg.get("content", "")
        if isinstance(content, str) and SUMMARY_OPEN in content:
            summary_idx = i
            break

    if summary_idx == -1:
        return False, "未找到摘要位置"

    # 检查摘要之后是否有最近消息
    recent_msgs_after_summary = len(new_messages) - summary_idx - 1
    if recent_msgs_after_summary == 0:
        return False, "摘要之后没有最近消息"

    return True, "压缩结构有效"


def validate_compact_summary(
    summary: object,
    *,
    max_output_tokens: int,
) -> tuple[bool, str]:
    """校验模型返回的摘要候选，避免坏结果进入 inline history 或 baseline。

    外层 ``<compacted-summary>`` 包裹由组装器统一添加，因此模型不能返回另一份
    包裹或结构化响应；这样失败时可以安全丢弃候选，不污染当前消息和持久 baseline。
    """
    if not isinstance(summary, str) or not summary.strip():
        return False, "摘要为空"
    value = summary.strip()
    if estimate_tokens(value) > max_output_tokens:
        return False, "摘要超过模型输出预算"
    if SUMMARY_OPEN in value or SUMMARY_CLOSE in value:
        return False, "摘要包含外层包裹标记"
    return True, "摘要候选有效"


async def _generate_compact_summary(
    content_list: list[str],
    prev_summary: str | None = None,
    *,
    model_cfg,
) -> str:
    """使用共享分支/fallback 策略生成摘要。"""
    async def call_once(items, previous):
        return await _generate_compact_summary_once(items, previous, model_cfg=model_cfg)

    return await generate_compact_summary(
        content_list,
        prev_summary,
        call_once,
        model_cfg=model_cfg,
    )


async def generate_compact_summary(content_list, prev_summary, call_once, *, model_cfg) -> str:
    """统一执行分支式摘要，超限时才退回滚动 fallback。

    ``call_once`` 由调用方提供，以便 inline compaction 和持久 baseline 复用同一
    边界策略，同时保留各自的 provider/settings 路由。
    """
    if not content_list:
        return ""

    limits = resolve_compaction_limits(model_cfg=model_cfg)
    max_input_tokens = max(1, limits.input_tokens - estimate_tokens(prev_summary or ""))

    chunks: list[list[str]] = []
    current: list[str] = []
    current_size = 0
    for item in content_list:
        item_size = estimate_tokens(item)
        if current and current_size + item_size > max_input_tokens:
            chunks.append(current)
            current = []
            current_size = 0
        current.append(item)
        current_size += item_size
    if current:
        chunks.append(current)

    # 在安全输入上限内只发一次独立摘要请求。调用方稍后才会替换当前 run
    # 的内存消息，因而这里不会改变真实 session；超限时保留原有分块滚动策略。
    all_text = "\n".join(content_list)
    fits_single_request = estimate_tokens(all_text) + estimate_tokens(prev_summary or "") <= limits.input_tokens
    if fits_single_request:
        return await call_once(content_list, prev_summary)

    summary = prev_summary
    for chunk in chunks:
        summary = await call_once(chunk, summary)
        if not summary:
            return ""
    return summary or ""


async def _generate_compact_summary_once(
    content_list: list[str],
    prev_summary: str | None = None,
    *,
    model_cfg,
) -> str:
    """执行单个摘要块；调用方负责跨块滚动合并。"""
    if not content_list:
        return prev_summary or ""

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

    prompt_path = Path(__file__).parent.parent / "prompts" / "compress_conv.md"
    try:
        sys_prompt = prompt_path.read_text(encoding="utf-8").strip()
    except Exception:
        sys_prompt = (
            "请将历史对话压缩为供后续任务继续使用的中文状态摘要，并严格按“### 1. 对话摘要、"
            "### 2. 当前任务、### 3. 遗留问题、### 4. 重要决策与约束、### 5. 关键细节”分章节输出。"
            "保留用户目标、关键经历、"
            "已确认事实、决定、已完成/未完成状态、阻塞原因和待确认事项。默认丢弃附件、引用、"
            "完整工具参数、原始 JSON、URL 和中间调用，只保留会影响后续工作的结论。"
            "不确定内容标记为待确认，不要把口头说明写成已完成；只输出摘要正文。"
        )

    try:
        from app.core.config import get_settings
        from agent.context.branch import ContextBranch
        from agent.context.branch_types import BranchInput, BranchPolicy
        settings = get_settings()
        limits = resolve_compaction_limits(model_cfg=model_cfg)
        result = await ContextBranch().run(
            # 保持旧压缩 Prompt 的 user 正文逐字稳定；分支标识只进入审计元数据。
            BranchInput(stable_system=sys_prompt, delta=user_text),
            BranchPolicy(
                name="compaction",
                output_mode="text",
                max_tokens=limits.output_tokens,
                max_retries=0,
            ),
            settings,
        )
        summary = result.output if result.ok else ""
        return str(summary).strip() if summary else ""
    except Exception as e:
        logger.warning("[compaction] 摘要生成失败: %s", e)
        return ""
