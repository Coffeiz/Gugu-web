"""对话默认问候生成：组装记忆上下文（fact + 近 7 天项目活动/提醒 + 近 7 天 daily）+ 轻量 LLM 直连。

不走完整 agent 循环（参照 adapters/web._generate_title）；模型用默认 `settings.ai`。
**不计入精力/配额**：本调用不经 web.stream / runner 那条记 AgentUsage 的路，token 不写 AgentUsage、不扣配额。
失败 / 空 → 返回 ''，由前端兜底池接手（永不慢、永不空）。问候**不自我介绍、不报功能菜单、emoji 极简**。
"""
import logging
from datetime import date, datetime, timedelta

from app.core.tz import local_now

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CalendarEvent, ConversationMessage, ConversationSession, Project
from agent.memory import store as mem_store

logger = logging.getLogger("agent.greeting")

_PROMPT = (
    "你是「咕咕」，用户的长期伙伴。用户刚打开对话框，请像熟人 / 老朋友那样跟他打个招呼。\n"
    "硬要求：\n"
    "- **不要自我介绍**（他早就认识你了），别说「你好，我是咕咕」这类。\n"
    "- **别罗列功能清单**（项目 / 文件 / 日历这种名词菜单）。\n"
    "- 暖、像朋友、可以一点点俏皮但真诚；**表情极简**，能不用就不用。\n"
    "- 2~3 句，结尾把话交回他（想做点啥、想理清啥、随便聊聊都行）。\n"
    "- **据下面「上次和你说话」定口吻**：若就在最近（几小时内 / 今天 / 昨天），**绝不要说「好久不见 / 好久没见 / 这阵子忙啥 / 最近怎么样」这类久别重逢的话**——就自然接上、像刚才还在聊；只有确实隔了好些天，才适合久别重逢的语气。**反过来，若【上次和你说话】显示隔了好些天，就别说「刚才 / 刚 / 还在…呢 / 接着聊 / 又见面了」这类『就在刚刚』的话**——那会把久别硬说成刚聊过。没有聊天记录就给个轻松招呼，也别说好久不见。\n"
    "- **默认是暖的、开放的招呼，别催**：一上来就提项目 / 待办 / 日程，会像在催他干活——先当朋友打个招呼，把话头交回他（想干点啥、想聊聊、还是歇会儿，都行）。\n"
    "- **据下面「TA 最近的相处状态 / 在忙啥」定口吻**：像是累的 / 情绪不高 → 温柔些、别提活；像在轻松聊 → 也轻松；确实在专注推进某事 → 顶多轻轻关心一句「那个还顺吗」，并留「先歇会儿也行」的空间。**永远不催、不做进度汇报。**\n"
    "- 项目 / 日程只是**可选背景，多数时候不必提**；真要带一句，只挑一个、用**关心**口吻，不是清单、不是催办。「长期背景」里的陈年旧事别当『最近在忙』说；近期啥都没有就给句通用暖招呼，别翻旧账。\n"
    "{ctx}"
    "直接输出招呼本身，不要任何解释或引号。"
)


async def _last_seen_part(db: AsyncSession, user_id) -> str:
    """「上次和你说话是多久前」——用最近一条对话消息的时间算。喂给模型定问候口吻
    （刚聊过别说『好久不见』）。"""
    try:
        last = (await db.execute(
            select(ConversationMessage.created_at)
            .join(ConversationSession, ConversationSession.id == ConversationMessage.session_id)
            .where(ConversationSession.user_id == user_id)
            .order_by(ConversationMessage.created_at.desc()).limit(1))).scalar()
    except Exception:
        return ""
    if last is None:
        return "【上次和你说话】没有聊天记录（第一次或很久没来）——别说「好久不见」，给个轻松招呼即可。"
    mins = max(0.0, (datetime.utcnow() - last).total_seconds() / 60)
    if mins < 60:
        when = f"就在不久前（约 {int(mins)} 分钟前）——刚聊过，千万别说「好久不见」，自然接上"
    elif mins < 60 * 12:
        when = f"今天早些时候（约 {int(mins // 60)} 小时前）——别说「好久不见」"
    elif mins < 60 * 24 * 2:
        when = f"约 {int(mins // 60)} 小时前（昨天左右）——别用久别重逢的语气"
    else:
        when = f"{int(mins // (60 * 24))} 天前——隔了好些天，可以用久别重逢的语气"
    return "【上次和你说话】" + when


