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
    """注入内置技能索引；传空列表才显式关闭，正文仍按需加载。"""
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
        "natural": (
            "自然。使用清晰、亲切、自然的表达，可以适度口语化，但不要刻意卖萌、"
            "堆叠语气词或玩笑；保持真诚、克制，不冷淡，也不过度热情。"
        ),
        "formal": (
            "正式。必须使用严谨、克制、完整的表达，优先使用书面语，减少口语化表达、"
            "语气词和玩笑；面对问题先给明确结论，再补充必要依据。"
        ),
        "lively": (
            "活泼。使用轻松、积极、自然的表达，可以适度使用语气词、比喻或轻松措辞；"
            "活泼必须建立在清晰和准确之上，不连续堆叠语气词，不靠玩笑、夸张反应或 emoji 制造活泼感。"
        ),
    }
    length = {
        "medium": (
            "适中。根据任务复杂度组织内容；简单问题直接回答，搜索、对比、排查类任务"
            "补充必要依据和结果；可以使用列表、表格或多段内容，但不重复或扩展无关信息。"
        ),
        "short": (
            "简短。先给出直接结论，再提供完成当前任务所必需的依据或结果；"
            "删除重复解释、泛泛背景、无关扩展和过程性流水账。搜索、对比、排查和多项任务"
            "可以使用列表、表格或多段内容，不限制段落数量；不得为了简短而遗漏关键条件、风险、失败项或下一步操作。"
        ),
        "detailed": (
            "详细。除结论外，补充必要的原因、过程、影响、注意事项和可执行步骤；"
            "对复杂任务完整覆盖各个方面，必要时使用列表、表格或示例；不得省略关键细节，"
            "但仍只围绕用户问题展开。"
        ),
    }
    lines = []
    if value := tone.get(prefs.get("reply_tone") or "natural"):
        lines.append(f"- 语气：{value}")
    if value := length.get(prefs.get("reply_length") or "medium"):
        lines.append(f"- 回复长度：{value}")
    return ("## 用户回复风格要求\n\n"
            "除非用户当前消息明确要求其他表达方式，否则必须遵守以下风格设置。"
            "这些设置只影响表达方式，不得改变事实、权限、安全规则，也不得省略完成任务所必需的信息。\n\n"
            + "\n".join(lines))


def _personality_block(prefs: dict) -> str:
    if not prefs.get("personality_preference_enabled"):
        return ""
    return str(prefs.get("personality_preference") or "").strip()


def append_shell_prompt(system_prompt: str, *, enabled: bool) -> str:
    """在 Shell 工具已注册时追加稳定的 Shell 安全协议。"""
    if not enabled or "# Shell 安全协议" in system_prompt:
        return system_prompt
    try:
        shell_prompt = (_PROMPTS_DIR / "shell.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        shell_prompt = ""
    if not shell_prompt:
        return system_prompt
    return "\n\n---\n\n".join(part for part in (system_prompt, shell_prompt) if part)


def build_static_prompt(prompt_name: str, user_name: str, *,
                        skills: list[str] | None = None,
                        style_prefs: dict | None = None,
                        current_date: str | None = None) -> str:
    """组装稳定提示词；不包含项目、日历、文件等动态业务上下文。"""
    style_prefs = style_prefs or {}
    try:
        prompt_text = (_PROMPTS_DIR / f"{prompt_name}.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        prompt_text = ""
    if "{today}" in prompt_text:
        if current_date is None:
            from agent.context.dynamic_tail import current_date_text
            current_date = current_date_text()
        prompt_text = prompt_text.replace("{today}", current_date)
    prompt_policy = prompt_text.split("\n---", 1)[0].strip()
    parts = [prompt_policy] if prompt_policy else []
    parts.append(_language_block(style_prefs))
    persona = _personality_block(style_prefs)
    if not persona:
        try:
            persona = (_PROMPTS_DIR / "persona.md").read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            persona = ""
    if persona:
        parts.append(persona)
    for filename in ("skills.md", "policy.md", "retrieval.md"):
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
