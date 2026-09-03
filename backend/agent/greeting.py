"""对话默认问候生成：组装精简记忆上下文 + 轻量 LLM 直连。

不走完整 agent 循环（参照 gateway/web._generate_title）；模型走 BYOK 覆盖链路（modelctx 绑定）。
**不计入精力/配额**：本调用不经 web.stream / runner 那条记 AgentUsage 的路，token 不写 AgentUsage、不扣配额。
同一用户同一语言十分钟内复用 Redis 中的结果，并发请求合并；失败 / 空 → 返回 ''，由前端兜底池接手（永不慢、永不空）。
问候**不自我介绍、不报功能菜单、emoji 极简**。
"""
import asyncio
import logging
from datetime import timedelta

from app.core import redis as redis_core
from app.core.tz import now_ctx, now_utc

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ConversationMessage, ConversationSession, Project
from agent.context.loaders import project_sort_key
from agent.memory import store as mem_store

logger = logging.getLogger("agent.greeting")

_CACHE_TTL_SECONDS = 600
_CACHE_LOCK_TIMEOUT_SECONDS = 30
_CACHE_LOCK_WAIT_SECONDS = 15

_PROMPT = (
    "你是「咕咕」，用户的长期伙伴。用户刚打开对话框，请像熟人 / 老朋友那样跟他打个招呼。\n"
    "硬要求：\n"
    "- **不要自我介绍**（他早就认识你了），别说「你好，我是咕咕」这类。\n"
    "- **别罗列功能清单**（项目 / 文件 / 日历这种名词菜单）。\n"
    "- 暖、像朋友、可以一点点俏皮但真诚；**表情极简**，能不用就不用。\n"
    "- 2~3 句；**结尾主动递一个轻的、勾人的话头**——一个 TA 会想接的小问题 / 好奇，把天往下引；别只干巴巴「想聊啥都行」把话丢回去。但也**别硬凑、别每次都套一个问句**，自然就好。\n"
    "- **据下面「上次和你说话」定时间感**：刚聊过（几小时内 / 今天 / 昨天）→ **暖暖地接住、像老友回来了很高兴**，别说「好久不见」，更**别去评论『又回来了 / 这么快 / 刚走又来』这种间隔**（那读着像嫌他来太勤、不欢迎）；确实隔了好些天 → 才用久别语气，且别说「刚才 / 还在…呢」这种『就在刚刚』的话。没聊天记录就轻松招呼一句。\n"
    "- **据下面「TA 最近的相处状态 / 在忙啥」定口吻**：像累的 / 情绪不高 → 温柔、别提活；像在轻松聊 → 也轻松；在专注做事 → 关心一句就好、留「先歇会儿也行」的空间。\n"
    "- **话头可以从 TA 最近 / 今天在弄的项目或近况里挑一个**，但**只问「体验 / 感受 / 社交生活」角度，绝不问「进度 / 完成」**：\n"
    "  ✅「在弄 X 呀，好玩不 / 累不累 / 啥感觉」「那个 X 被朋友试用了，反馈咋样」——问的是滋味和人。\n"
    "  ❌「X 整理好了吗 / 弄完没 / 咋样了 / 到哪一步了」——这些**都是在问进度**，别问；也别提待办 / 下一步 / 该做了，不催、不做进度汇报。\n"
    "  只挑一个、别念清单；陈年旧事别当『最近』说，近期没料就走通用暖开场 + 一句好奇。\n"
    "- **绝不问「X 做完了吗 / 搞定了没 / 进展如何」**——那是查岗、还常问到早已完成的事上。真想关心就用「那个还顺吗」这种软的、不逼他答。\n"
    "{ctx}"
    "直接输出招呼本身，不要任何解释或引号。"
)

_LOCALE_INSTRUCTIONS = {
    "zh-CN": "请使用简体中文直接输出问候，不要夹带其他语言。",
    "ja-JP": "挨拶は自然な日本語で直接出力してください。中国語を混ぜないでください。",
    "en-US": "Output the greeting directly in natural English. Do not mix in Chinese or Japanese.",
}


