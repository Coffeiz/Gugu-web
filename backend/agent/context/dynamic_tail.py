"""消息时间格式化与动态 reminder 消息信封。

消息时间标签随用户消息正文一起进入上下文；只有实时当前时间等动态 reminder
仍由 provider-only 尾部注入。session_snapshot 只负责固定 snapshot 与 baseline。
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.core.tz import LOCAL_TZ, fmt_local, resolve_tz


def _as_tz(user_tz):
    """容忍 IANA 名称形式的时区参数；tzinfo 原样通过。"""
    if isinstance(user_tz, str):
        return resolve_tz(user_tz)
    return user_tz or LOCAL_TZ


def current_time_text(user_tz=None) -> str:
    """生成当前墙钟日期与时分文本。"""
    current = datetime.now(_as_tz(user_tz))
    return _format_time(current)


def _format_time(value: datetime) -> str:
    """按统一格式输出本地日期、星期与时分。"""
    weekday = "一二三四五六日"[value.weekday()]
    return f"{value:%Y-%m-%d}（星期{weekday}）{value:%H:%M}"


def current_date_text(user_tz=None) -> str:
    """生成只按日期变化的当前日期文本，不包含时分秒。"""
    current = datetime.now(_as_tz(user_tz))
    return f"{current:%Y-%m-%d}（星期{'一二三四五六日'[current.weekday()]}）"


def reminder_message(content: str) -> dict:
    """生成不带观测元数据的 reminder 消息。"""
    return {"role": "user", "content": f"[system-reminder]\n{content}\n[/system-reminder]"}


def message_time_reminder(sent_at, user_tz=None) -> dict | None:
    """按用户时区格式化消息时间，供 user 消息正文包装使用。"""
    text = message_time_text(sent_at, user_tz)
    return reminder_message(text) if text else None


def message_time_text(sent_at, user_tz=None) -> str | None:
    """按用户时区格式化消息发生时间，供历史消息和 RAG 来源共同使用。"""
    if sent_at is None:
        return None
    return f"消息时间：{fmt_local(sent_at, tz=_as_tz(user_tz))}"


def message_timestamp(message):
    """取消息发生时间：优先平台发送时间，再取入库时间，最后兼容旧 sent_at。"""
    def _value(name):
        return message.get(name) if isinstance(message, dict) else getattr(message, name, None)

    platform_sent_ms = _value("im_platform_sent_ms") or _value("platform_sent_ms")
    if isinstance(platform_sent_ms, (int, float)) and platform_sent_ms > 0:
        return datetime.fromtimestamp(platform_sent_ms / 1000, timezone.utc)
    received_ms = _value("im_event_received_ms") or _value("event_received_ms")
    if isinstance(received_ms, (int, float)) and received_ms > 0:
        return datetime.fromtimestamp(received_ms / 1000, timezone.utc)
    return (
        _value("created_at")
        or _value("sent_at")
    )


def inline_message_time(content, message_time) -> str | list | dict:
    """把消息时间（若可用）和正文标签放进同一条 user 消息。"""
    value = message_time.get("content") if isinstance(message_time, dict) else message_time
    value = str(value or "").strip()
    if value.startswith("[system-reminder]") and value.endswith("[/system-reminder]"):
        value = value[len("[system-reminder]"): -len("[/system-reminder]")].strip()
    if value.startswith("消息时间："):
        value = value[len("消息时间："):].strip()
    prefix = f"【消息时间】{value}" if value else ""

    def _already_wrapped(text: str) -> bool:
        return (
            "【群消息】" in text and "【消息正文】" in text
        ) or (
            text.lstrip().startswith("【消息时间】") and "【消息正文】" in text
        )

    def _header(text: str) -> str:
        if not prefix:
            return text
        return f"{prefix}\n{text}" if text else prefix

    if isinstance(content, str):
        if _already_wrapped(content):
            return _header(content)
        body_header = "【消息正文】\n"
        return f"{prefix}\n{body_header}{content}" if prefix else f"{body_header}{content}"
    if isinstance(content, list):
        first_text = next((
            str(block.get("text") or "") for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ), "")
        if _already_wrapped(first_text):
            return ([{"type": "text", "text": f"{prefix}\n"}] if prefix else []) + content
        header = f"{prefix}\n【消息正文】\n" if prefix else "【消息正文】\n"
        return [{"type": "text", "text": header}, *content]
    if isinstance(content, dict):
        header = f"{prefix}\n【消息正文】\n" if prefix else "【消息正文】\n"
        return [{"type": "text", "text": header}, content]
    body_header = f"{prefix}\n【消息正文】\n" if prefix else "【消息正文】\n"
    return f"{body_header}{content or ''}"


def time_message(user_tz=None) -> dict:
    """为没有用户消息的定时执行生成当前时间尾部提醒。"""
    return reminder_message(
        f"仅供时间参考，不属于用户正文，请勿复述。\n当前时间：{current_time_text(user_tz)}"
    )
