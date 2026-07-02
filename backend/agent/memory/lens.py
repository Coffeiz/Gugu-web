"""per-user 解读先验（lens）—— 第 4 类「记忆」：怎么读懂这个用户的预判。

和 facts(陈述)/summary(状态)/daily(流水) 不同：lens 是「如何解读 TA」的偏置规则，
例「这人说『随便』其实有偏好、要追问」「TA 说『还行』通常是『不太行』」。
自然语言规则 + 会动的 confidence —— 带「为什么」、可审计、LLM 直接当镜片用。

设计要点（见 docs/agent/感知系统.md §3.5）：
- **事件驱动、非每轮**：从「误判」里学，不从每次对话里学。燃料 = 反思吐的 `lens_hint`
  （模型只在本轮确实暴露了一条**可复用**误读时才给，多数轮为空）。
- **防过拟合双闸**：① 模型自律（多数轮 hint 空）② 候选须**复现**(count≥PROMOTE_AT)才提拔成
  规则——一次性误会不立刻成规则、不学成偏见。
- **confidence 会动**：新规则 NEW_RULE_CONF；被印证 ↑；随时间按半衰期衰减（read 时算
  effective，复用 agent/decay.py）；effective 低于 RETIRE_EFF 退休。
- **注入**：当「解读镜片」**偏置不独裁**，按 effective 选话术档位（笃定 / 多半 / 也许）。
- **存** `.agent/lens.json`（结构化 confidence/候选计数需要 json；注入时渲染成 md，
  同样满足「可审计 / LLM 当镜片读」）。

⚠️ v1 未做：被**反驳**时 confidence↓（可靠识别"这条纠正推翻了哪条已有规则"需 LLM 对齐，
留待后续）；现靠"久不印证→衰减→退休"自然淘汰错规则。
"""
from __future__ import annotations

import json
import re
import time

from agent import decay
from app.services.storage import get_storage

_DIR = ".agent"
_FILE = "lens.json"

LENS_HALF_LIFE = 30.0   # confidence 半衰期(天)：慢变先验，比 summary(5天)慢得多
NEW_RULE_CONF  = 0.6    # 候选提拔成规则时的初始 confidence
CONFIRM_STEP   = 0.1    # 每次被印证 confidence 的增量
MAX_CONF       = 0.95
PROMOTE_AT     = 2      # 候选复现达此次数 → 提拔成正式规则(防过拟合的核心闸)
RETIRE_EFF     = 0.25   # effective confidence 低于此 → 退休(不注入、写盘剪除)
CAND_TTL_DAYS  = 21     # 候选久不复现就丢(防候选池累积噪声)
MAX_RULES      = 12     # 规则数上限，超了剪掉 effective 最低的


def _key(user_id) -> str:
    return f"{user_id}/{_DIR}/{_FILE}"


async def _load(user_id) -> dict:
    try:
        data = await get_storage().get(_key(user_id))
        d = json.loads(data.decode("utf-8"))
    except Exception:
        d = {}   # 文件不存在/损坏 → 空 lens
    if not isinstance(d, dict):
        d = {}
    d.setdefault("rules", [])
    d.setdefault("candidates", [])
    return d


async def _save(user_id, d: dict) -> None:
    await get_storage().put(_key(user_id),
                            json.dumps(d, ensure_ascii=False).encode("utf-8"),
                            "application/json")


def _eff(rule: dict) -> float:
    """effective confidence = 存的 confidence × 时间衰减权重(慢半衰期)。"""
    return float(rule.get("confidence", 0) or 0) * decay.weight(rule.get("last_seen"), LENS_HALF_LIFE)


def _norm(s) -> str:
    """归一化用于相似判断：留字母数字 + 中文(isalnum 对中文为真)，去标点空格。"""
    return "".join(ch for ch in str(s).strip().lower() if ch.isalnum())


def _bigrams(s) -> set:
    n = _norm(s)
    if len(n) < 2:
        return {n} if n else set()
    return {n[i:i + 2] for i in range(len(n) - 1)}


_TRIG_RE = re.compile(r"[「『\"“]([^」』\"”]+)[」』\"”]")


def _trigger(s) -> str:
    """抽规范格式 lens_hint 里的触发语：「没事」→… 取『没事』。无引号则空串。"""
    m = _TRIG_RE.search(str(s))
    return _norm(m.group(1)) if m else ""