def _current_time_part() -> str:
    now = now_ctx()
    weekdays = "一二三四五六日"
    return f"【当前日期和时间】{now:%Y-%m-%d} 星期{weekdays[now.weekday()]} {now:%H:%M}（按用户时区）"


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
    mins = max(0.0, (now_utc() - last).total_seconds() / 60)
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
    # 记忆：当前状态快照 + 长期画像 + 近 7 天 daily（先取出，下面按优先级排）
    summary = long_term_memory = daily = ""
    summary_ts = None
    try:
        mem = await mem_store.read_memory(user_id)
        summary = (mem.get("summary") or "").strip()[:400]
        summary_ts = mem.get("summary_ts")
        long_term_memory = (mem.get("profile") or "").strip()[:500]
        cutoff = (now_ctx().date() - timedelta(days=7)).isoformat()
        daily_entries = mem_store.extract_daily_entries(mem.get("daily") or "")
        daily_lines = [f"- {date} {note}" for date, note in daily_entries if date >= cutoff]
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
    # 项目背景沿用项目看板排序：待开始取 1 个，进行中取 3 个。
    proj_part = ""
    try:
        rows = (await db.execute(
            select(Project)
            .where(Project.user_id == user_id, Project.archived.is_(False),
                   Project.status.in_(("pending", "active"))))).scalars().all()
        grouped = {"pending": [], "active": []}
        for project in rows:
            grouped[project.status].append(project)
        selected = (
            sorted(grouped["pending"], key=project_sort_key)[:1]
            + sorted(grouped["active"], key=project_sort_key)[:3]
        )
        if selected:
            proj_part = "\n".join(
                f"- {p.name}（{'待开始' if p.status == 'pending' else '进行中'}，{p.progress}%）"
                for p in selected
            )
    except Exception:
        pass
    # 优先级：项目、summary、daily、长期画像；不注入 pattern 或日程，避免问候上下文过载。
    parts: list[str] = [_current_time_part()]
    if seen:
        parts.append(seen)
    if stance_hint:
        parts.append(f"【TA 最近的相处状态】上次聊下来，TA 像是「{stance_hint}」——据此定问候口吻（尤其情绪/闲聊类，别提活）。")
    if proj_part:
        parts.append("【TA 最近 / 今天在弄的项目】（可挑一个当**闲聊话头**：用「在弄 X 呀，咋样」这种好奇/关心口吻聊，**绝不往推进/进度/待办带**）\n" + proj_part)
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
    if daily:
        parts.append("【近 7 天记忆】\n" + daily)
    if long_term_memory:
        parts.append("【长期画像（仅帮你把握 TA 是谁，别当成最近在忙的事）】\n" + long_term_memory)
    return ("\n近期上下文（仅供你自然带一句，别照念）：\n" + "\n\n".join(parts) + "\n\n") if parts else "\n"


def _cache_key(user_id, locale: str) -> str:
    return f"agent:greeting:{user_id}:{locale}"


async def _generate_uncached(db: AsyncSession, user_id, settings, *, locale: str = "zh-CN") -> str:
    """不读写缓存地生成一句问候；失败 / 空 → ''（前端兜底）。"""
    # greeting 是用户请求链路：与聊天同一条 BYOK 覆盖，modelctx 兜底哨兵生效
    from agent.llm import modelctx
    from agent.llm.llm_select import resolve_run_config_for_user
    modelctx.mark_user_scope()
    modelctx.set_model_cfg((await resolve_run_config_for_user(settings, db, user_id, None)).model)
    try:
        language_instruction = _LOCALE_INSTRUCTIONS.get(locale, _LOCALE_INSTRUCTIONS["zh-CN"])
        prompt = _PROMPT.format(ctx=await _recent_context(db, user_id)) + "\n" + language_instruction
        from agent import providers
        from agent.llm.llm_select import use_anthropic_for
        from agent.llm.modelctx import effective_ai
        # greeting 由用户请求派生（fire-and-forget），模型走 modelctx 绑定（BYOK）+ 平台兜底
        ai = effective_ai(settings)
        provider_adapter = providers.adapter_for(ai)
        import httpx
        _timeout = httpx.Timeout(12.0)
        if use_anthropic_for(ai):
            client = providers.build_anthropic_client(ai, _timeout)
            extra = provider_adapter.build_anthropic_thinking_params(ai)
            resp = await client.messages.create(
                model=ai.model, max_tokens=180,
                messages=[{"role": "user", "content": prompt}], **extra)
            text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
        else:
            client = providers.build_openai_client(ai, _timeout)
            extra = provider_adapter.build_openai_thinking_kwargs(ai)
            resp = await client.chat.completions.create(
                model=ai.model, max_tokens=180,
                messages=[{"role": "user", "content": prompt}], **extra)
            text = resp.choices[0].message.content or ""
        return text.strip().strip('"「」')
    except Exception as e:
        logger.warning("greeting 生成失败（前端兜底）: %s", e)
        return ""


async def generate(db: AsyncSession, user_id, settings, *, locale: str = "zh-CN") -> str:
    """生成问候；同一用户同一语言十分钟内复用结果，失败 / 空 → ''。"""
    locale = locale if locale in _LOCALE_INSTRUCTIONS else "zh-CN"
    cache_key = _cache_key(user_id, locale)
    try:
        redis = redis_core.get_redis()
        cached = await redis.get(cache_key)
        if cached:
            return str(cached)

        # 跨进程合并并发请求：拿锁后必须再次读缓存，避免两个请求同时生成。
        lock = redis.lock(
            f"{cache_key}:lock",
            timeout=_CACHE_LOCK_TIMEOUT_SECONDS,
            thread_local=False,
        )
        acquired = await lock.acquire(
            blocking=True,
            blocking_timeout=_CACHE_LOCK_WAIT_SECONDS,
        )
        if not acquired:
            return ""
        try:
            cached = await redis.get(cache_key)
            if cached:
                return str(cached)
            text = await _generate_uncached(db, user_id, settings, locale=locale)
            if text:
                try:
                    await redis.set(cache_key, text, ex=_CACHE_TTL_SECONDS)
                except Exception:
                    # 生成已经成功时，缓存写入失败不应再次触发一次模型调用。
                    logger.warning("greeting 缓存写入失败", exc_info=True)
            return text
        finally:
            try:
                await lock.release()
            except Exception:
                logger.debug("greeting 缓存锁释放失败", exc_info=True)
    except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        # Redis 不可用时保留原有能力；服务恢复后会自动重新启用限频。
        logger.warning("greeting 缓存不可用，降级为直接生成", exc_info=True)
        return await _generate_uncached(db, user_id, settings, locale=locale)
