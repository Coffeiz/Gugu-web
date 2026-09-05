"""运维指标聚合（商用就绪评审 P0-4）：工具失败率 / 延迟分布，按日落 Redis。

数据源是 dispatch 的工具调用漏斗（agent/tools/base.py `_log_traj` 旁路）——每次工具
调用 fire-and-forget 累计三类计数，绝不阻塞、绝不因指标影响工具本身：

- `ops:tool:{YYYYMMDD}`  hash：`{tool}:calls` / `{tool}:fails` / `{tool}:ms_sum`
  → 每工具的调用量、失败率、平均耗时
- `ops:lat:{YYYYMMDD}`   hash：延迟桶（ms 上界为 field）计数
  → 全局延迟分布 + P99 近似（桶插值）
- key TTL 14 天，自动滚动过期，不用清理任务

查询走 /admin/ops/summary（app/api/v1/ops_admin.py）。这是「从日志到看板」的最小
闭环：先让失败率/延迟可见，告警在此之上做阈值检查。
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone

# 测试隔离：pytest 里 dispatch/get_owned 的越权用例会触发这些旁路，若真写就污染生产 Redis
# 的 ops 计数（测试连的是真 devserver Redis）。检测到 pytest 在跑就整体禁写。
_DISABLED = "pytest" in sys.modules

TTL = 14 * 24 * 3600
# 延迟桶上界（ms）；"inf" 收尾。P99 用桶上界近似（偏保守，够运维用）
BUCKETS = (50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000)


def _day() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def _bucket(ms: int) -> str:
    for b in BUCKETS:
        if ms <= b:
            return str(b)
    return "inf"


async def _incr(tool: str, ok: bool, ms: int) -> None:
    from app.core.redis import get_redis
    r = get_redis()
    day = _day()
    tk, lk = f"ops:tool:{day}", f"ops:lat:{day}"
    pipe = r.pipeline(transaction=False)
    pipe.hincrby(tk, f"{tool}:calls", 1)
    if not ok:
        pipe.hincrby(tk, f"{tool}:fails", 1)
    pipe.hincrby(tk, f"{tool}:ms_sum", ms)
    pipe.hincrby(lk, _bucket(ms), 1)
    pipe.expire(tk, TTL)
    pipe.expire(lk, TTL)
    await pipe.execute()


def record_tool(tool: str, ok: bool, ms: int) -> None:
    """dispatch 旁路调用：fire-and-forget，任何异常吞掉（指标绝不影响工具执行）。"""
    if _DISABLED:
        return
    async def _run():
        try:
            await _incr(tool, ok, ms)
        except Exception:
            pass
    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        pass   # 无运行中的 loop（同步上下文/测试）：跳过，指标是 best-effort


# ── 安全事件计数（正常应恒为 0，非零即需关注）──────────────────────────────
# ownership.denied：越权访问被拦（模型幻觉他人 id / 有人探测）
# confirm-gate.bypassed：不可逆工具未经确认执行了（确认门被绕，已无法撤销）
SECURITY_EVENTS = (
    "ownership.denied",
    "confirm-gate.bypassed",
    "security_event.write_failed",
    "filesystem.authorization.denied",
)

FILESYSTEM_AUTH_OUTCOMES = ("requested", "granted", "revoked", "denied")


def record_filesystem_authorization(outcome: str, subject_type: str) -> None:
    """记录沙箱授权生命周期指标；只接受固定枚举，不写入主体或路径。"""
    if _DISABLED or outcome not in FILESYSTEM_AUTH_OUTCOMES:
        return
    subject = subject_type if subject_type in {"session", "scheduled_task"} else "unknown"

    async def _run():
        try:
            from app.core.redis import get_redis
            r = get_redis()
            key = f"ops:filesystem-auth:{_day()}"
            await r.hincrby(key, f"{subject}:{outcome}", 1)
            await r.expire(key, TTL)
        except Exception:
            pass

    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        pass


def record_security(event: str) -> None:
    """安全事件旁路计数：fire-and-forget，异常自吞。event 见 SECURITY_EVENTS。"""
    if _DISABLED:
        return
    async def _run():
        try:
            from app.core.redis import get_redis
            r = get_redis()
            k = f"ops:sec:{_day()}"
            await r.hincrby(k, event, 1)
            await r.expire(k, TTL)
        except Exception:
            pass
    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        pass


def record_email(status: str, elapsed_ms: int, error_code: str | None = None) -> None:
    """记录邮件投递的脱敏结果与耗时，不写入收件人、主题或正文。

    ``status`` 只允许 ``sent``/``failed``，失败原因使用服务端定义的错误码。
    统计旁路必须永远不影响实际发信。
    """
    if _DISABLED:
        return

    async def _run():
        try:
            from app.core.redis import get_redis
            r = get_redis()
            k = f"ops:email:{_day()}"
            pipe = r.pipeline(transaction=False)
            pipe.hincrby(k, "calls", 1)
            pipe.hincrby(k, "sent" if status == "sent" else "failed", 1)
            if error_code:
                pipe.hincrby(k, f"error:{error_code}", 1)
            pipe.hincrby(k, "ms_sum", max(0, int(elapsed_ms)))
            pipe.expire(k, TTL)
            await pipe.execute()
        except Exception:
            pass

    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        pass


async def summary(days: int = 1) -> dict:
    """近 N 天聚合：每工具 调用量/失败数/失败率/平均耗时 + 全局延迟分布与 P99 近似。"""
    from datetime import timedelta
    from app.core.redis import get_redis
    r = get_redis()
    tools: dict[str, dict] = {}
    lat: dict[str, int] = {}
    now = datetime.now(timezone.utc)
    for i in range(max(1, days)):
        day = (now - timedelta(days=i)).strftime("%Y%m%d")
        th = await r.hgetall(f"ops:tool:{day}") or {}
        for k, v in th.items():
            tool, _, kind = k.rpartition(":")
            d = tools.setdefault(tool, {"calls": 0, "fails": 0, "ms_sum": 0})
            d[kind] = d.get(kind, 0) + int(v)
        lh = await r.hgetall(f"ops:lat:{day}") or {}
        for b, v in lh.items():
            lat[b] = lat.get(b, 0) + int(v)

    sec = {e: 0 for e in SECURITY_EVENTS}
    for i in range(max(1, days)):
        day = (now - timedelta(days=i)).strftime("%Y%m%d")
        sh = await r.hgetall(f"ops:sec:{day}") or {}
        for e, v in sh.items():
            sec[e] = sec.get(e, 0) + int(v)

    email = {"calls": 0, "sent": 0, "failed": 0, "ms_sum": 0, "errors": {}}
    for i in range(max(1, days)):
        day = (now - timedelta(days=i)).strftime("%Y%m%d")
        eh = await r.hgetall(f"ops:email:{day}") or {}
        for key, value in eh.items():
            value = int(value)
            if key.startswith("error:"):
                email["errors"][key[6:]] = email["errors"].get(key[6:], 0) + value
            elif key in {"calls", "sent", "failed", "ms_sum"}:
                email[key] += value
    email["avg_ms"] = int(email["ms_sum"] / email["calls"]) if email["calls"] else 0
    email["fail_rate"] = round(email["failed"] / email["calls"], 4) if email["calls"] else 0.0

    filesystem_authorization = {
        subject: {outcome: 0 for outcome in FILESYSTEM_AUTH_OUTCOMES}
        for subject in ("session", "scheduled_task")
    }
    for i in range(max(1, days)):
        day = (now - timedelta(days=i)).strftime("%Y%m%d")
        auth_hash = await r.hgetall(f"ops:filesystem-auth:{day}") or {}
        for key, value in auth_hash.items():
            subject, _, outcome = str(key).partition(":")
            if subject in filesystem_authorization and outcome in FILESYSTEM_AUTH_OUTCOMES:
                filesystem_authorization[subject][outcome] += int(value)

    rows = []
    for tool, d in tools.items():
        calls = d.get("calls", 0) or 0
        fails = d.get("fails", 0) or 0
        rows.append({
            "tool": tool, "calls": calls, "fails": fails,
            "fail_rate": round(fails / calls, 4) if calls else 0.0,
            "avg_ms": int(d.get("ms_sum", 0) / calls) if calls else 0,
        })
    rows.sort(key=lambda x: (-x["fails"], -x["calls"]))

    total = sum(lat.values())
    p99 = None
    if total:
        acc = 0
        for b in [str(x) for x in BUCKETS] + ["inf"]:
            acc += lat.get(b, 0)
            if acc >= total * 0.99:
                p99 = None if b == "inf" else int(b)
                break
    total_calls = sum(x["calls"] for x in rows)
    total_fails = sum(x["fails"] for x in rows)
    return {
        "days": days,
        "total_calls": total_calls,
        "total_fails": total_fails,
        "fail_rate": round(total_fails / total_calls, 4) if total_calls else 0.0,
        "p99_ms": p99,             # None = 超过最大桶（>30s）或无数据
        "latency_buckets": {b: lat.get(b, 0) for b in [str(x) for x in BUCKETS] + ["inf"]},
        "tools": rows,
        "security": sec,           # 安全旁路计数：正常应恒为 0
        "filesystem_authorization": filesystem_authorization,
        "email_delivery": email,   # 只含计数/耗时/错误码，不含邮件内容或地址
    }
