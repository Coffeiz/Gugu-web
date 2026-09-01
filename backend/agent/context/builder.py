"""动态会话上下文组装层。

system prompt 的组装位于 ``session_system.py``；本模块只组装项目、日历、笔记、文件
和消息格式等动态上下文。
"""
from datetime import datetime
from app.core.tz import LOCAL_TZ
from agent.context.session_snapshot import date_boundary_note
from agent.context.session_system import NON_STREAMING_BLOCK, build_static_prompt


# 项目状态英文枚举 → 中文（注入上下文时翻好，免得咕咕照搬英文说给用户）
_STATUS_ZH = {"pending": "待开始", "active": "进行中", "done": "已完成"}


def _files_block(fo: dict | None) -> str:
    """个人文件库概览文本：一级目录 + 最近文件。"""
    if not fo:
        return "暂无文件"
    folders = fo.get("folders") or []
    files = fo.get("files") or []
    if not fo.get("total") and not fo.get("trash") and not folders and not files:
        return "暂无文件"
    trash_n = fo.get("trash") or 0
    lines = [f"个人文件库共 {fo.get('total', 0)} 个活跃文件；回收站 {trash_n} 个。"]
    if folders:
        lines.append("一级目录：" + "、".join(
            f"{x.get('path', x['name'])}（文件数 {x.get('file_count', 0)}）"
            for x in folders
        ))
    if files:
        lines.append(f"最近文件（最多 {len(files)} 个；这里只是截断列表，不代表其它目录为空）：")
        for f in files:
            loc = f.get("folder") or "个人文件库"
            lines.append(f"- {f['name']}（{loc}）")
    return "\n".join(lines)


def _project_root_folders(project) -> str:
    roots = [
        folder.name for folder in (getattr(project, "folders", None) or [])
        if folder.parent_id is None and folder.deleted_at is None
    ]
    return "、".join(roots) if roots else "无根目录"


def _notes_block(notes: list[dict] | None) -> str:
    """最近一周普通笔记摘要；画布便签不在此处注入。"""
    if not notes:
        return "最近一周暂无笔记"
    lines = [f"最近一周笔记（最多 {len(notes)} 条）："]
    for note in notes:
        title = note.get("title") or "无标题"
        content = note.get("content") or "（无正文）"
        captured_at = note.get("captured_at")
        date = captured_at.strftime("%Y-%m-%d") if hasattr(captured_at, "strftime") else ""
        suffix = f"，日期：{date}" if date else ""
        lines.append(f"- {title}{suffix}：{content}")
    return "\n".join(lines)


def build_split(profile: str, user_name: str, projects: list, events: list,
                memory: dict | None = None, files: dict | None = None,
                skills: list[str] | None = None,
                style_prefs: dict | None = None,
                source: str | None = None, im_channels: dict | None = None,
                user_msg: str = "", non_streaming: bool = False,
                include_projects: bool = True, include_calendar: bool = True,
                include_files: bool = True, include_memory: bool = True,
                user_tz=None, im_message_format: str | None = None,
                notes: list[dict] | None = None) -> tuple[str, str, str]:
    """将 system prompt 拆分为静态部分和动态部分。

    静态部分（每轮重建）：人格/profile policy/政策/工具定义/风格/技能索引
    动态部分（可能变化）：记忆/项目/笔记/文件/时间/消息格式

    返回 (static_text, dynamic_text, now_str)，调用方将静态部分放在 system，
    动态部分放在 messages[0] 作为上下文注入，时间作为最后的独立消息。

    这样 system prefix 跨 call 完全一致，MiniMax 前缀匹配缓存能命中。
    """
    memory = memory if (include_memory and memory) else {}
    _now = datetime.now(user_tz or LOCAL_TZ)
    today = _now.strftime("%Y-%m-%d")
    _wd = "一二三四五六日"[_now.weekday()]
    now_str = f"{today}（星期{_wd}）{_now.strftime('%H:%M')}"
    now_str += date_boundary_note(_now.hour)

    # 稳定提示词每轮重建，使 persona/skills/policy 修改在下一轮生效；动态业务数据
    # 仍只在 snapshot 重建时读取。
    static_text = build_static_prompt(
        profile, user_name, skills=skills, style_prefs=style_prefs,
    )

    # === 动态部分（可能变化） ===
    dynamic_parts = []

    # summary 属于 snapshot 前置上下文：在快照建立/过期/压缩时读取一次，避免作为
    # 当前请求的新增消息被误判成当前用户输入。stance 由本轮 turn batch 按 digest 注入。
    mem_block = _memory_block(memory, include_summary=True)
    if mem_block:
        dynamic_parts.append(mem_block)

    if include_projects:
        proj_lines = []
        for p in projects:
            deadline = f"截止 {p.deadline}" if p.deadline else "无截止"
            done_cnt = sum(1 for s in p.stages if s.get("done"))
            total_cnt = len(p.stages)
            prog = f"{done_cnt}/{total_cnt}阶段" if total_cnt else "无阶段"
            roots = _project_root_folders(p)
            proj_lines.append(
                f"- [id={p.id}] [{_STATUS_ZH.get(p.status, p.status)}] {p.name}"
                f"（{prog}，{deadline}，客户：{p.client or '无'}，文件根目录：{roots}）"
            )
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
    dynamic_parts.append(f"## 笔记\n{_notes_block(notes)}")

    files_block = (_files_block(files)
                   if include_files else "（本次任务不需要文件上下文，未加载）")
    dynamic_parts.append(f"## 文件\n{files_block}")

    src_block = _source_block(source, im_channels)
    if src_block:
        dynamic_parts.append(src_block)

    if non_streaming:
        dynamic_parts.append(NON_STREAMING_BLOCK)

    # 时间不放在 snapshot_context 中——它会变化导致 messages 前缀断裂。
    # 时间由本轮 turn batch 追加；snapshot 生成的 memory/projects/calendar/files/source
    # 作为固定前缀，避免每轮重新排列历史消息。

    if im_message_format == "compat":
        from agent.im.message_format import compatibility_prompt
        dynamic_parts.append(compatibility_prompt())

    dynamic_text = "\n\n---\n\n".join(dynamic_parts) if dynamic_parts else ""

    return static_text, dynamic_text, now_str


def stance_block(memory: dict | None = None) -> str:
    """生成本轮姿态正文；是否追加由 turn batch 比较 session digest 决定。"""
    memory = memory or {}
    try:
        from agent import behaviors as _bh
        stance = _bh.render(_bh.select(memory.get("stance"), memory.get("stance_ts")))
    except Exception:
        stance = ""
    return stance


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


def _memory_block(memory: dict, *, include_summary: bool = True) -> str:
    """咕咕对用户的记忆。全空时也注入一句明确声明——给"我不知道"一个锚点，防模型
    在空白处脑补共同经历（伪个性化）；不再返回空串。顺序：稳定事实 → 长期记忆 → 最近。"""
    summary = (memory.get("summary") or "").strip()
    profile = (memory.get("profile") or "").strip()
    pattern = (memory.get("pattern") or "").strip()
    longterm = (memory.get("memory") or "").strip()
    lens = (memory.get("lens") or "").strip()
    # daily 已在 store.read_memory 的注入层截断；这里保留二次边界，避免其他调用方
    # 直接传入未截断内容时绕过上下文预算。
    from agent.memory.store import DAILY_INJECT_CHARS
    daily   = (memory.get("daily") or "").strip()[:DAILY_INJECT_CHARS]
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
    if lens:
        parts.append("## 解读先验\n\n" + lens)
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
