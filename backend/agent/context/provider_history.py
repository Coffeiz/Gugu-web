"""provider 切换时的历史兼容边界。

thinking 块可能带供应商/模型专属签名，不能像工具事件一样跨 provider 转换。
因此这里只记录最近使用的 provider/API 格式；检测到切换时，在发送边界丢弃
历史 thinking 块，canonical history 本身保持不变。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent import providers


def render_anthropic_message_roles(messages: list[dict], adapter) -> list[dict]:
    """把 Anthropic 消息协议中的消息级 system 统一渲染为 user。

    ``system_prompt`` 仍由调用层放在顶层 ``system`` 字段；消息数组中的
    snapshot 只是内部语义标记，原生 Anthropic 和 MiniMax 兼容端都统一按
    ``user`` 发送，避免 provider 分叉改变消息边界。

    PromptMessages 的 provider-only dynamic tail/cache 边界必须跨这次 role 渲染
    保留下来，否则后续 cache helper 会把日期尾缀错误算进稳定 conversation。
    """
    rendered = [
        {**message, "role": "user"} if message.get("role") == "system" else dict(message)
        for message in messages
    ]
    if not hasattr(messages, "fixed_prefix_size"):
        return rendered

    from agent.context.assembly import PromptMessages

    conversation_count = len(getattr(messages, "conversation", messages))
    result = PromptMessages(
        rendered[:conversation_count],
        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
    )
    if len(rendered) > conversation_count:
        result.set_dynamic_tail(rendered[conversation_count:])
    remember_anchor = getattr(result, "remember_cache_anchor", None)
    if remember_anchor is not None:
        for index in getattr(messages, "cache_anchor_indices", ()):
            remember_anchor(index)
    return result


@dataclass(frozen=True)
class ProviderHistoryState:
    provider: str
    api_format: str


def state_for(ai: Any) -> ProviderHistoryState:
    adapter = providers.adapter_for(ai)
    return ProviderHistoryState(
        provider=str(adapter.name or "unknown"),
        api_format=str(adapter.protocol_format(ai) or "unknown"),
    )


def prepare_session(session: Any, ai: Any) -> tuple[ProviderHistoryState, bool]:
    """记录本轮协议并返回是否需要清理历史 thinking。

    旧 session 没有 provenance 时只做一次兼容清理；之后相同配置不会重复处理。
    """
    current = state_for(ai)
    previous_provider = getattr(session, "history_provider", None)
    previous_format = getattr(session, "history_api_format", None)
    changed = (
        previous_provider is None
        or previous_format is None
        or previous_provider != current.provider
        or previous_format != current.api_format
    )
    if changed:
        from .audit import provider_history_change
        provider_history_change(
            session=session,
            previous_provider=previous_provider,
            previous_api_format=previous_format,
            provider=current.provider,
            api_format=current.api_format,
            stripped=True,
        )
    session.history_provider = current.provider
    session.history_api_format = current.api_format
    return current, changed


def strip_thinking_blocks(value: Any) -> Any:
    """复制并删除 thinking/reasoning 块，不修改数据库对象或原始 canonical history。"""
    if isinstance(value, list):
        return [item for item in value if not (
            isinstance(item, dict)
            and item.get("type") in {"thinking", "reasoning_content"}
        )]
    if isinstance(value, dict):
        if value.get("type") in {"thinking", "reasoning_content"}:
            return None
        return dict(value)
    return value


def clean_persisted_history(messages: list[Any]) -> int:
    """就地清理 ORM 历史消息，并返回清理的 block 数量。

    只在 provider/API 格式切换的那一轮调用；调用方随后与本轮用户消息一起提交，
    避免旧签名在下一轮重新进入请求。
    """
    removed = 0
    for message in messages:
        content = getattr(message, "content_json", None)
        if not isinstance(content, list):
            continue
        cleaned = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in {"thinking", "reasoning_content"}:
                removed += 1
                continue
            cleaned.append(block)
        if removed and cleaned != content:
            message.content_json = cleaned
    return removed