async def _recent_context(db: AsyncSession, user_id) -> str:
    # 上次互动时间（定问候口吻：刚聊过别说「好久不见」）
    seen = await _last_seen_part(db, user_id)
    # 记忆：当前状态快照 + 长期 fact + 近 7 天 daily（先取出，下面按优先级排）
    summary = facts = daily = ""
    summary_ts = None
    try:
        mem = await mem_store.read_memory(user_id)
        summary = (mem.get("summary") or "").strip()[:400]
        summary_ts = mem.get("summary_ts")
        facts = (mem.get("facts") or "").strip()[:800]
        cutoff = (local_now().date() - timedelta(days=7)).isoformat()
        daily_lines = [ln for ln in (mem.get("daily") or "").splitlines()
                       if ln.strip().startswith("- ") and ln[2:12] >= cutoff]
        daily = "\n".join(daily_lines[:10])
    except Exception:
        pass
    # 上次的相处状态（stance）→ 定口吻。**只在够新鲜时用**：stance 是快变的当下 mode，
    # 隔太久就不代表现在了；不 gate 会把两周前的旧状态当「最近」→ 让久别对话被说成「刚才」。
    stance_hint = ""
    try:
        st, st_ts = await mem_store.read_stance(user_id)
        from agent import decay as _decay
        _age = _decay.age_days(st_ts)   # 天；None=无 ts
        if st and _age is not None and _age < 0.75:   # 18h 内才算「最近状态」，过期不提
            _SMAP = {"情绪": "情绪需要被接住", "陪伴": "想找人说说话", "闲聊": "在轻松闲聊",
                     "执行": "在动手做事", "推进": "在推进某事", "决策": "在纠结拿主意",
                     "记录": "在记点日常", "查询": "在查东西", "反思": "在复盘自己"}
            stance_hint = _SMAP.get(st.strip(), "")
    except Exception:
        pass
    # 近 7 天有动静的项目（可选背景，不是必提项）
    proj_part = ""
    try:
        since = datetime.utcnow() - timedelta(days=7)
        rows = (await db.execute(
            select(Project)
            .where(Project.user_id == user_id, Project.updated_at >= since, Project.archived.is_(False))
            .order_by(Project.updated_at.desc()).limit(6))).scalars().all()
        if rows:
            proj_part = "\n".join(f"- {p.name}（{p.progress}%）" for p in rows)
    except Exception:
        pass
    # 提醒：近 7 天 ~ 未来 14 天的日历事件
    ev_part = ""
    try:
        lo = (date.today() - timedelta(days=7)).isoformat()
        hi = (date.today() + timedelta(days=14)).isoformat()
        evs = (await db.execute(
            select(CalendarEvent)
            .where(CalendarEvent.user_id == user_id, CalendarEvent.date >= lo, CalendarEvent.date <= hi)
            .order_by(CalendarEvent.date).limit(6))).scalars().all()
        if evs:
            ev_part = "\n".join(f"- {e.date} {e.title}" for e in evs)
    except Exception:
        pass
    # 优先级：最近在推进的（项目 > 当下重心 > 日程）排前、最显眼；长期 facts 垫底并明确
    # 标成「背景」——别让陈年事实（如早就聊过的旧项目名）被当成「最近在忙」拿出来。
    parts: list[str] = []
    if seen:
        parts.append(seen)
    if stance_hint:
        parts.append(f"【TA 最近的相处状态】上次聊下来，TA 像是「{stance_hint}」——据此定问候口吻（尤其情绪/闲聊类，别提活）。")
    if proj_part:
        parts.append("【TA 最近在弄的项目】（可选背景，多数时候不必提；真提只挑一个、用关心口吻、别催办、别报进度）\n" + proj_part)
    if summary:
        from agent import decay
        w = decay.weight(summary_ts)
        ad = decay.age_days(summary_ts)
        if w >= 0.6:
            parts.append("【TA 最近在忙什么】\n" + summary)
        elif w >= 0.25:
            parts.append(f"【TA 之前在忙什么（约 {int(ad)} 天前记的，可能已变，别当成现在的事张口就提）】\n" + summary)
        else:
            parts.append(f"【TA 较早前的状态（约 {int(ad)} 天前，多半过时，别拿来当近况）】\n" + summary)
    if ev_part:
        parts.append("【近期日程 / 提醒】\n" + ev_part)
    if daily:
        parts.append("【近 7 天记忆】\n" + daily)
    if facts:
        parts.append("【长期背景（陈年事实，**别当成「最近在忙」随口提**，仅帮你把握 TA 是谁）】\n" + facts)
    return ("\n近期上下文（仅供你自然带一句，别照念）：\n" + "\n\n".join(parts) + "\n\n") if parts else "\n"


async def generate(db: AsyncSession, user_id, settings) -> str:
    """生成一句问候；失败 / 空 → ''（前端兜底）。"""
    try:
        prompt = _PROMPT.format(ctx=await _recent_context(db, user_id))
        from agent.llm_select import use_anthropic_for, _is_mimo
        ai = settings.ai
        is_mimo = _is_mimo(ai)
        import httpx
        if use_anthropic_for(ai):
            from anthropic import AsyncAnthropic
            from agent.llm_select import anthropic_default_headers
            client = AsyncAnthropic(
                api_key=ai.api_key or "dummy", base_url=ai.base_url,
                http_client=httpx.AsyncClient(timeout=httpx.Timeout(12.0)),
                default_headers=anthropic_default_headers(ai))
            extra = {"thinking": {"type": "disabled"}} if is_mimo else {}
            resp = await client.messages.create(
                model=ai.model, max_tokens=180,
                messages=[{"role": "user", "content": prompt}], **extra)
            text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
        else:
            from openai import AsyncOpenAI
            from agent.llm_select import openai_default_headers
            client = AsyncOpenAI(
                api_key=ai.api_key or "dummy", base_url=ai.base_url,
                timeout=httpx.Timeout(12.0), default_headers=openai_default_headers(ai))
            extra = {"extra_body": {"thinking": {"type": "disabled"}}} if is_mimo else {}
            resp = await client.chat.completions.create(
                model=ai.model, max_tokens=180,
                messages=[{"role": "user", "content": prompt}], **extra)
            text = resp.choices[0].message.content or ""
        return text.strip().strip('"「」')
    except Exception as e:
        logger.warning("greeting 生成失败（前端兜底）: %s", e)
        return ""
