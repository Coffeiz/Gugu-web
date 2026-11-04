"""共享 Agent Runtime 使用的 IM 行为者上下文。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, List, Optional

from sqlalchemy.exc import SQLAlchemyError

from app.core.redaction import diag_log, redact


@dataclass(frozen=True)
class ActorContext:
    """身份、会话范围和工具权限的显式快照。

    ``owner_user_id`` 是 Bot 所属的 Gugu 账号；``platform_user_id`` 是当前
    发言人。两者必须保持分离，不能因为二者出现在同一个请求里就视为同一身份。

    ``speaker_roles`` 记录本轮每一位发言人的角色快照：一个批次可能包含多位
    发言人（群聊里咕咕回复期间又来消息），混合权限时整轮按**最弱**权限执行；
    只有每位发言人都确认是 owner 时才保留 owner 权限。
    ``verified_owner`` 只代表平台身份与 Bot 绑定匹配，不会提升工具权限角色。
    """

    owner_user_id: Any
    platform: str
    platform_user_id: Optional[str] = None
    platform_user_name: Optional[str] = None
    role: Optional[str] = None
    chat_type: Optional[str] = None
    chat_id: Optional[str] = None
    allowed_tool_names: Optional[List[str]] = None
    speaker_roles: Optional[List[dict]] = None
    owner_mention_authorized: bool = False
    verified_owner: bool = False

    @property
    def is_im(self) -> bool:
        return self.platform in {"feishu", "qq", "wechat", "telegram"}

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"

    @property
    def is_restricted(self) -> bool:
        return self.role in {"member", "unknown"}


# 角色权限由强到弱；合并一批多人的消息时取最弱的那一档。
_ROLE_RANK = {"owner": 0, "member": 1, "unknown": 2}
_UNRANKED_ROLE_RANK = 3


def _role_rank(role: Optional[str]) -> int:
    return _ROLE_RANK.get(role or "unknown", _UNRANKED_ROLE_RANK)


def _weaker_role(left: Optional[str], right: Optional[str]) -> Optional[str]:
    """取权限更弱的角色；身份未确认（unknown）比群成员更保守。"""
    return left if _role_rank(left) >= _role_rank(right) else right


def _intersect_tool_names(
    left: Optional[List[str]], right: Optional[List[str]]
) -> Optional[List[str]]:
    """取两个工具白名单的交集；None 表示「不限制」，因此不构成约束。"""
    if left is None and right is None:
        return None
    if left is None:
        return list(right)
    if right is None:
        return list(left)
    allowed = set(right)
    return [name for name in left if name in allowed]


def _batch_speakers(payload: dict) -> list[dict]:
    """从合并后的批次里取出去重后的发言人（按平台 ID 排序，结果与到达顺序无关）。"""
    segments = payload.get("_speaker_segments") or []
    seen: dict[str, dict] = {}
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        speaker_id = str(segment.get("platform_user_id") or "")
        if speaker_id in seen:
            continue
        seen[speaker_id] = {
            "platform_user_id": speaker_id,
            "platform_user_name": segment.get("platform_user_name") or "",
        }
    return [seen[key] for key in sorted(seen)]


async def _resolve_batch_access(resolver, platform, chat_type, channel_id, owner_user_id,
                                speakers, role, allowed_tool_names):
    """逐位解析批次身份，并返回权限交集。"""
    from agent.im.permissions import DEFAULT_GROUP_TOOLS, ImAccess

    resolved_speakers = []
    all_speakers_are_owner = bool(speakers)
    for speaker in speakers:
        if speaker["platform_user_id"]:
            access = await resolver(
                platform, chat_type, channel_id, owner_user_id, speaker["platform_user_id"],
            )
        else:
            access = ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
        speaker_role = access.role or "unknown"
        all_speakers_are_owner = all_speakers_are_owner and speaker_role == "owner"
        resolved_speakers.append((speaker, access, speaker_role))

    speaker_roles = []
    for speaker, access, speaker_role in resolved_speakers:
        speaker_tools = access.allowed_tool_names
        if chat_type == "group" and speaker_role == "owner" and not all_speakers_are_owner:
            # 只有整批发言人都经平台身份确认是 owner 才保留 owner 权限。
            speaker_role = "member"
            speaker_tools = (
                getattr(access, "group_member_tool_names", None)
                or list(DEFAULT_GROUP_TOOLS)
            )
        speaker_roles.append({**speaker, "role": speaker_role})
        role = _weaker_role(role, speaker_role)
        allowed_tool_names = _intersect_tool_names(allowed_tool_names, speaker_tools)
    return role, allowed_tool_names, speaker_roles


def _is_single_owner_bot_mention(payload: dict, platform_user_id: str, chat_type: str) -> bool:
    """仅接受网关标记的当前 Bot mention，且本 run 只能包含该条消息。"""
    if (chat_type != "group" or payload.get("bot_mentioned") is not True
            or payload.get("mentions_other_bot") is True or not platform_user_id):
        return False
    messages = payload.get("_batch_messages")
    if messages is None:
        return True
    if not isinstance(messages, list) or len(messages) != 1:
        return False
    message = messages[0]
    return bool(
        isinstance(message, dict)
        and str(message.get("platform_user_id") or "") == str(platform_user_id)
        and message.get("chat_type") == "group"
        and message.get("bot_mentioned") is True
        and message.get("mentions_other_bot") is not True
    )


class ActorResolver:
    """IM 身份解析唯一入口，返回一次请求不可变的 ActorContext。"""

    def __init__(self, access_resolver: Optional[Callable[..., Awaitable[Any]]] = None):
        self._access_resolver = access_resolver

    async def resolve(self, platform_message, payload: dict, owner_user_id: Any) -> ActorContext:
        platform = platform_message.platform or "worker"
        platform_user_id = platform_message.sender.id or payload.get("platform_user_id")
        chat_type = platform_message.chat.type or payload.get("chat_type")
        role = None
        allowed_tool_names = None
        speaker_roles: Optional[List[dict]] = None
        owner_mention_authorized = False
        verified_owner = False
        if platform in {"feishu", "qq", "wechat", "telegram"}:
            try:
                resolver = self._access_resolver
                if resolver is None:
                    from agent.im.permissions import resolve_access
                    resolver = resolve_access
                channel_id = payload.get("channel_id") or platform_message.bot_id
                access = await resolver(
                    platform,
                    chat_type,
                    channel_id,
                    owner_user_id,
                    platform_user_id or "",
                )
                role = access.role or "unknown"
                verified_owner = role == "owner"
                allowed_tool_names = access.allowed_tool_names
                if chat_type == "group" and role == "owner":
                    owner_mention_authorized = _is_single_owner_bot_mention(
                        payload, str(platform_user_id or ""), str(chat_type or "")
                    )
                if role == "unknown" and allowed_tool_names is None:
                    allowed_tool_names = ["xng_search", "http_get", "similar_image_search", "read_file", "send_file"]

                # 一个批次可能有多位发言人（咕咕回复期间群里又来消息）。整轮只回一次，
                # 也就只有一个权限主体：按**最弱**执行——成员消息不会借主人权限调用
                # 私密工具或读主人私人记忆。按平台 ID 排序后合并，结果与到达顺序无关。
                speakers = _batch_speakers(payload)
                if len(speakers) > 1:
                    role, allowed_tool_names, speaker_roles = await _resolve_batch_access(
                        resolver, platform, chat_type, channel_id, owner_user_id,
                        speakers, role, allowed_tool_names,
                    )
                    # 只有每位批内发言人都解析为 owner，才允许使用 owner 级群权限。
                    verified_owner = role == "owner" and all(
                        speaker["role"] == "owner" for speaker in speaker_roles
                    )
                elif speakers and speakers[0]["platform_user_id"] != str(platform_user_id or ""):
                    role, allowed_tool_names, speaker_roles = await _resolve_batch_access(
                        resolver, platform, chat_type, channel_id, owner_user_id,
                        speakers, role, allowed_tool_names,
                    )
                    verified_owner = False
                elif speakers and chat_type == "group" and role == "owner":
                    # 单发言人批次按平台身份确认“整批只有 owner 的消息”，无需额外 @ Bot。
                    verified_owner = True
                elif chat_type == "group" and role == "owner" and not owner_mention_authorized:
                    # 没有批次身份事实时，普通群消息仍需单条 @ Bot 才能使用 owner 权限。
                    from agent.im.permissions import DEFAULT_GROUP_TOOLS

                    role = "member"
                    allowed_tool_names = (
                        getattr(access, "group_member_tool_names", None)
                        or list(DEFAULT_GROUP_TOOLS)
                    )
            except (ValueError, TypeError, SQLAlchemyError) as exc:
                diag_log("im.actor_resolver", exc)
                print(
                    f"[im] {platform} 身份权限解析失败，按最小权限继续: {redact(type(exc).__name__)}",
                    flush=True,
                )
                role = "unknown"
                allowed_tool_names = ["xng_search", "http_get", "similar_image_search", "read_file", "send_file"]
                verified_owner = False
        actor = ActorContext(
            owner_user_id=owner_user_id,
            platform=platform,
            platform_user_id=platform_user_id,
            platform_user_name=payload.get("platform_user_name") or platform_message.sender.name,
            role=role,
            chat_type=chat_type,
            chat_id=platform_message.chat.id if chat_type == "group" else None,
            allowed_tool_names=allowed_tool_names,
            speaker_roles=speaker_roles,
            owner_mention_authorized=owner_mention_authorized,
            verified_owner=verified_owner,
        )
        return actor
