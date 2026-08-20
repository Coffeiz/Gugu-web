"""System prompt 组装层。

注入顺序：persona.md（咕咕人格，始终最先、所有 profile 共享）→ profile 模板
（default.md，含实时数据与记忆占位符）。persona 定义"咕咕是谁、怎么相处、何时
主动"，模板提供"此刻的项目/日程/记忆"。
"""
from datetime import datetime, timedelta
from pathlib import Path

from app.core.tz import LOCAL_TZ, local_now

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


# prompt 缓存断点标记（ASCII Group Separator，正常 prompt 文本绝不出现）：
# build() 在「稳定前缀 ┃ 动态后缀」边界插一个，让 core 据它把 system 切成两块、
# 只缓存稳定前缀（人格/政策/技能索引，一个 session 内不变）。两块拼接后与原单块逐字一致。
CACHE_BREAK = "\x1d"


def split_for_cache(text: str) -> list[str]:
    """按 CACHE_BREAK 把 system 切成多个段。无标记 → [原文]。

    builder.py 使用多个 CACHE_BREAK 将 system 分为 3 段：
    - stable（人格/政策等，完全不变）
    - semi-stable（记忆/项目/文件等，变化较慢）
    - volatile（时间/消息格式等，每轮都变）

    调用方根据需要给前面的段加 cache_control，最后一段不加。
    """
    if CACHE_BREAK in text:
        return text.split(CACHE_BREAK)
    return [text]


def strip_cache_marker(text: str) -> str:
    """去掉缓存断点标记，还原成普通 system 串（openai 路 / 不支持 cache_control 的通道用）。"""
    return text.replace(CACHE_BREAK, "")


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


