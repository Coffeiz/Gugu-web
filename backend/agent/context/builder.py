"""System prompt 组装层。

注入顺序：persona.md（咕咕人格，始终最先、所有 profile 共享）→ profile 模板
（default.md，含实时数据与记忆占位符）。persona 定义"咕咕是谁、怎么相处、何时
主动"，模板提供"此刻的项目/日程/记忆"。
"""
from datetime import datetime
from pathlib import Path

from app.core.tz import LOCAL_TZ

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
            f"{x.get('path', x['name'])}（文件数 {x.get('file_count', 0)}）"
            + (f"({_proj(x['project_id'])})" if x.get("project_id") else "")
            for x in folders
        ))
    files = fo.get("files") or []
    if files:
        lines.append(f"最近文件样本（最多 {len(files)} 个；这里只是最近更新的截断列表，不代表其它文件夹为空）：")
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


def build_split(profile: str, user_name: str, projects: list, events: list,
                memory: dict | None = None, files: dict | None = None,
                skills: list[str] | None = None,
                style_prefs: dict | None = None,
                source: str | None = None, im_channels: dict | None = None,
                user_msg: str = "", non_streaming: bool = False,
                include_projects: bool = True, include_calendar: bool = True,
                include_files: bool = True, include_memory: bool = True,
                user_tz=None, im_message_format: str | None = None) -> tuple[str, str, str]:
    """将 system prompt 拆分为静态部分和动态部分。

    静态部分（完全不变）：人格/profile policy/政策/工具定义/风格/技能索引
    动态部分（可能变化）：记忆/项目/文件/时间/消息格式

    返回 (static_text, dynamic_text, now_str)，调用方将静态部分放在 system，
    动态部分放在 messages[0] 作为上下文注入，时间作为最后的独立消息。

    这样 system prefix 跨 call 完全一致，MiniMax 前缀匹配缓存能命中。
    """
    memory = memory if (include_memory and memory) else {}
    _now = datetime.now(user_tz or LOCAL_TZ)
    today = _now.strftime("%Y-%m-%d")
    _wd = "一二三四五六日"[_now.weekday()]
    now_str = f"{today}（星期{_wd}）{_now.strftime('%H:%M')}"
    if _now.hour < 4:
        now_str += "，深夜未眠——以日出为一天的分界"

    # === 静态部分（完全不变） ===
    static_parts = []

    try:
        persona = (_PROMPTS_DIR / "persona.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        persona = ""
    if persona:
        static_parts.append(persona)

    # default.md 顶部只保留 profile 的静态行为规则；项目/日历/文件占位区由下方
    # dynamic_parts 统一生成，避免旧模板和 canonical builder 重复注入业务数据。
    try:
        profile_text = (_PROMPTS_DIR / f"{profile}.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        profile_text = ""
    profile_policy = profile_text.split("\n---", 1)[0].strip()
    if profile_policy:
        static_parts.append(profile_policy)

    # 注意：beh_block（相处姿态）不放在 static 中——它在不同 call 间变化
    # （如 Query vs Companion），会破坏 MiniMax 前缀匹配缓存。
    # beh_block 在 runner.py 中作为动态上下文注入 messages[0]。

    lens_block = (memory.get("lens") or "").strip()
    if lens_block:
        static_parts.append(lens_block)

    try:
        skills_policy = (_PROMPTS_DIR / "skills.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        skills_policy = ""
    if skills_policy:
        static_parts.append(skills_policy)

    try:
        content_policy = (_PROMPTS_DIR / "policy.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        content_policy = ""
    if content_policy:
        static_parts.append(content_policy)

    style_block = _style_block(style_prefs or {})
    if style_block:
        static_parts.append(style_block)

    skills_block = _skills_index_block(skills)
    if skills_block:
        static_parts.append(skills_block)

    # === 动态部分（可能变化） ===
    dynamic_parts = []

    # summary 与 stance 属于每轮动态尾部；session info 只保留较稳定的记忆 section。
    mem_block = _memory_block(memory, include_summary=False)
    if mem_block:
        dynamic_parts.append(mem_block)

    if include_projects:
        proj_lines = []
        for p in projects[:25]:
            deadline = f"截止 {p.deadline}" if p.deadline else "无截止"
            done_cnt = sum(1 for s in p.stages if s.get("done"))
            total_cnt = len(p.stages)
            prog = f"{done_cnt}/{total_cnt}阶段" if total_cnt else "无阶段"
            proj_lines.append(f"- [id={p.id}] [{_STATUS_ZH.get(p.status, p.status)}] {p.name}（{prog}，{deadline}，客户：{p.client or '无'}）")
        proj_block = "\n".join(proj_lines) if proj_lines else "暂无项目"
    else:
        proj_block = "（本次任务不需要项目上下文，未加载）"
    dynamic_parts.append(f"## 项目\n{proj_block}")

    if include_calendar:
        ev_lines = [f"- {ev.date} {ev.title}" for ev in events[:10]]
        ev_block = "\n".join(ev_lines) if ev_lines else "暂无近期事件"
    else:
        ev_block = "（本次任务不需要日历上下文，未加载）"
    dynamic_parts.append(f"## 日历\n{ev_block}")

    files_block = (_files_block(files, {p.id: p.name for p in projects})
                   if include_files else "（本次任务不需要文件上下文，未加载）")
    dynamic_parts.append(f"## 文件\n{files_block}")

    src_block = _source_block(source, im_channels)
    if src_block:
        dynamic_parts.append(src_block)

    if non_streaming:
        dynamic_parts.append(_NON_STREAMING_BLOCK)

    # 时间不放在 dynamic_context 中——它会变化导致 messages 前缀断裂。
    # 时间作为最后一条独立消息追加（在 runner.py / web.py 中处理），
    # 这样 messages 前缀（system-reminder + history + current_msg）跨 run 一致，缓存命中。

    if im_message_format == "compat":
        from agent.im.message_format import compatibility_prompt
        dynamic_parts.append(compatibility_prompt())

    static_text = "\n\n---\n\n".join(static_parts) if static_parts else ""
    dynamic_text = "\n\n---\n\n".join(dynamic_parts) if dynamic_parts else ""

    return static_text, dynamic_text, now_str


def dynamic_tail(memory: dict | None = None) -> list[str]:
    """生成每轮末尾的低频 stance/summary；不混入 session 固定上下文。"""
    memory = memory or {}
    parts: list[str] = []
    try:
        from agent import behaviors as _bh
        stance = _bh.render(_bh.select(memory.get("stance"), memory.get("stance_ts")))
    except Exception:
        stance = ""
    if stance:
        parts.append(stance)
    summary = (memory.get("summary") or "").strip()
    if summary:
        parts.append("## 当前对话长期摘要\n\n" + summary)
    return parts


_SOURCE_NAME = {"qq": "QQ", "feishu": "飞书", "wechat": "微信", "web": "网页"}


def _source_block(source: str | None, im_channels: dict | None) -> str:
    """注入「当前对话来源 + 已连通知渠道」——根治『用户正用 QQ 聊天，咕咕却说 QQ 没绑、让扫码』。
    当前来源平台必然可达（用户正用它说话），强制标记已连，别再让 TA 绑。"""
    name = _SOURCE_NAME.get(source or "")
    ch = im_channels or {}
    qq_on = bool(ch.get("qq")) or source == "qq"
    fs_on = bool(ch.get("feishu")) or source == "feishu"
    wc_on = source == "wechat"
    lines = []
    if name:
        lines.append(f"本次对话来自：**{name}**。你当前正在通过{name}与用户实时聊天。")
    lines.append(f"主动通知渠道：站内通知（始终可用）；QQ {'已连 ✅' if qq_on else '未连 ❌'}；"
                 f"飞书 {'已连 ✅' if fs_on else '未连 ❌'}；微信 {'已连 ✅' if wc_on else '未连 ❌'}。")
    if source in ("qq", "feishu", "wechat"):
        lines.append(f"- 用户**正用 {name} 跟你说话** → {name} 必然已连接：设提醒/通知走 {name} 渠道时"
                     f"**无需再绑定、绝不让 TA 扫码**（说『没绑』就错了）。")
    lines.append("- 设 qq/feishu 通知渠道前看这里：已连(✅)的直接用；只有未连(❌)才提示用户去「设置 → 连接 IM」绑定。")
    return "## 当前对话来源 / 通知渠道\n\n" + "\n".join(lines)


# IM 消息（run_collect）/ 定时任务都不流式展示给用户，中间轮次说的话
# 和最终答案会被一并收进推送文本（见 runner._collect），别在工具调用之间输出「我先查一下 /
# 再看看」这类过程性旁白——那些话在网页流式场景里用户能看到没问题，这里会被当成正文发出去。
_NON_STREAMING_BLOCK = (
    "## 输出方式\n\n"
    "这轮对话不会流式展示给用户，所有工具都用完之后再一次性给出完整回复；"
    "工具调用之间不要输出过程性旁白（如「我先查一下」「这条数据不对我再试试」），"
    "那些话会被原样发给用户看到。要是这次任务包含好几个部分（比如新闻+天气），"
    "把所有部分都放进最后这一条回复里说完，别拆成好几条分别说。"
)


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


def _memory_block(memory: dict, *, include_summary: bool = True) -> str:
    """咕咕对用户的记忆。全空时也注入一句明确声明——给"我不知道"一个锚点，防模型
    在空白处脑补共同经历（伪个性化）；不再返回空串。顺序：稳定事实 → 长期记忆 → 最近。"""
    summary = (memory.get("summary") or "").strip()
    profile = (memory.get("profile") or "").strip()
    pattern = (memory.get("pattern") or "").strip()
    longterm = (memory.get("memory") or "").strip()
    daily   = (memory.get("daily") or "").strip()
    parts = []
    if summary and include_summary:
        # 时间衰减:summary 越久没更新越不可信，按权重换不同话术（数字内部用、不喂模型）
        from agent import decay
        w = decay.weight(memory.get("summary_ts"))
        ad = decay.age_days(memory.get("summary_ts"))
        if w >= 0.6:
            parts.append("## TA 最近的状态\n\n" + summary)
        elif w >= 0.25:
            parts.append(f"## TA 的状态（约 {int(ad)} 天前记的，仅供参考、可能已变）\n\n" + summary)
        else:
            parts.append(f"## TA 较早前的状态（约 {int(ad)} 天前，多半过时——别当成现在、别据此主动提具体事）\n\n" + summary)
    if profile:
        parts.append("## 用户画像\n\n" + profile)
    if pattern:
        parts.append("## TA 的行为/决策习惯\n\n" + pattern)
    if longterm:
        parts.append("## 长期记忆\n\n" + longterm)
    if daily:
        parts.append("## 最近的记忆\n\n" + daily)
    if not parts:
        if not include_summary and summary:
            return ""
        return ("## 关于这位用户的记忆\n\n"
                "（暂无任何长期记忆——你对 TA 还不了解。别假装记得任何共同经历或偏好，"
                "需要了解就直接问。）")
    # 时间锚点 + 时长红线（防时长虚构:模型的时间语感永远往「显得更熟」漂——上月开始的话题
    # 被说成「这几个月的观察」。时长由系统算好给硬数字,禁模型自估。见 反馈信号系统-设计.md §4.3）
    first_ts = memory.get("first_ts")
    if first_ts:
        from agent import decay
        kd = decay.age_days(first_ts)
        span = "今天" if (kd is None or kd < 1) else f"{int(kd)} 天前"
        parts.insert(0, (f"（时间锚点：你对 TA 的记忆是从 {span} 开始积累的。谈及时间跨度只用本区块"
                         f"给出的数字；没给数字的，**不要**用「这几个月」「一直以来」「很久」这类词"
                         f"概括时长——无据的时间词是在虚构你们的历史。）"))
    return "\n\n".join(parts)