def _similar(a, b) -> bool:
    """两条规则是否算「同一条」。规范 lens_hint 形如「触发语」→含义，**触发语是稳定判别键**：
    两条都有触发语时只看触发语是否一致（同义改写靠它收敛、跨触发不误并）；至少一方无触发语
    时退回整句匹配（归一化相等 / 较短≥6 子串 / 字符 bigram Jaccard≥0.5，容插字改写）。"""
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    ta, tb = _trigger(a), _trigger(b)
    if ta and tb:
        if ta == tb:
            return True
        short_t, long_t = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        return len(short_t) >= 2 and short_t in long_t   # 触发语包含即同条；不同触发不算同条
    short, long = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(short) >= 6 and short in long:
        return True
    ba, bb = _bigrams(a), _bigrams(b)
    inter, union = len(ba & bb), len(ba | bb)
    return union > 0 and inter / union >= 0.5


# ── 注入（读） ──
async def read_block(user_id) -> str:
    """渲染当前 lens 为注入用 markdown：只出 effective≥RETIRE_EFF 的规则、按 conf 选话术。
    空则返回空串（builder 不注入、省 token）。纯读、不写盘（维护在 observe 里做）。"""
    d = await _load(user_id)
    scored = sorted(((r, _eff(r)) for r in d.get("rules", [])), key=lambda x: -x[1])
    lines = []
    for r, eff in scored:
        if eff < RETIRE_EFF:
            continue
        rule = (r.get("rule") or "").strip()
        if not rule:
            continue
        if eff >= 0.6:
            lines.append(f"- {rule}")
        elif eff >= 0.4:
            lines.append(f"-（多半）{rule}")
        else:
            lines.append(f"-（也许，留意但别笃定）{rule}")
        if len(lines) >= MAX_RULES:
            break
    if not lines:
        return ""
    return ("## 怎么读懂 TA（解读镜片 · 偏置不独裁）\n"
            "下面是相处里摸出的、读懂这个人的经验先验。用它**偏置**你的理解，"
            "但别当铁律——和当下语境冲突时以当下为准。\n" + "\n".join(lines))


# ── 学习（写，gated） ──
async def observe(user_id, lens_hint: str | None) -> None:
    """反思后调一次。hint 非空 = 模型本轮提了一条可复用解读规则 → 候选/印证；
    无论 hint 有无，都顺带做一次维护(退休过期规则、清陈旧候选)。永不抛、不影响反思。"""
    try:
        d = await _load(user_id)
        changed = _maintain(d)
        hint = (lens_hint or "").strip()
        if hint and len(_norm(hint)) >= 4:
            changed = _ingest(d, hint) or changed
        if changed:
            await _save(user_id, d)
    except Exception:
        pass


def _ingest(d: dict, hint: str) -> bool:
    """把一条 hint 并入：命中已有规则→印证(conf↑)；命中候选→count++(够阈值提拔)；否则新候选。"""
    now = time.time()
    for r in d["rules"]:
        if _similar(r.get("rule", ""), hint):
            r["confidence"] = min(MAX_CONF, float(r.get("confidence", NEW_RULE_CONF) or NEW_RULE_CONF) + CONFIRM_STEP)
            r["last_seen"] = now
            r["hits"] = int(r.get("hits", 0)) + 1
            return True
    for c in d["candidates"]:
        if _similar(c.get("rule", ""), hint):
            c["count"] = int(c.get("count", 1)) + 1
            c["last_seen"] = now
            if c["count"] >= PROMOTE_AT:   # 复现达标 → 提拔成正式规则
                d["candidates"].remove(c)
                d["rules"].append({"rule": c.get("rule") or hint,
                                   "confidence": NEW_RULE_CONF, "last_seen": now, "hits": 1})
                if len(d["rules"]) > MAX_RULES:
                    d["rules"].sort(key=_eff, reverse=True)
                    del d["rules"][MAX_RULES:]
            return True
    d["candidates"].append({"rule": hint, "count": 1, "last_seen": now})
    return True


def _maintain(d: dict) -> bool:
    """退休 effective 太低的规则 + 清掉久不复现的候选。返回是否有变动。"""
    now = time.time()
    before = (len(d["rules"]), len(d["candidates"]))
    d["rules"] = [r for r in d["rules"] if _eff(r) >= RETIRE_EFF]
    d["candidates"] = [c for c in d["candidates"]
                       if (now - float(c.get("last_seen", now) or now)) / 86400.0 <= CAND_TTL_DAYS]
    return (len(d["rules"]), len(d["candidates"])) != before
