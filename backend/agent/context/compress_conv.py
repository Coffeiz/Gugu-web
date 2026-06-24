"""对话历史压缩：token 量超阈值时后台把老消息滚动总结成 summary，注入 system prompt。

触发：回复结束后估算 session 全量历史 token，超过 THRESHOLD × budget 则把"超出保留
窗口的最老一批"压成摘要。**滚动**：把上一版 summary 一并喂给摘要器合并，不从头重压。
存为每 session 一条 role="summary" 的 ConversationMessage（覆盖更新）。

注入：`select_history` 把 summary 置顶取出，**入口编排（runner/web）把它从消息列表里
弹出、追加进 system prompt**——不能当成 role="summary" 的消息发给 LLM（API 只认 user/
assistant，且要交替）。见 `pop_summary`。

无感：fire-and-forget 异步执行，不阻塞当前回复；失败只 log，不影响主流程。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from sqlalchemy import delete, select

from agent.context.tokens import estimate_tokens, msg_tokens

logger = logging.getLogger(__name__)

_bg_tasks: set = set()

# 关系：保留窗口（TARGET）须 ≥ select_history 的预算（=budget），否则被保留的原文会和
# summary 覆盖区重叠、重复烧 token。故 TARGET=1.0（与 select_history 保留量对齐），
# THRESHOLD=1.5（总量超 1.5×budget 才压，summary 只覆盖窗口之外、select_history 本就丢掉的老消息）。
COMPRESS_THRESHOLD = 1.5    # 全量 token > budget × 此值时触发
COMPRESS_TARGET    = 1.0    # 保留最近原文的量（占 budget）——与 select_history 对齐，不重叠
_MAX_COMPRESS_TOKENS = 12000   # 单次喂给摘要器的原文上限（保护摘要器自身上下文；超出取最近一段，老的靠上一版 summary）

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "compress_conv.md"
_SUMMARY_HEADER = "## 早前对话摘要（供参考，非最新消息）"


def pop_summary(history: list) -> tuple[str | None, list]:
    """从 select_history 的输出里弹出 summary 条，返回 (摘要正文, 去掉 summary 的历史)。

    供 runner/web 用：summary 不能当消息发给 LLM，要追加进 system prompt。
    """
    summary_text = None
    rest = []
    for h in history:
        if getattr(h, "role", None) == "summary":
            summary_text = (getattr(h, "content", "") or "").strip() or None
        else:
            rest.append(h)
    return summary_text, rest


def system_block(summary_text: str) -> str:
    """把摘要正文包成 system prompt 后缀。"""
    return f"\n\n{_SUMMARY_HEADER}\n{summary_text}"


def schedule(session_id: int, user_id: int, settings, token_budget: int) -> None:
    """回复结束后 fire-and-forget 触发压缩检查，不阻塞主流程。后台开关关闭则不跑。"""
    if not getattr(getattr(settings, "agent", None), "conv_compress_enabled", True):
        return   # 后台「对话历史压缩」开关关闭：只截断不摘要
    task = asyncio.create_task(_run(session_id, user_id, settings, token_budget))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def _run(session_id: int, user_id: int, settings, token_budget: int) -> None:
    try:
        await compress_if_needed(session_id, user_id, settings, token_budget)
    except Exception as e:
        logger.warning("[compress_conv] session %s 压缩失败: %s", session_id, e)


async def compress_if_needed(session_id: int, user_id: int, settings, token_budget: int) -> bool:
    """检查并执行压缩，返回是否实际执行了压缩。"""
    import app.db.session as _sess
    from app.models import ConversationMessage

    async with _sess._SessionLocal() as db:
        rows = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.created_at.asc())
        )).scalars().all()

    prev_summary = next((m.content for m in rows if m.role == "summary"), None)
    all_msgs = [m for m in rows if m.role != "summary"]
    if not all_msgs:
        return False

    total = sum(msg_tokens(m) for m in all_msgs)
    if total <= token_budget * COMPRESS_THRESHOLD:
        return False   # 还没到阈值

    # 从最新往回保留 TARGET×budget 原文，更老的进 to_compress
    target_keep = int(token_budget * COMPRESS_TARGET)
    tail_tokens = 0
    split_idx = 0
    for i in range(len(all_msgs) - 1, -1, -1):
        t = msg_tokens(all_msgs[i])
        if tail_tokens + t > target_keep:
            split_idx = i + 1
            break
        tail_tokens += t

    to_compress = all_msgs[:split_idx]
    if not to_compress:
        return False

    # 构建对话文本（只取有正文的 user/assistant；工具轮次 content 为空，自然跳过）。
    # 超 _MAX_COMPRESS_TOKENS 时取最近一段（更老的靠上一版 summary 兜底，避免撑爆摘要器）。
    lines, acc = [], 0
    for m in reversed(to_compress):
        text = (m.content or "").strip()
        if not text:
            continue
        t = estimate_tokens(text)
        if acc + t > _MAX_COMPRESS_TOKENS and lines:
            break
        lines.append(f"{'用户' if m.role == 'user' else '咕咕'}：{text}")
        acc += t
    lines.reverse()
    if not lines:
        return False
    conv_text = "\n\n".join(lines)

    summary = await _call_llm(conv_text, prev_summary, settings)
    if not summary:
        return False

    async with _sess._SessionLocal() as db:
        await db.execute(delete(ConversationMessage).where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role == "summary",
        ))
        db.add(ConversationMessage(session_id=session_id, role="summary", content=summary))
        await db.commit()

    logger.info("[compress_conv] session %s：%d 条 → summary（%d token，%s）",
                session_id, len(to_compress), estimate_tokens(summary),
                "滚动合并" if prev_summary else "首次")
    return True


async def _call_llm(conv_text: str, prev_summary: str | None, settings) -> str:
    """调 LLM 生成/合并摘要，复用现有 provider 路由。"""
    from agent.memory._llm import complete_text
    try:
        sys_prompt = _PROMPT_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        sys_prompt = "请将以下对话压缩为简洁摘要，保留关键决定、事实和用户偏好，控制在300字以内："
    if prev_summary:
        user_text = (f"【已有摘要（更早的对话，需与下面新增内容合并、保留全部关键信息）】\n{prev_summary}\n\n"
                     f"【新增对话】\n{conv_text}")
    else:
        user_text = conv_text
    return await complete_text(sys_prompt, user_text, settings, max_tokens=600)
