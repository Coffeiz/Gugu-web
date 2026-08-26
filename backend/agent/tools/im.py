"""IM 互动技能：react——咕咕按内容给用户刚发的那条消息加一个贴切的表情回应。

仅在 IM 对话（目前飞书）里可用：上下文（平台/message_id/channel_id）由 worker 经
agent.im.imctx 透传。web 对话没有「可回应的消息」，调用时直接返回不可用。
"""
from agent.tools.base import BaseSkill, Tool

# 情绪 → 飞书 emoji_type（飞书表情 key）。挑了较稳的几个；个别若飞书不认会在日志报
# `reaction 失败 emoji=...`，照着飞书表情列表改这里即可。
_MOOD_EMOJI = {
    "agree": "THUMBSUP",     # 👍 认同、赞同、说得对
    "good": "THUMBSUP",      # 👍 好/不错
    "love": "HEART",         # ❤️ 喜欢、感动、贴心
    "thanks": "THANKS",      # 🙏 谢谢
    "laugh": "LAUGH",        # 😂 好笑、有梗
    "wow": "WOW",            # 😮 惊讶、厉害
    "sad": "CRY",            # 😢 难过、可惜、心疼
    "thinking": "THINKING",  # 🤔 在想、有疑问
    "celebrate": "PARTY",    # 🎉 庆祝、达成、搞定
    "ok": "OK",              # 🆗 好的、收到
    "done": "DONE",          # ✅ 完成、搞定
}


async def _react(db, user_id, args: dict):
    from agent.im import imctx
    ctx = imctx.get_im()
    if not ctx or ctx.get("platform") != "feishu":
        return {"ok": False, "message": "当前不在飞书对话里，没法加表情回应（仅 IM 可用）。"}

    mood = (args.get("mood") or "").strip().lower()
    emoji = _MOOD_EMOJI.get(mood)
    if not emoji:
        return {"ok": False, "message": f"不认识的 mood「{mood}」，可选：{', '.join(_MOOD_EMOJI)}。"}

    from agent.gateway import feishu
    ok = await feishu.react(ctx.get("channel_id"), ctx.get("message_id"), emoji)
    if ok:
        imctx.mark_reacted()
        return {"ok": True, "message": f"已给用户这条消息加了「{mood}」表情。"}
    return {"ok": False, "message": "加表情没成功（可能缺 im:message_reaction 权限），跳过即可，别重试。"}


class IMSkill(BaseSkill):
    name = "im"
    tools = [
        Tool(
            name="react", label="表情回应",
            description="仅飞书 IM 可用；给用户消息添加一次合适的表情回应。",
            input_schema={
                "type": "object",
                "properties": {
                    "mood": {
                        "type": "string",
                        "enum": ["agree", "good", "love", "thanks", "laugh",
                                 "wow", "sad", "thinking", "celebrate", "ok", "done"],
                        "description": "表情情绪",
                    },
                },
                "required": ["mood"],
            },
            handler=_react,
        ),
    ]


IMSkill().register()
