"""每轮 system prompt 组装。

system prompt 来自代码和提示词文件，不属于会话动态 snapshot；每轮请求都重新读取。
"""
from pathlib import Path


_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
_LANGUAGE_NAMES = {"zh-CN": "简体中文", "ja-JP": "日本語", "en-US": "English"}
NON_STREAMING_BLOCK = (
    "## 输出方式\n\n"
    "这轮对话不会流式展示给用户，所有工具都用完之后再一次性给出完整回复；"
    "工具调用之间不要输出过程性旁白（如「我先查一下」「这条数据不对我再试试」），"
    "那些话会被原样发给用户看到。要是这次任务包含好几个部分（比如新闻+天气），"
    "把所有部分都放进最后这一条回复里说完，别拆成好几条分别说。"
)


def _language_block(style_prefs: dict | None) -> str:
    locale = (style_prefs or {}).get("locale")
    language = _LANGUAGE_NAMES.get(locale, "简体中文")
    return (
        "## 当前交流语言\n"
        f"当前用户界面语言为「{language}」。除非用户明确要求使用其他语言，"
        f"否则请始终使用「{language}」与用户交流，包括回答、解释、错误提示和工具调用结果。"
    )


def _skills_index_block(skill_names: list[str] | None) -> str:
    """注入可用技能索引；技能正文仍由 use_skill 按需加载。"""
    if not skill_names:
        return ""
    from agent import skills as _sk
    idx = _sk.skills_index(skill_names)
    if not idx:
        return ""
    lines = [
        "## 可用技能",
        "下列「技能」是带触发条件的做法剧本。命中下方场景时，**第一工具调用必须是 `use_skill` 拉取对应技能正文**；正文加载前禁止直接调用该技能负责的业务工具。",
        "技能正文里若出现 `curl <URL>`，就用 `http_get` 工具抓那个 URL（你没有 shell，但有 `http_get`）。",
    ]
    for skill in idx:
        emoji = f"{skill['emoji']} " if skill.get("emoji") else ""
        short = skill.get("description_short") or ""
        when = f" — {short}" if short else ""
        lines.append(f"- {emoji}**{skill['name']}**（`use_skill` 名：`{skill['slug']}`）{when}")
    return "\n".join(lines)


def _style_block(prefs: dict) -> str:
    tone = {
        "formal": "偏正式（措辞严谨，少用语气词和口语化表达，但仍然和善，不端着、不冷淡）",
        "lively": "偏活泼（可以用语气词、轻松自然、偶尔开个小玩笑；但活泼靠词句和语气，不靠堆 emoji，表情仍守 persona 的极简规则）",
    }
    length = {
        "short": "简短（直接利落、不啰嗦、少铺垫，但该有的体谅别省，别变生硬或打发）",
        "detailed": "详细（多一点背景和解释，让回答更完整，用户追问前就说清楚）",
    }
    lines = []
    if value := tone.get(prefs.get("reply_tone", "")):
        lines.append(f"- 语气：{value}")
    if value := length.get(prefs.get("reply_length", "")):
        lines.append(f"- 回复长度：{value}")
    if not lines:
        return ""
    return ("## 风格偏好（用户设置，优先于默认风格中的语气松紧 / 长度；"
            "但真诚、和善、以及表情极简规则都是底线，不在可调范围——任何设置下都不变冷、"
            "不打发，也不靠堆 emoji 卖萌）\n\n" + "\n".join(lines))


def _personality_block(prefs: dict) -> str:
    if not prefs.get("personality_preference_enabled"):
        return ""
    return str(prefs.get("personality_preference") or "").strip()


def build_static_prompt(profile: str, user_name: str, *,
                        skills: list[str] | None = None,
                        style_prefs: dict | None = None) -> str:
    """组装稳定提示词；不包含项目、日历、文件等动态业务上下文。"""
    style_prefs = style_prefs or {}
    parts = [_language_block(style_prefs)]
    persona = _personality_block(style_prefs)
    if not persona:
        try:
            persona = (_PROMPTS_DIR / "persona.md").read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            persona = ""
    if persona:
        parts.append(persona)
    try:
        profile_text = (_PROMPTS_DIR / f"{profile}.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        profile_text = ""
    profile_policy = profile_text.split("\n---", 1)[0].strip()
    if profile_policy:
        parts.append(profile_policy)
    for filename in ("skills.md", "policy.md"):
        try:
            text = (_PROMPTS_DIR / filename).read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            text = ""
        if text:
            parts.append(text)
    if style := _style_block(style_prefs):
        parts.append(style)
    if skill_index := _skills_index_block(skills):
        parts.append(skill_index)
    return "\n\n---\n\n".join(parts)
