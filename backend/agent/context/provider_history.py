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
    """把内部系统上下文渲染成原生 Anthropic 可接受的消息角色。

    Anthropic Messages API 的 ``system`` 是顶层字段，消息数组只接受 user/
    assistant。因此内部仍保留 system 语义，只有原生 Anthropic wire 边界把
    消息级 reminder 转成 user；MiniMax 的 Anthropic 兼容接口按已验证能力
    保留 system role。
    """
    if getattr(adapter, "name", "") != "anthropic":
        return messages
    return [
        {**message, "role": "user"} if message.get("role") == "system" else message
        for message in messages
    ]


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
