"""System prompt 组装层。

注入顺序：persona.md（咕咕人格，始终最先、所有 profile 共享）→ profile 模板
（default.md，含实时数据与记忆占位符）。persona 定义"咕咕是谁、怎么相处、何时
主动"，模板提供"此刻的项目/日程/记忆"。
"""
from datetime import datetime, timedelta
from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


# 项目状态英文枚举 → 中文（注入上下文时翻好，免得咕咕照搬英文说给用户）
_STATUS_ZH = {"pending": "待开始", "active": "进行中", "done": "已完成"}


def _files_block(fo: dict | None, proj_names: dict | None = None) -> str:
    """文件/文件夹概览文本（紧凑）。"""
    if not fo or (not fo.get("total") and not fo.get("trash")):
        return "暂无文件"
    _SP = {"personal": "个人", "project": "项目", "asset": "素材", "mind": "思维"}
    pn = proj_names or {}
    def _proj(pid):   # 项目位置用名字，不用编号（编号只在 [id=] 里供调工具）
        return f"项目「{pn[pid]}」" if pid in pn else f"项目#{pid}"
    by_space = fo.get("by_space") or {}
    space_str = "、".join(f"{_SP.get(k, k)} {v}" for k, v in by_space.items()) or "无"
    trash_n = fo.get("trash") or 0
    # 各空间真值 + 回收站数每轮注入：用户问「几个文件 / 删了几个 / 回收站还有吗」直接据此答，不许瞎报
    lines = [f"共 {fo.get('total', 0)} 个活跃文件（各空间：{space_str}）；回收站 {trash_n} 个。"]
    folders = fo.get("folders") or []
    if folders:
        lines.append("文件夹：" + "、".join(
            f"{x['name']}" + (f"({_proj(x['project_id'])})" if x.get("project_id") else "")
            for x in folders
        ))
    files = fo.get("files") or []
    if files:
        lines.append(f"最近文件（最多 {len(files)} 个）：")
        for f in files:
            loc = f.get("folder") or (_proj(f["project_id"]) if f.get("project_id") else f.get("space", ""))
            lines.append(f"- {f['name']}（{loc}）")
    return "\n".join(lines)


def _skills_index_block(skill_names: list[str] | None) -> str:
    """注入「可用技能」索引：每个 prompt skill 一行 name + 何时用。模型据此用 use_skill 按需拉正文。"""
    if not skill_names:
        return ""
    from agent import skills as _sk
    idx = _sk.skills_index(skill_names)
    if not idx:
        return ""
    lines = ["## 可用技能",
             "下列「技能」是带触发条件的做法剧本。命中下方场景时，**先调 `use_skill` 拉取该技能详细步骤再照做**，别凭空猜。",
             "技能正文里若出现 `curl <URL>`，就用 `http_get` 工具抓那个 URL（你没有 shell，但有 `http_get`）。"]
    for s in idx:
        emoji = f"{s['emoji']} " if s.get("emoji") else ""
        when = f" — {s['when']}" if s.get("when") else ""
        lines.append(f"- {emoji}**{s['name']}**（`use_skill` 名：`{s['slug']}`）{when}")
    return "\n".join(lines)


