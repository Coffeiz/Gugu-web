"""记忆沉淀：daily 攒够后，把最老的条目追加进 memory.md（长期记忆主档）。

机制（按累积条数，不按天数，便于直接控住注入 prompt 的体积）：
- daily 达到 `DAILY_COMPACT_AT`(100) 触发
- 每次只取最老的 `COMPACTION_BATCH_SIZE`(100) 条，LLM 只处理这批 daily
- 新事件章节追加到 memory.md，已有内容不重新组织、不覆盖
压缩失败时不裁剪 daily，避免历史丢失。由 reflection 在写完 daily 后顺带触发，失败不影响主流程。
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from agent.context import provider_runner
from agent.memory import store
from agent.memory.daily_compaction import merge_remaining, should_compact, split_batch
from agent.memory.event_memory import deduplicate_event_sections, normalize_event_memory
from app.core.redaction import diag_log
from agent.memory.memory_references import render_event_references, retrieve_event_references

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
_SYS_FALLBACK = (
    "你在帮咕咕把一批近期 daily 记录沉淀为事件型长期记忆新增章节。"
    "你只处理本批记录，不重写、不复述、不输出已有 memory.md。"
    "长期记忆不只是项目日报，也记录用户主动表达且有持续意义或明显情绪价值的生活经历、人际关系、开心事、难过事、期待和重要体验。"
    "历史事件参考只用于识别重复和核对背景，不是本批次的新事实。"
    "与历史明确重复的记录跳过；有新进展时输出独立的后续记录，保留日期和变化关系。"
    "不要把 profile/pattern 的稳定结论原句复制进 memory。"
    "每个新增事件必须使用标题 ## 记录长期记忆：<事件标题>。日期、背景、过程、结果、情绪、未解决和后续按事件需要选择性记录，不要强行补齐。"
    "保留用户明确表达的情绪和态度，不替用户推断心理；有多个时间节点时再整理时间线。"
    "每章使用固定骨架：标题、时间、类型、状态、事件经过；用户感受、结果与当前状态、未解决与后续按内容选择性加入，禁止空小节。多个事件必须分成多个独立章节。"
    "不评判、不推测，能确认的时间必须保留。"
    '严格只输出 JSON：{"entries": "要追加的新事件章节；没有新增内容时为空字符串"}'
)

_DATE_RE = re.compile(r"20\d{2}-\d{1,2}-\d{1,2}")
logger = logging.getLogger(__name__)


async def _generate_memory_entries(user: str, settings) -> dict:
    """直接调用 provider 生成新增事件，不引入对话 ContextBranch 生命周期。"""
    for attempt in range(1, 3):
        try:
            output = await provider_runner.complete_json(
                _load_sys(), user, settings, max_tokens=10000, temperature=0.3,
            )
            if isinstance(output, dict) and output:
                return output
        except Exception as exc:
            diag_log("agent.memory.compaction.provider", exc)
            logger.warning("长期记忆压缩 provider 调用失败，第 %d 次尝试", attempt)
    return {}


def _preserves_incoming_dates(overflow: list[str], memory: str) -> bool:
    """新增事件有时间记录时，至少保留一个批次中的可靠时间锚点。

    一个批次可能跨越多个日期，且模型可以跳过不值得长期保存的闲聊，
    因此不能要求新增正文覆盖每一个输入日期。
    """
    dates = set(_DATE_RE.findall("\n".join(overflow)))
    return not dates or bool(dates & set(_DATE_RE.findall(memory)))


def _load_sys() -> str:
    try:
        return (_PROMPTS_DIR / "memory_compress.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return _SYS_FALLBACK


async def compact(user_id, settings) -> bool:
    """daily 超阈值则压缩一次。返回是否执行了压缩。失败不抛。"""
    try:
        lines = await store.read_daily_lines(user_id)
        if not should_compact(
            len(lines), trigger=store.DAILY_COMPACT_AT,
            keep_recent=store.DAILY_KEEP_RECENT,
        ):
            return False

        recent, overflow, remaining = split_batch(
            lines, keep_recent=store.DAILY_KEEP_RECENT,
        )
        if not overflow:
            return False

        try:
            references = await retrieve_event_references(user_id, overflow)
        except Exception:
            # RAG 是压缩去重的可选参考，不能把索引/数据库故障升级成记忆压缩失败。
            references = []
        user = (
            f"相关历史事件参考：\n{render_event_references(references)}\n\n"
            f"要追加的近期记录（只从这里提取新增事件，不要丢掉日期）：\n" + "\n".join(overflow) + "\n\n"
            f"请只输出本批次要追加的事件章节。"
        )
        out = await _generate_memory_entries(user, settings)
        additions = normalize_event_memory(
            (out.get("entries") or "").strip(),
            fallback_title=(
                f"{_DATE_RE.search(overflow[0]).group(0)} 事件记录"
                if overflow and _DATE_RE.search(overflow[0]) else "事件记录"
            ),
        )
        additions = deduplicate_event_sections(additions)

        # 防误删兜底：模型返回空或丢掉全部时间锚点 → 不写入，也不裁 daily。
        if not additions or not _preserves_incoming_dates(overflow, additions):
            return False

        memory = await store.append_memory_doc(user_id, additions)
        await store.sync_memory_vecs(user_id, memory)   # 追加后只为新增块补向量（embedding 未启用=no-op）
        # 压缩成功才裁 daily（沉淀的内容已进 memory）
        await store.write_daily_lines(user_id, merge_remaining(recent, remaining))
        return True
    except Exception:
        return False  # 压缩是后台优化，任何失败都不影响主流程
