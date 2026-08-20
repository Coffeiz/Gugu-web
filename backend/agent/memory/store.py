"""记忆存储：读写 {user_id}/.agent/ 下的文件，经 StorageBackend（本地/OSS 通吃）。

不进 File 表，是咕咕私有档案。单库，无 DB/物理同步问题。
- profile.json 用户画像：只回答"这个人是谁"，`{type,text,ts}`——不带 id/kind/conf，不衰减，不参与
  周期复核（内容本来就该稳定）。见 docs/agent/11-记忆系统.md §2。
- pattern.json 行为/决策模式（2b 结构化）：每条带 kind(observed/inferred)/conf/imp/ts，反思增删改、
  注入时按 effective(置信×衰减) 过滤排序；observed=用户亲述不衰减、inferred=推断按半衰期淡出。
  （2026-07-08 从 facts.json 更名而来——profile/pattern 拆分前两者混在一份 facts.json 里，
  见 docs/agent/11-记忆系统.md §2 的教训记录。旧 facts.json / facts.md 首次读取时自动迁移成
  pattern.json；旧文件保留不删，但不再写。）
- daily.md   近期记忆：每次对话提炼的要点，带日期，新在上
- memory.md  长期记忆：daily 老条目压缩沉淀的长期叙述（compress 生成）

daily 不再"满了直接丢"，而是**按累积条数压缩**：攒到 DAILY_COMPACT_AT 触发，
最老的并入 memory.md、daily 留回最近 DAILY_KEEP_RECENT 条（见 compress.py）。
DAILY_HARD_CAP 是压缩失败时的安全上限，但达到上限时仍保留数据并等待下次成功压缩。

本模块是 owner（Web）与 IM group/member 记忆共用的"通用共享层"：IM 记忆合并逻辑
（`im_reflection.py` 的 `_merge_group_profile`/`_merge_profile`）同样复用这里的
`apply_profile_ops`/`apply_pattern_ops`（以及 `_pattern_similar` 相似度判断），
不要误以为本模块是 owner 专属。
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import time

from app.services.storage import get_storage

_DIR = ".agent"
DAILY_KEEP_RECENT = 50   # 压缩后 daily 保留的最近条数（也是注入 prompt 的量）
DAILY_COMPACT_AT  = 100  # daily 达到此条数触发一次压缩
DAILY_HARD_CAP    = 175  # 压缩失败时的硬安全上限，不能静默丢弃历史

# ── 用户画像（profile.json，无需衰减）──
PROFILE_FILE = "profile.json"
PROFILE_TYPES = {"name", "address", "pronoun", "background", "preference", "note"}

# ── 当前状态快照（summary.json：{text,ts} 一个文件，取代旧的 summary.md + summary.ts 两文件）──
SUMMARY_FILE = "summary.json"

# ── 结构化 pattern（2b）参数 ──
PATTERN_FILE                = "pattern.json"
PATTERN_MAINTENANCE_FILE   = "pattern_maintenance.json"
PATTERN_INFERRED_HALF_LIFE  = 45.0   # 推断类 pattern 置信半衰期(天)；observed 不衰减
PATTERN_RETIRE_EFF          = 0.2    # effective 置信低于此 → 不注入（退休淡出）
PATTERN_INJECT_MAX          = 100    # 注入上限；超了优先按相关性挑（向量/词法）、重要度保底+补齐（见 render_pattern）
PATTERN_FLOOR_K             = 6      # 重要度保底：pattern 超上限时，最重要的前 K 条无论是否相关都注入（核心习惯不被相关性挤掉）
PATTERN_REL_CONF_BONUS      = 0.1    # 相关性排序里给置信度的小加成系数（同等相关时更可信的在前）
_PATTERN_DEFAULT_CONF      = {"observed": 0.9, "inferred": 0.6}
_PATTERN_CONFIRM_STEP      = 0.1
_PATTERN_MAX_CONF          = 0.97

# ── memory.md 长期记忆向量检索参数 ──
MEMORY_INJECT_CHARS = 1500   # memory.md 超此字数才走向量挑相关块，否则整块注入（小的没必要检索）
MEMORY_CHUNK_MAX    = 400    # 切块粒度：单块最大字数（超长段按句子边界再切）


def _key(user_id, name: str) -> str:
    return f"{user_id}/{_DIR}/{name}"


async def _read(key: str) -> str:
    try:
        data = await get_storage().get(key)
        return data.decode("utf-8", errors="replace")
    except Exception:
        return ""  # 文件不存在（本地 FileNotFoundError / OSS NoSuchKey）→ 空


async def _write(key: str, text: str) -> None:
    await get_storage().put(key, text.encode("utf-8"), "text/markdown")


async def read_memory(user_id, query: str = "") -> dict:
    """返回 {profile, pattern, memory, daily, summary, summary_ts, stance, stance_ts, lens}，缺失为空串/None。
    profile = 用户画像(身份/稳定喜好，全量注入，不衰减)；pattern = 行为/决策模式(结构化，超上限时按相关性挑)。
    stance = 上轮反思判的相处姿态（= perception.intent），stance_ts 给新鲜度闸用（见 behaviors.select）。
    summary_ts = summary 上次更新的 epoch（给时间衰减用，见 agent/decay.py）。
    lens = 渲染好的「解读镜片」注入块（per-user 解读先验，见 agent/memory/lens.py），无则空串。
    query = 当前用户消息（可选）：pattern 超注入上限时用它做相关性优先挑选，见 render_pattern。
    first_ts = 最早一条 pattern 的 epoch（≈「开始了解 TA」的时间锚点，给注入侧时长计算用——
    时长由系统算好喂模型、禁模型自估，见 proposals/反馈信号系统-设计.md §4.3）。"""
    raw_profile = await read_profile_list(user_id)
    raw_patterns = await read_pattern_list(user_id)
    memory_doc = (await _read(_key(user_id, "memory.md"))).strip()
    # 向量语义检索：pattern 超上限 / memory 超预算 时才动向量。query **只 embed 一次**、两边共用（热路径省调用）。
    # 只认与当前模型 tag 匹配的向量（换过模型的旧向量忽略 → pattern 退回词法、memory 退回整篇，直到重建）。
    pattern_over = len(raw_patterns) > PATTERN_INJECT_MAX
    mem_over   = len(memory_doc) > MEMORY_INJECT_CHARS
    query_vec, pattern_vec_map, mem_vec_map = None, None, None
    if query and (pattern_over or mem_over):
        from agent.memory import embedding as _emb
        if _emb.is_enabled():
            query_vec = await _emb.embed(query)
            if query_vec:
                tag = _emb.model_tag()
                if pattern_over:
                    fv = await read_pattern_vecs(user_id)
                    pattern_vec_map = {k: v.get("v") for k, v in fv.items() if v.get("t") == tag}
                if mem_over:
                    mv = await read_memory_vecs(user_id)
                    mem_vec_map = {k: v.get("v") for k, v in mv.items() if v.get("t") == tag}
    profile = render_profile(raw_profile)   # 无上限，全量注入
    pattern = render_pattern(raw_patterns, query, query_vec if pattern_over else None, pattern_vec_map)  # 有向量走 cosine，无则词法
    memory  = retrieve_memory_block(memory_doc, query_vec if mem_over else None, mem_vec_map)  # 超预算挑相关段，无向量则整篇
    first_ts = min((item.get("ts") for item in raw_patterns if item.get("ts")), default=None)
    daily   = (await _read(_key(user_id, "daily.md"))).strip()
    _sum_doc = await _read_summary_doc(user_id)
    summary, summary_ts = _sum_doc["text"], _sum_doc["ts"]
    stance, stance_ts = await read_stance(user_id)
    from agent.memory import lens as _lens   # 局部导入避免包内循环
    lens_block = await _lens.read_block(user_id)
    return {"profile": profile, "pattern": pattern, "memory": memory, "daily": daily,
            "summary": summary, "summary_ts": summary_ts, "first_ts": first_ts,
            "stance": stance, "stance_ts": stance_ts, "lens": lens_block}


async def read_dynamic_memory(user_id) -> dict:
    """只读取每轮动态尾部需要的 stance/summary，不触碰完整记忆 section。"""
    summary_doc = await _read_summary_doc(user_id)
    stance, stance_ts = await read_stance(user_id)
    return {
        "summary": summary_doc["text"],
        "summary_ts": summary_doc["ts"],
        "stance": stance,
        "stance_ts": stance_ts,
    }


async def read_summary_ts(user_id) -> float | None:
    """summary 上次更新时间（epoch）；无/解析失败返回 None（衰减件按"新鲜"处理）。"""
    return (await _read_summary_doc(user_id))["ts"]


# ── 结构化 pattern：每条 {id,text,kind,conf,imp,ts} ──
def _pattern_id() -> str:
    return secrets.token_hex(3)


def _pattern_norm(s) -> str:
    return "".join(ch for ch in str(s).strip().lstrip("-").strip().lower() if ch.isalnum())


def _pattern_bigrams(s) -> set:
    n = _pattern_norm(s)
    if len(n) < 2:
        return {n} if n else set()
    return {n[i:i + 2] for i in range(len(n) - 1)}


def _pattern_similar(a, b) -> bool:
    """两条行为模式是否相同：归一相等 / 较短(≥6)是较长子串 / bigram Jaccard≥0.7。
    阈值取高(0.7)是刻意保守，宁可留近似重复，也不要误并两条不同的行为模式。"""
    na, nb = _pattern_norm(a), _pattern_norm(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    short, long = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(short) >= 6 and short in long:
        return True
    ba, bb = _pattern_bigrams(a), _pattern_bigrams(b)
    u = len(ba | bb)
    return u > 0 and len(ba & bb) / u >= 0.7


def _pattern_eff(f: dict) -> float:
    """effective 置信 = conf ×（observed 不衰减 / inferred 按半衰期衰减）。"""
    conf = float(f.get("conf", 0.6) or 0.6)
    if f.get("kind") == "inferred":
        from agent import decay
        conf *= decay.weight(f.get("ts"), PATTERN_INFERRED_HALF_LIFE)
    return conf


def _migrate_md(md: str) -> list[dict]:
    """旧 facts.md 各行迁为结构化 pattern（无从判 kind，一律当 observed/中置信）。"""
    now = time.time()
    out = []
    for line in md.splitlines():
        t = line.strip().lstrip("-").strip()
        if t:
            out.append({"id": _pattern_id(), "text": t, "kind": "observed",
                        "conf": 0.75, "imp": 3, "ts": now})
    return out


async def read_pattern_list(user_id) -> list[dict]:
    """读结构化 pattern。pattern.json 不存在 → 依次找旧 facts.json(2026-07-08 前的名字)、
    再旧的 facts.md，找到就迁移并写回 pattern.json(一次性)；旧文件保留不删，但不再写。"""
    raw = await _read(_key(user_id, PATTERN_FILE))
    if not raw.strip():
        raw = await _read(_key(user_id, "facts.json"))   # 拆分前的旧名字，一次性兼容
    if raw.strip():
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                patterns = [item for item in data if isinstance(item, dict) and (item.get("text") or "").strip()]
                if patterns:
                    await write_pattern_list(user_id, patterns)   # 落到新文件名，下次直接命中
                return patterns
        except Exception:
            pass
    md = (await _read(_key(user_id, "facts.md"))).strip()
    if md:
        patterns = _migrate_md(md)
        if patterns:
            await write_pattern_list(user_id, patterns)
        return patterns
    return []


async def write_pattern_list(user_id, patterns: list[dict]) -> None:
    await _write(_key(user_id, PATTERN_FILE), json.dumps(patterns, ensure_ascii=False, indent=2))


async def read_pattern_maintenance(user_id) -> dict:
    """读取自动维护水位；损坏或不存在时返回空状态。"""
    raw = (await _read(_key(user_id, PATTERN_MAINTENANCE_FILE))).strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (TypeError, ValueError):
        return {}


async def write_pattern_maintenance(user_id, state: dict) -> None:
    await _write(_key(user_id, PATTERN_MAINTENANCE_FILE), json.dumps(state, ensure_ascii=False, indent=2))


# ── 用户画像（profile.json）：{type,text,ts}，不带 id/kind/conf，不衰减 ──
async def read_profile_list(user_id) -> list[dict]:
    """读用户画像列表；兼容旧 id 格式，下一次写回时由 writer 清理。"""
    raw = (await _read(_key(user_id, PROFILE_FILE))).strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            normalized = [_normalize_profile_item(p, keep_ts=True) for p in data]
            return [item for item in normalized if item]
    except Exception:
        pass
    return []


async def write_profile_list(user_id, profile: list[dict]) -> None:
    normalized = [_normalize_profile_item(item, keep_ts=True) for item in profile or []]
    normalized = [item for item in normalized if item]
    await _write(_key(user_id, PROFILE_FILE), json.dumps(normalized, ensure_ascii=False, indent=2))


def _normalize_profile_item(item, *, keep_ts: bool) -> dict | None:
    """把新旧 profile 条目统一成 type/text，未知类型按 note 兼容。"""
    if isinstance(item, str):
        text = item.strip()
        item_type = "note"
        ts = None
    elif isinstance(item, dict):
        text = str(item.get("text") or "").strip()
        item_type = str(item.get("type") or "note").strip()
        ts = item.get("ts")
    else:
        return None
    if not text:
        return None
    if item_type not in PROFILE_TYPES:
        item_type = "note"
    result = {"type": item_type, "text": text}
    if keep_ts:
        result["ts"] = ts
    return result


def render_profile(profile: list[dict]) -> str:
    """用户画像 → 注入用 markdown。不做衰减/退休/相关性挑选——profile 预期规模很小，全量注入。"""
    lines = [f"- {p['text'].strip()}" for p in (profile or []) if (p.get("text") or "").strip()]
    return "\n".join(lines)


def apply_profile_ops(profile: list[dict], add, remove) -> list[dict]:
    """对用户画像应用一轮增删；add 兼容旧字符串和新 {type,text} 对象。"""
    out = [_normalize_profile_item(item, keep_ts=True) for item in profile or []]
    out = [item for item in out if item]
    now = time.time()
    rem = [r.get("text") if isinstance(r, dict) else str(r) for r in (remove or [])]
    rem = [r.strip() for r in rem if str(r or "").strip()]
    if rem:
        out = [p for p in out if not any(_pattern_similar(p.get("text", ""), r) for r in rem)]
    for a in (add or []):
        item = _normalize_profile_item(a, keep_ts=False)
        if not item:
            continue
        text, kind = item["text"], item["type"]
        hit = next((p for p in out if _pattern_similar(p.get("text", ""), text)), None)
        if hit:
            hit["ts"] = now
            hit["type"] = kind
            if len(text) > len(hit.get("text", "")):
                hit["text"] = text
        else:
            out.append({"type": kind, "text": text, "ts": now})
    return out


# ── pattern 向量缓存（.agent/pattern_vec.json，key=pattern_id → {"v": [...], "t": model_tag}）──
# 与 pattern.json 分开存：向量体积大、pattern 是热读文件，不该被向量撑肿。文本才是主数据，
# 向量是可重建缓存——换 embedding 模型时 tag 失配即视为过期、可整体重算（见 embedding.py）。
# 改名自 facts_vec.json：纯缓存，没有旧数据也没关系，缺失时按「没缓存」自然重嵌，不用迁移。
PATTERN_VEC_FILE = "pattern_vec.json"


async def read_pattern_vecs(user_id) -> dict:
    """读向量缓存 {pattern_id: {"v": [...], "t": tag}}。不存在/坏 → {}。"""
    raw = await _read(_key(user_id, PATTERN_VEC_FILE))
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


async def write_pattern_vecs(user_id, vecs: dict) -> None:
    await _write(_key(user_id, PATTERN_VEC_FILE), json.dumps(vecs, ensure_ascii=False))


async def sync_pattern_vecs(user_id, patterns: list[dict], force: bool = False) -> None:
    """给 pattern 增量补向量缓存：只 embed 新模式或换模型后的模式，已删模式顺带清掉。
    `force=True`（重建 job 用）→ 无视 tag 全部重算。
    embedding 未启用 → `embed()` 返回 None → 整体 no-op。best-effort，永不抛（反思路径不能被它拖垮）。"""
    from agent.memory import embedding as _emb
    if not _emb.is_enabled():
        return
    try:
        vecs = await read_pattern_vecs(user_id)
        before = len(vecs)
        tag = _emb.model_tag()
        alive = {item.get("id") for item in patterns if item.get("id")}
        vecs = {k: v for k, v in vecs.items() if k in alive}   # GC 已删 pattern 的向量
        changed = len(vecs) != before
        for item in patterns:
            pattern_id, text = item.get("id"), (item.get("text") or "").strip()
            if not pattern_id or not text:
                continue
            c = vecs.get(pattern_id)
            if not force and c and c.get("t") == tag:
                continue   # 已有当前模型的向量，跳过（force 时不跳、全部重算）
            v = await _emb.embed(text)
            if v:
                vecs[pattern_id] = {"v": v, "t": tag}
                changed = True
        if changed:
            await write_pattern_vecs(user_id, vecs)
    except Exception:
        pass


async def rebuild_all_vecs(user_ids, on_progress=None) -> dict:
    """给一批用户 force 重算**pattern + 长期记忆(memory.md)** 的向量（换 embedding 模型后调）。
    复用 `sync_pattern_vecs`/`sync_memory_vecs`（均 force=True）。每个用户独立 try（一个失败不拖垮整批）。
    返回 {done, total, with_patterns}（with_patterns=有 pattern 的用户数；memory 一并重算，不单独计数）。"""
    total, done, with_patterns = len(user_ids), 0, 0
    for uid in user_ids:
        try:
            patterns = await read_pattern_list(uid)
            if patterns:
                await sync_pattern_vecs(uid, patterns, force=True)
                with_patterns += 1
            mem = await read_memory_doc(uid)   # 长期记忆的块向量也一并重建
            if mem:
                await sync_memory_vecs(uid, mem, force=True)
        except Exception:
            pass
        done += 1
        if on_progress:
            try:
                await on_progress(done, total)
            except Exception:
                pass
    return {"done": done, "total": total, "with_patterns": with_patterns}


# ── memory.md（长期记忆）向量检索：切块 + 逐块缓存 + 语义挑相关段 ──
# pattern 天生离散，memory.md 是 compress 融合的一整篇叙述——先切块再 embed；且 compress 每次
# **重写全文**，块文本随之变，用「块文本哈希」当 key：一压，旧哈希 GC、新块补嵌（= 自动重嵌）。
MEMORY_VEC_FILE = "memory_vec.json"


def _chunk_key(text: str) -> str:
    return hashlib.md5(text.strip().encode("utf-8")).hexdigest()[:12]


def _memory_chunks(text: str) -> list[str]:
    """把 memory.md 切成可 embed 的段：先按空行分段，超长段再按句子边界切到 MEMORY_CHUNK_MAX。"""
    text = (text or "").strip()
    if not text:
        return []
    out: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= MEMORY_CHUNK_MAX:
            out.append(para)
            continue
        buf = ""
        for sent in re.split(r"(?<=[。！？!?\n])", para):
            if buf and len(buf) + len(sent) > MEMORY_CHUNK_MAX:
                out.append(buf.strip())
                buf = sent
            else:
                buf += sent
        if buf.strip():
            out.append(buf.strip())
    return [c for c in out if c]


async def read_memory_vecs(user_id) -> dict:
    """读 memory 块向量缓存 {chunk_key: {"v": [...], "t": tag}}。不存在/坏 → {}。"""
    raw = await _read(_key(user_id, MEMORY_VEC_FILE))
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


async def write_memory_vecs(user_id, vecs: dict) -> None:
    await _write(_key(user_id, MEMORY_VEC_FILE), json.dumps(vecs, ensure_ascii=False))


async def sync_memory_vecs(user_id, memory_text: str, force: bool = False) -> None:
    """给 memory.md 的块增量补向量（compress 写完 memory.md 后调）。块文本变/换模型才重嵌，消失的块 GC。
    embedding 未启用 → no-op。best-effort，永不抛。"""
    from agent.memory import embedding as _emb
    if not _emb.is_enabled():
        return
    try:
        chunks = _memory_chunks(memory_text)
        vecs = await read_memory_vecs(user_id)
        before = len(vecs)
        tag = _emb.model_tag()
        alive = {_chunk_key(c) for c in chunks}
        vecs = {k: v for k, v in vecs.items() if k in alive}   # GC 改动/消失的块
        changed = len(vecs) != before
        for c in chunks:
            k = _chunk_key(c)
            cur = vecs.get(k)
            if not force and cur and cur.get("t") == tag:
                continue
            v = await _emb.embed(c)
            if v:
                vecs[k] = {"v": v, "t": tag}
                changed = True
        if changed:
            await write_memory_vecs(user_id, vecs)
    except Exception:
        pass


def retrieve_memory_block(memory_text: str, query_vec, vec_map, budget: int = MEMORY_INJECT_CHARS) -> str:
    """memory.md 语义检索：超预算 + 有 query 向量 → 按 cosine 挑相关块拼到预算内（保原文顺序）；
    否则/无向量/覆盖不足 → 原样返回整篇（= 现有行为，零回归）。"""
    memory_text = (memory_text or "").strip()
    if not query_vec or not vec_map or len(memory_text) <= budget:
        return memory_text
    from agent.memory.embedding import cosine
    chunks = _memory_chunks(memory_text)
    # 覆盖不足（多数块没缓存向量，如刚启用还没重嵌）→ 别乱挑，退回整篇
    covered = sum(1 for c in chunks if vec_map.get(_chunk_key(c)))
    if covered < max(1, len(chunks) // 2):
        return memory_text
    scored = [(cosine(query_vec, vec_map.get(_chunk_key(c)) or []), i, c) for i, c in enumerate(chunks)]
    scored.sort(key=lambda x: -x[0])
    picked, used = [], 0
    for _s, i, c in scored:
        if picked and used + len(c) > budget:
            break
        picked.append((i, c))
        used += len(c)
    picked.sort(key=lambda x: x[0])   # 恢复原文顺序，保叙述连贯
    return "\n\n".join(c for _i, c in picked)


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def render_pattern(patterns: list[dict], query: str = "",
                 query_vec: list[float] | None = None, vec_map: dict | None = None) -> str:
    """结构化 pattern → 注入用 markdown。退休低 effective、低置信推断标「不太确定」。

    选取策略：
    - pattern 未超 `PATTERN_INJECT_MAX` 或没传 query → 全部按 effective×importance 排序注入。
    - 超上限且有当前消息 query → **相关性优先**挑：① 重要度保底（前 `PATTERN_FLOOR_K`，核心习惯不被挤掉）
      → ② 按对 query 的相关性（置信小加成）填充 → ③ 仍没满用重要度补齐（不浪费预算）。
      relevance > importance，但 importance 兜底。
    - **相关性打分**：给了 `query_vec` + `vec_map`（read_memory 在 embedding 启用且超上限时算好）→ 用**向量 cosine**
      （语义）；否则退回**字 bigram 词法**（v1 默认、embedding 未启用时）。没缓存到向量的 pattern → cosine 记 0，
      靠重要度保底/补齐兜住（下轮反思会补上它的向量）。"""
    scored = [(item, _pattern_eff(item)) for item in (patterns or [])]
    scored = [(f, e) for f, e in scored if e >= PATTERN_RETIRE_EFF and (f.get("text") or "").strip()]
    by_imp = sorted(scored, key=lambda x: -(x[1] * (x[0].get("imp", 3) or 3)))

    q = (query or "").strip()
    if not q or len(scored) <= PATTERN_INJECT_MAX:
        chosen = by_imp[:PATTERN_INJECT_MAX]
    else:
        use_vec = query_vec is not None and vec_map is not None
        if use_vec:
            from agent.memory.embedding import cosine
            rel = {id(f): cosine(query_vec, vec_map.get(f.get("id")) or []) for f, _ in scored}
        else:
            qb = _pattern_bigrams(q)
            rel = {id(f): _jaccard(qb, _pattern_bigrams(f.get("text", ""))) for f, _ in scored}
        chosen, picked = [], set()
        for f, e in by_imp[:PATTERN_FLOOR_K]:                      # ① 重要度保底
            chosen.append((f, e)); picked.add(id(f))
        rest = [(f, e) for f, e in scored if id(f) not in picked and rel[id(f)] > 0]
        rest.sort(key=lambda x: -(rel[id(x[0])] + PATTERN_REL_CONF_BONUS * x[1]))
        for f, e in rest:                                        # ② 相关性填充
            if len(chosen) >= PATTERN_INJECT_MAX:
                break
            chosen.append((f, e)); picked.add(id(f))
        for f, e in by_imp:                                      # ③ 重要度补齐（不浪费预算）
            if len(chosen) >= PATTERN_INJECT_MAX:
                break
            if id(f) not in picked:
                chosen.append((f, e)); picked.add(id(f))

    lines = []
    for f, eff in chosen:
        text = f["text"].strip()
        if f.get("kind") == "inferred" and eff < 0.45:
            lines.append(f"- {text}（不太确定）")
        else:
            lines.append(f"- {text}")
    return "\n".join(lines)


def apply_pattern_ops(patterns: list[dict], add, remove) -> list[dict]:
    """对结构化 pattern 应用一轮增删改。add 可为 str（旧式兼容）或 dict{text,kind,importance}：
    命中已有相似条 → **印证**（升 conf、刷新 ts、user 亲述可升级 observed、采更具体文本）；否则新增。
    remove 按相似匹配删除。返回新列表（不就地改入参）。"""
    out = [dict(item) for item in (patterns or [])]
    now = time.time()
    rem = [r for r in (remove or []) if str(r).strip()]
    if rem:
        out = [f for f in out if not any(_pattern_similar(f.get("text", ""), r) for r in rem)]
    for a in (add or []):
        if isinstance(a, dict):
            text = (a.get("text") or "").strip()
            kind = a.get("kind")
            imp = a.get("importance")
        else:
            text, kind, imp = str(a).strip(), None, None
        if not text:
            continue
        kind = kind if kind in ("observed", "inferred") else "inferred"
        hit = next((f for f in out if _pattern_similar(f.get("text", ""), text)), None)
        if hit:
            hit["conf"] = min(_PATTERN_MAX_CONF, float(hit.get("conf", 0.6) or 0.6) + _PATTERN_CONFIRM_STEP)
            hit["ts"] = now
            if kind == "observed":           # 用户亲述 > 推断
                hit["kind"] = "observed"
            if len(text) > len(hit.get("text", "")):
                hit["text"] = text
            if imp:
                hit["imp"] = int(imp)
        else:
            out.append({"id": _pattern_id(), "text": text, "kind": kind,
                        "conf": _PATTERN_DEFAULT_CONF[kind], "imp": int(imp) if imp else 3, "ts": now})
    return out


# ── summary.json（当前状态快照「用户现在在做什么」，反思写）：{text, ts} 一个文件，
# 取代旧的 summary.md（正文）+ summary.ts（更新时间戳）两文件——跟 profile/pattern 一样统一
# 走 JSON，读写只用一次 IO；旧文件不删、只在 summary.json 还没写过时读一次做迁移。
async def _read_summary_doc(user_id) -> dict:
    raw = (await _read(_key(user_id, SUMMARY_FILE))).strip()
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return {"text": (data.get("text") or "").strip(), "ts": data.get("ts")}
        except Exception:
            pass
    # 旧文件迁移（一次性，找到就顺手写回新文件名，下次直接命中）
    text = (await _read(_key(user_id, "summary.md"))).strip()
    ts_raw = (await _read(_key(user_id, "summary.ts"))).strip()
    try:
        ts = float(ts_raw) if ts_raw else None
    except Exception:
        ts = None
    if text:
        await _write(_key(user_id, SUMMARY_FILE), json.dumps({"text": text, "ts": ts}, ensure_ascii=False))
    return {"text": text, "ts": ts}


async def read_summary(user_id) -> str:
    return (await _read_summary_doc(user_id))["text"]


async def write_summary(user_id, text: str) -> None:
    import time
    await _write(_key(user_id, SUMMARY_FILE),
                 json.dumps({"text": text.strip(), "ts": time.time()}, ensure_ascii=False))


# ── temp.json（关系温度：滑动窗口聚合的当下互动质量，memory/temperature.py 算，只喂语气校准）──
async def read_temperature(user_id) -> dict | None:
    raw = (await _read(_key(user_id, "temp.json"))).strip()
    if not raw:
        return None
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


async def write_temperature(user_id, data: dict) -> None:
    await _write(_key(user_id, "temp.json"), json.dumps(data, ensure_ascii=False))


# ── stance.json（本轮相处姿态 = perception.intent；反思写，builder 据此 + 新鲜度点亮行为模块）──
async def read_stance(user_id) -> tuple[str | None, float | None]:
    """返回 (stance, ts)；无/解析失败返回 (None, None)。stance = 上轮反思判的 intent。"""
    raw = (await _read(_key(user_id, "stance.json"))).strip()
    if not raw:
        return None, None
    try:
        d = json.loads(raw)
        s = (d.get("stance") or "").strip() or None
        ts = d.get("ts")
        return s, (float(ts) if ts is not None else None)
    except Exception:
        return None, None


async def write_stance(user_id, stance: str | None) -> None:
    """反思后写本轮 stance（带时间戳，给新鲜度闸用）。空 stance 不写（保留上一个直到过期）。"""
    s = (stance or "").strip()
    if not s:
        return
    import time
    await _write(_key(user_id, "stance.json"),
                 json.dumps({"stance": s, "ts": time.time()}, ensure_ascii=False))


# ── 错读反思记录（全局 md：跨 Redis 持久 + 可下载，已脱敏只留结构）──
_MISREAD_MD_KEY = "_analytics/misread.md"
_MISREAD_MD_CAP = 2000   # 保留最近 N 个反思块，防文件无限增长（误读罕见，够用很久）


async def append_misread(entry_md: str) -> None:
    """把一条（已脱敏的）错读反思块追加进全局 md（新在上）。永不抛、不影响反思。"""
    entry_md = (entry_md or "").strip()
    if not entry_md:
        return
    try:
        cur = await _read(_MISREAD_MD_KEY)
        blocks = [b for b in cur.split("\n\n---\n\n") if b.strip()] if cur.strip() else []
        blocks.insert(0, entry_md)
        await _write(_MISREAD_MD_KEY, "\n\n---\n\n".join(blocks[:_MISREAD_MD_CAP]) + "\n")
    except Exception:
        pass


async def read_misread() -> str:
    """读全局错读反思 md（给下载端点用）。"""
    return (await _read(_MISREAD_MD_KEY)).strip()


# ── memory.md（长期记忆，compress 写）──
async def read_memory_doc(user_id) -> str:
    return (await _read(_key(user_id, "memory.md"))).strip()


async def write_memory_doc(user_id, text: str) -> None:
    await _write(_key(user_id, "memory.md"), text.strip() + "\n")


# ── daily.md（按日期分组渲染；内部仍按「一条记录」计数/压缩）──
_DAILY_HEAD_RE = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})\s*$")
_DAILY_OLD_RE = re.compile(r"^-\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s*$")
_DAILY_BULLET_RE = re.compile(r"^-\s+(.+?)\s*$")


def extract_daily_entries(text: str) -> list[tuple[str, str]]:
    """把新 daily.md 解析成 [(date, note)]。只认 `## 日期` + `- 内容` 分组格式。"""
    entries: list[tuple[str, str]] = []
    current_date = ""
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _DAILY_HEAD_RE.match(line)
        if m:
            current_date = m.group(1)
            continue
        m = _DAILY_BULLET_RE.match(line)
        if m and current_date:
            entries.append((current_date, m.group(1).strip()))
    return [(date, note) for date, note in entries if date and note]


def extract_legacy_daily_entries(text: str) -> list[tuple[str, str]]:
    """旧 daily.md `- YYYY-MM-DD 内容` → [(date, note)]，只给迁移脚本用。"""
    entries: list[tuple[str, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _DAILY_OLD_RE.match(line)
        if m:
            entries.append((m.group(1), m.group(2).strip()))
    return [(date, note) for date, note in entries if date and note]


def _render_daily_entries(entries: list[tuple[str, str]]) -> str:
    """[(date, note)] → daily.md 文本：按日期标题分组，同日多条记在同一组下。"""
    if not entries:
        return ""
    out: list[str] = []
    current_date = None
    for date, note in entries:
        if date != current_date:
            if out:
                out.append("")
            out.append(f"## {date}")
            current_date = date
        out.append(f"- {note}")
    return "\n".join(out).strip() + "\n"


async def read_daily_lines(user_id) -> list[str]:
    existing = await _read(_key(user_id, "daily.md"))
    return [f"- {date} {note}" for date, note in extract_daily_entries(existing)]


async def write_daily_lines(user_id, lines: list[str]) -> None:
    entries: list[tuple[str, str]] = []
    for raw in lines:
        line = str(raw or "").strip()
        if not line:
            continue
        m = _DAILY_OLD_RE.match(line)
        if m:
            entries.append((m.group(1), m.group(2).strip()))
    await _write(_key(user_id, "daily.md"), _render_daily_entries(entries))


async def migrate_legacy_daily(user_id, dry_run: bool = False) -> dict:
    """把旧 daily.md 单行格式迁到按日期分组；运行时不再兼容旧格式，只在维护入口迁一次。"""
    raw = await _read(_key(user_id, "daily.md"))
    if not raw.strip():
        return {"migrated": 0}
    if extract_daily_entries(raw):
        return {"migrated": 0}
    entries = extract_legacy_daily_entries(raw)
    if not entries:
        return {"migrated": 0}
    if not dry_run:
        await _write(_key(user_id, "daily.md"), _render_daily_entries(entries))
    return {"migrated": len(entries), "entries": entries}


async def append_daily(user_id, date: str, note: str) -> None:
    """daily.md 顶部加一条记录；落盘按 `## 日期` 分组，同日多条归到同一标题下面。"""
    note = note.strip()
    if not note:
        return
    lines = await read_daily_lines(user_id)
    lines.insert(0, f"- {date} {note}")
    # 压缩失败时也不能静默丢掉历史；DAILY_HARD_CAP 只作为运维监测阈值，
    # 真正的裁剪必须发生在 memory 成功沉淀之后。
    await write_daily_lines(user_id, lines)