def build(profile: str, user_name: str, projects: list, events: list,
          memory: dict | None = None, files: dict | None = None,
          skills: list[str] | None = None,
          style_prefs: dict | None = None,
          source: str | None = None, im_channels: dict | None = None) -> str:
    memory = memory or {}
    _now = datetime.now()
    today = _now.strftime("%Y-%m-%d")
    # 当前完整时刻（含星期、时分），让咕咕知道"现在几点、星期几"，能答时间、按时段问候、排期
    _wd = "一二三四五六日"[_now.weekday()]
    now_str = f"{today}（星期{_wd}）{_now.strftime('%H:%M')}"
    # 深夜（0-4 点）：用户主观上还没睡着、仍认为是"昨天"，「明天」=日历今天，「今天」=日历昨天
    if _now.hour < 4:
        now_str += "，深夜未眠——以日出为一天的分界：用户口中的「今天」指尚未结束的这个主观白天（日历昨天），「明天」指日出后的那天（日历今天），涉及日期时请按此理解"

    proj_lines = []
    for p in projects[:25]:
        deadline = f"截止 {p.deadline}" if p.deadline else "无截止"
        done_cnt  = sum(1 for s in p.stages if s.get("done"))
        total_cnt = len(p.stages)
        prog = f"{done_cnt}/{total_cnt}阶段" if total_cnt else "无阶段"
        proj_lines.append(f"- [id={p.id}] [{_STATUS_ZH.get(p.status, p.status)}] {p.name}（{prog}，{deadline}，客户：{p.client or '无'}）")

    ev_lines   = [f"- {ev.date} {ev.title}" for ev in events[:10]]
    proj_block = "\n".join(proj_lines) if proj_lines else "暂无项目"
    ev_block   = "\n".join(ev_lines)   if ev_lines   else "暂无近期事件"

    prompt_file = _PROMPTS_DIR / f"{profile}.md"
    try:
        template = prompt_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        template = "今天是 {today}。\n\n## 项目\n{projects}\n\n## 日历\n{calendar}"

    replacements = {
        "{today}":    today,
        "{now}":      now_str,
        "{name}":     user_name,
        "{projects}": proj_block,
        "{calendar}": ev_block,
        "{files}":    _files_block(files, {p.id: p.name for p in projects}),
    }
    result = template
    for key, val in replacements.items():
        result = result.replace(key, val)
    result = result.strip()

    # persona 最先加载，所有 profile 共享
    try:
        persona = (_PROMPTS_DIR / "persona.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        persona = ""

    # 工具使用准则（Execution Policy）：行为层指引，紧跟人格、优先级高，所有 profile 共享
    try:
        skills_policy = (_PROMPTS_DIR / "skills.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        skills_policy = ""

    # 内容政策（红线）：独立维护、所有 profile 共享
    try:
        content_policy = (_PROMPTS_DIR / "policy.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        content_policy = ""

    # 顺序：人格 → 工具准则 → 内容政策 → 风格偏好 → 技能索引 → 记忆 → 当前状态
    sections = []
    if persona:
        sections.append(persona)
    if skills_policy:
        sections.append(skills_policy)
    if content_policy:
        sections.append(content_policy)
    style_block = _style_block(style_prefs or {})
    if style_block:
        sections.append(style_block)
    skills_block = _skills_index_block(skills)
    if skills_block:
        sections.append(skills_block)
    mem_block = _memory_block(memory)
    if mem_block:
        sections.append(mem_block)
    src_block = _source_block(source, im_channels)
    if src_block:
        sections.append(src_block)
    sections.append(result)
    return "\n\n---\n\n".join(sections)


_SOURCE_NAME = {"qqbot": "QQ", "feishu": "飞书", "web": "网页"}


def _source_block(source: str | None, im_channels: dict | None) -> str:
    """注入「当前对话来源 + 已连通知渠道」——根治『用户正用 QQ 聊天，咕咕却说 QQ 没绑、让扫码』。
    当前来源平台必然可达（用户正用它说话），强制标记已连，别再让 TA 绑。"""
    name = _SOURCE_NAME.get(source or "")
    ch = im_channels or {}
    qq_on = bool(ch.get("qq")) or source == "qqbot"
    fs_on = bool(ch.get("feishu")) or source == "feishu"
    lines = []
    if name:
        lines.append(f"本次对话来自：**{name}**。")
    lines.append(f"主动通知渠道：站内通知（始终可用）；QQ {'已连 ✅' if qq_on else '未连 ❌'}；"
                 f"飞书 {'已连 ✅' if fs_on else '未连 ❌'}。")
    if source in ("qqbot", "feishu"):
        lines.append(f"- 用户**正用 {name} 跟你说话** → {name} 必然已连接：设提醒/通知走 {name} 渠道时"
                     f"**无需再绑定、绝不让 TA 扫码**（说『没绑』就错了）。")
    lines.append("- 设 qq/feishu 通知渠道前看这里：已连(✅)的直接用；只有未连(❌)才提示用户去「设置 → 连接 IM」绑定。")
    return "## 当前对话来源 / 通知渠道\n\n" + "\n".join(lines)


def _style_block(prefs: dict) -> str:
    """用户风格偏好，全为默认值时返回空串（不注入，省 token）。"""
    TONE = {
        "formal": "偏正式（措辞严谨，少用语气词和口语化表达，但仍然和善，不端着、不冷淡）",
        "lively": "偏活泼（可以用语气词、轻松自然、偶尔开个小玩笑；但活泼靠词句和语气，不靠堆 emoji，表情仍守 persona 的极简规则）",
    }
    LENGTH = {
        "short":    "简短（直接利落、不啰嗦、少铺垫，但该有的体谅别省，别变生硬或打发）",
        "detailed": "详细（多一点背景和解释，让回答更完整，用户追问前就说清楚）",
    }
    # emoji 不开放给用户选：表情风格由 persona 统一管（极简、只标内容类别），稳定优于可调。
    lines = []
    if t := TONE.get(prefs.get("reply_tone", "")):
        lines.append(f"- 语气：{t}")
    if l := LENGTH.get(prefs.get("reply_length", "")):
        lines.append(f"- 回复长度：{l}")
    if not lines:
        return ""
    return ("## 风格偏好（用户设置，优先于默认风格中的语气松紧 / 长度；"
            "但真诚、和善、以及表情极简规则都是底线，不在可调范围——任何设置下都不变冷、"
            "不打发，也不靠堆 emoji 卖萌）\n\n" + "\n".join(lines))


def _memory_block(memory: dict) -> str:
    """咕咕对用户的记忆。全空时也注入一句明确声明——给"我不知道"一个锚点，防模型
    在空白处脑补共同经历（伪个性化）；不再返回空串。顺序：稳定事实 → 长期记忆 → 最近。"""
    summary = (memory.get("summary") or "").strip()
    facts   = (memory.get("facts") or "").strip()
    longterm = (memory.get("memory") or "").strip()
    daily   = (memory.get("daily") or "").strip()
    parts = []
    if summary:
        parts.append("## TA 最近的状态\n\n" + summary)
    if facts:
        parts.append("## 我对你的了解\n\n" + facts)
    if longterm:
        parts.append("## 长期记忆\n\n" + longterm)
    if daily:
        parts.append("## 最近的记忆\n\n" + daily)
    if not parts:
        return ("## 关于这位用户的记忆\n\n"
                "（暂无任何长期记忆——你对 TA 还不了解。别假装记得任何共同经历或偏好，"
                "需要了解就直接问。）")
    return "\n\n".join(parts)