def build(profile: str, user_name: str, projects: list, events: list,
          memory: dict | None = None, files: dict | None = None,
          skills: list[str] | None = None,
          style_prefs: dict | None = None,
          source: str | None = None, im_channels: dict | None = None,
          user_msg: str = "", non_streaming: bool = False,
          include_projects: bool = True, include_calendar: bool = True,
          include_files: bool = True, include_memory: bool = True,
          user_tz=None, im_message_format: str | None = None) -> str:
    # include_* 允许少数轻量阶段关闭业务上下文；跳过时不省 header 文字，
    # 省的是 header 底下那块真正贵的内容（最多 25 个项目 / 10 条日程 / 完整记忆）。
    memory = memory if (include_memory and memory) else {}
    # 「今天/现在」按用户时区（user_tz）算——异地用户看到的日期才对；user_tz=None 回退服务器 LOCAL_TZ（零行为变化）。
    _now = datetime.now(user_tz or LOCAL_TZ)
    today = _now.strftime("%Y-%m-%d")
    # 当前完整时刻（含星期、时分），让咕咕知道"现在几点、星期几"，能答时间、按时段问候、排期
    _wd = "一二三四五六日"[_now.weekday()]
    now_str = f"{today}（星期{_wd}）{_now.strftime('%H:%M')}"
    # 深夜（0-4 点）：用户主观上还没睡着、仍认为是"昨天"，「明天」=日历今天，「今天」=日历昨天
    if _now.hour < 4:
        now_str += "，深夜未眠——以日出为一天的分界：用户口中的「今天」指尚未结束的这个主观白天（日历昨天），「明天」指日出后的那天（日历今天），涉及日期时请按此理解"

    if include_projects:
        proj_lines = []
        for p in projects[:25]:
            deadline = f"截止 {p.deadline}" if p.deadline else "无截止"
            done_cnt  = sum(1 for s in p.stages if s.get("done"))
            total_cnt = len(p.stages)
            prog = f"{done_cnt}/{total_cnt}阶段" if total_cnt else "无阶段"
            proj_lines.append(f"- [id={p.id}] [{_STATUS_ZH.get(p.status, p.status)}] {p.name}（{prog}，{deadline}，客户：{p.client or '无'}）")
        proj_block = "\n".join(proj_lines) if proj_lines else "暂无项目"
    else:
        proj_block = "（本次任务不需要项目上下文，未加载）"

    if include_calendar:
        ev_lines = [f"- {ev.date} {ev.title}" for ev in events[:10]]
        ev_block = "\n".join(ev_lines) if ev_lines else "暂无近期事件"
    else:
        ev_block = "（本次任务不需要日历上下文，未加载）"

    prompt_file = _PROMPTS_DIR / f"{profile}.md"
    try:
        template = prompt_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        template = "今天是 {today}。\n\n## 项目\n{projects}\n\n## 日历\n{calendar}"

    files_block = (_files_block(files, {p.id: p.name for p in projects})
                   if include_files else "（本次任务不需要文件上下文，未加载）")
    replacements = {
        "{today}":    today,
        "{now}":      now_str,
        "{name}":     user_name,
        "{projects}": proj_block,
        "{calendar}": ev_block,
        "{files}":    files_block,
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

    # 行为模块（Behavior Skills）：反思驱动 stance 软点亮（per-user + 新鲜度闸，非正则），
    # 置于人格之后、最高优先——本轮"特别这么相处"，盖过默认倾向。`baseline` 永远在场。详见感知系统升级 §2.6。
    try:
        from agent import behaviors as _bh
        beh_block = _bh.render(_bh.select(memory.get("stance"), memory.get("stance_ts")))
    except Exception:
        beh_block = ""

    # 缓存策略（2026-08-19 更新）：
    # 使用多个 CACHE_BREAK 分段，每段对应不同的 cache_control 断点：
    #   断点1（stable）：人格/政策/技能等 → session 内完全不变 → 缓存命中率最高
    #   断点2（semi-stable）：记忆/项目/文件/日历 → 变化频率低（天/周级）
    #   无断点（volatile）：当前时间/消息格式 → 每轮都变 → 不标记
    #
    # 最多 4 个断点（阿里/MiniMax 限制），当前使用 2 个。
    stable, semi_stable, volatile = [], [], []
    if persona:
        stable.append(persona)
    if beh_block:
        stable.append(beh_block)
    lens_block = (memory.get("lens") or "").strip()
    if lens_block:
        stable.append(lens_block)
    if skills_policy:
        stable.append(skills_policy)
    if content_policy:
        stable.append(content_policy)
    style_block = _style_block(style_prefs or {})
    if style_block:
        stable.append(style_block)
    skills_block = _skills_index_block(skills)
    if skills_block:
        stable.append(skills_block)

    # 半稳定内容：变化频率低，但不是完全不变
    # 记忆（profile/pattern/longterm 很少变，daily 变化稍频繁但仍可缓存）
    mem_block = _memory_block(memory)
    if mem_block:
        semi_stable.append(mem_block)
    # 项目概览、文件概览、日历事件
    src_block = _source_block(source, im_channels)
    if src_block:
        semi_stable.append(src_block)

    # 高频变化内容：每轮都变
    if non_streaming:
        volatile.append(_NON_STREAMING_BLOCK)
    volatile.append(result)
    if im_message_format == "compat":
        from agent.im.context_loader import compatibility_prompt
        volatile.insert(-1, compatibility_prompt())

    stable_str = "\n\n---\n\n".join(stable)
    semi_str = "\n\n---\n\n".join(semi_stable)
    volatile_str = "\n\n---\n\n".join(volatile)

    if not volatile_str:
        if not semi_str:
            return stable_str
        return stable_str + CACHE_BREAK + "\n\n---\n\n" + semi_str
    if not semi_str:
        return stable_str + CACHE_BREAK + "\n\n---\n\n" + volatile_str
    return stable_str + CACHE_BREAK + "\n\n---\n\n" + semi_str + CACHE_BREAK + "\n\n---\n\n" + volatile_str


def build_split(profile: str, user_name: str, projects: list, events: list,
                memory: dict | None = None, files: dict | None = None,
                skills: list[str] | None = None,
                style_prefs: dict | None = None,
                source: str | None = None, im_channels: dict | None = None,
                user_msg: str = "", non_streaming: bool = False,
                include_projects: bool = True, include_calendar: bool = True,
                include_files: bool = True, include_memory: bool = True,
                user_tz=None, im_message_format: str | None = None) -> tuple[str, str]:
    """将 system prompt 拆分为静态部分和动态部分。

    静态部分（完全不变）：人格/政策/工具定义/风格/技能索引
    动态部分（可能变化）：记忆/项目/文件/时间/消息格式

    返回 (static_text, dynamic_text)，调用方将静态部分放在 system，
    动态部分放在 messages[0] 作为上下文注入。

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

    # 相处姿态放在动态部分最前面——每次 call 可能变化
    try:
        from agent import behaviors as _bh
        beh_block = _bh.render(_bh.select(memory.get("stance"), memory.get("stance_ts")))
    except Exception:
        beh_block = ""
    if beh_block:
        dynamic_parts.append(beh_block)

    mem_block = _memory_block(memory)
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
        from agent.im.context_loader import compatibility_prompt
        dynamic_parts.append(compatibility_prompt())

    static_text = "\n\n---\n\n".join(static_parts) if static_parts else ""
    dynamic_text = "\n\n---\n\n".join(dynamic_parts) if dynamic_parts else ""

    return static_text, dynamic_text, now_str


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


def _memory_block(memory: dict) -> str:
    """咕咕对用户的记忆。全空时也注入一句明确声明——给"我不知道"一个锚点，防模型
    在空白处脑补共同经历（伪个性化）；不再返回空串。顺序：稳定事实 → 长期记忆 → 最近。"""
    summary = (memory.get("summary") or "").strip()
    profile = (memory.get("profile") or "").strip()
    pattern = (memory.get("pattern") or "").strip()
    longterm = (memory.get("memory") or "").strip()
    daily   = (memory.get("daily") or "").strip()
    parts = []
    if summary:
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
