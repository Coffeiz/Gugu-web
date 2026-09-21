"""每轮/每消息的 provider-only 尾部注入：时间提醒与 reminder 消息信封。

这些消息不进 canonical history、不参与跨轮缓存前缀（dynamic tail 每轮变化），
只在 provider 边界拼接。session_snapshot 只负责固定 snapshot 与 baseline，
两者不应互相依赖。
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.core.tz import LOCAL_TZ, resolve_tz


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


def current_message_time_reminder(sent_at, user_tz=None) -> dict | None:
    """把当前用户消息的发送时间作为当前时间，放在该消息正文之前。"""
    if sent_at is None:
        return None
    if sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=timezone.utc)
    local_time = sent_at.astimezone(_as_tz(user_tz))
    return reminder_message(f"当前时间：{_format_time(local_time)}")


def current_date_text(user_tz=None) -> str:
    """生成只按日期变化的当前日期文本，不包含时分秒。"""
    current = datetime.now(_as_tz(user_tz))
    return f"{current:%Y-%m-%d}（星期{'一二三四五六日'[current.weekday()]}）"


def reminder_message(content: str) -> dict:
    """生成不带观测元数据的 reminder 消息。"""
    return {"role": "user", "content": f"[system-reminder]\n{content}\n[/system-reminder]"}


def message_time_reminder(sent_at, user_tz=None) -> dict | None:
    """把历史用户消息时间作为不可变的独立 reminder，按用户时区格式化。"""
    if sent_at is None:
        return None
    if sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=timezone.utc)
    local_time = sent_at.astimezone(_as_tz(user_tz))
    return reminder_message(local_time.strftime("消息时间：%Y-%m-%d %H:%M"))


def time_message(user_tz=None) -> dict:
    """为没有用户消息的定时执行生成当前时间尾部提醒。"""
    return reminder_message(
        f"仅供时间参考，不属于用户正文，请勿复述。\n当前时间：{current_time_text(user_tz)}"
    )
