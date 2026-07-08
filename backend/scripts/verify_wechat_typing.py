#!/usr/bin/env python3
"""微信 iLink Bot typing 接口最小验证：直调 getconfig + sendtyping，确认真实客户端能看到「正在输入」。

背景（2026-07-09）：
  用户反馈 Minimax / QwenPaw 等 agent 在微信里能显示「正在输入」，Gugu-web 没做。前面调研
  （见 docs/devlog.md 2026-07-09 条目）确认 iLink Bot 协议层有 typing 接口，只是 Gugu-web 的
  `wechat_client.py` 没接。OpenClaw 的 `@tencent-weixin/openclaw-weixin` 已经在用这套：

    POST /ilink/bot/getconfig   → 拿 typing_ticket（每用户缓存 24h）
    POST /ilink/bot/sendtyping  → { status: 1 } 显示 / { status: 2 } 取消

  本脚本**不接 Gugu-web 业务**，纯 stdlib + httpx（项目已有依赖），直调 iLink 看真实客户端
  是否会显示「正在输入」——验证通过再写正式接入。

跑法（参数见下方 `--help`，或环境变量也行）：

  cd backend && .venv/bin/python scripts/verify_wechat_typing.py \
      --bot-token "$BOT_TOKEN" \
      --from-user-id "o9cq800kum_xxx@im.wechat" \
      --context-token "AARzJWAFAAABAAAAAAAp..." \
      --base-url "https://ilinkai.weixin.qq.com"

  其中 context_token 必须来自该 from_user-id 真实发给 bot 的最近一条消息——
  从 worker.py 日志或 iLink getupdates 原始 payload 里抓。同一对 from_user_id + context_token
  输错一对都会让接口直接失败（ret≠0）。

输出：
  · getconfig 响应（含 typing_ticket 长度）
  · sendtyping status=1 响应 → 此时对方微信应显示「对方正在输入…」
  · 按 keepalive 间隔持续重发（默认 5s 一次），总共保持 duration 秒（默认 30s）
  · sendtyping status=2 响应 → 「正在输入」消失

  Ctrl+C 安全退出（finally 里发 status=2 取消，避免对方微信一直挂 typing）。

  退出码：0 = getconfig 成功且至少一次 sendtyping 成功；非 0 = 任一步骤失败。

依赖：项目 .venv 已带 httpx，无新依赖。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any

try:
    import httpx
except ImportError:
    print("❌ 需要 httpx。装一下：pip install httpx", file=sys.stderr)
    sys.exit(2)

# ── iLink Bot API 端点（与 wechat_client.py / OpenClaw 2.4.6 一致）──────────────
DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
CHANNEL_VERSION = "2.0.1"   # 与 wechat_client.py 一致；OpenClaw 用 2.x 也兼容

GETCONFIG_PATH = "ilink/bot/getconfig"
SENDTYPING_PATH = "ilink/bot/sendtyping"

TYPING_ON = 1
TYPING_OFF = 2

# 与 OpenClaw config-cache.ts 一致：每用户 ticket 24h，本脚本不复用所以不缓存
DEFAULT_DURATION_S = 30
DEFAULT_KEEPALIVE_S = 5.0

# 与 wechat_client.py 一致的请求头（X-WECHAT-UIN 防重放）
def _make_headers(bot_token: str) -> dict[str, str]:
    import base64
    import secrets
    uin = base64.b64encode(str(secrets.randbelow(0xFFFFFFFF)).encode()).decode()
    return {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": uin,
        **({"Authorization": f"Bearer {bot_token}"} if bot_token else {}),
    }


def _post(base_url: str, path: str, body: dict, bot_token: str, timeout: float = 15.0) -> dict[str, Any]:
    """同步 POST 一次，返回解析后的 JSON。失败抛异常（带状态码）。"""
    import json
    with httpx.Client(timeout=timeout) as cli:
        r = cli.post(
            f"{base_url.rstrip('/')}/{path}",
            content=json.dumps(body),
            headers=_make_headers(bot_token),
        )
        r.raise_for_status()
        return r.json()


async def _post_async(base_url: str, path: str, body: dict, bot_token: str, timeout: float = 15.0) -> dict[str, Any]:
    """async 版，验证脚本主循环用。"""
    import json
    async with httpx.AsyncClient(timeout=timeout) as cli:
        r = await cli.post(
            f"{base_url.rstrip('/')}/{path}",
            content=json.dumps(body),
            headers=_make_headers(bot_token),
        )
        r.raise_for_status()
        return r.json()


def _step(name: str, ok: bool, detail: str = "") -> bool:
    icon = "✅" if ok else "❌"
    print(f"  {icon} {name}" + (f"  [{detail}]" if detail else ""))
    return ok


async def run(
    bot_token: str,
    from_user_id: str,
    context_token: str,
    base_url: str,
    duration_s: float,
    keepalive_s: float,
) -> int:
    print(f"=== 微信 typing 验证 ===")
    print(f"  base_url       = {base_url}")
    print(f"  from_user_id   = {from_user_id}")
    print(f"  context_token  = {context_token[:20]}...（共 {len(context_token)} 字符）")
    print(f"  duration       = {duration_s}s   keepalive = {keepalive_s}s")
    print()

    # ── 1. getconfig：拿 typing_ticket ──────────────────────────────────────────
    print("[1/3] getconfig → 拿 typing_ticket")
    try:
        cfg = await _post_async(base_url, GETCONFIG_PATH, {
            "ilink_user_id": from_user_id,
            "context_token": context_token,
            "base_info": {"channel_version": CHANNEL_VERSION},
        }, bot_token)
    except Exception as e:
        print(f"  ❌ getconfig 调用失败：{type(e).__name__}: {e}")
        return 2

    if cfg.get("ret") not in (0, None):
        print(f"  ❌ getconfig ret={cfg.get('ret')} errmsg={cfg.get('errmsg')}")
        return 2
    ticket = cfg.get("typing_ticket") or ""
    if not ticket:
        print(f"  ❌ getconfig 没返回 typing_ticket（响应: {cfg}）")
        return 2
    if not _step(f"getconfig 成功，typing_ticket 长度 {len(ticket)}", True):
        return 2

    # ── 2. sendtyping status=1：开始显示「正在输入」 ───────────────────────────
    print(f"\n[2/3] sendtyping status={TYPING_ON} → 让对方微信显示「正在输入」")
    print(f"      👀 现在请打开微信，看 {from_user_id} 这个对话窗口顶部。")
    print(f"      👀 应该看到「对方正在输入…」（或「咕咕正在输入…」，取决于 bot 名）。")

    async def _send_typing(status: int) -> tuple[bool, dict]:
        try:
            r = await _post_async(base_url, SENDTYPING_PATH, {
                "ilink_user_id": from_user_id,
                "typing_ticket": ticket,
                "status": status,
                "base_info": {"channel_version": CHANNEL_VERSION},
            }, bot_token)
            ok = r.get("ret") in (0, None)
            return ok, r
        except Exception as e:
            return False, {"err": f"{type(e).__name__}: {e}"}

    started_at = time.monotonic()
    ok, resp = await _send_typing(TYPING_ON)
    if not ok:
        print(f"  ❌ sendtyping(ON) 失败：{resp}")
        return 3
    print(f"  ✅ sendtyping(ON) 成功（{time.monotonic() - started_at:.2f}s），typing_ticket 有效期开始计时")
    print(f"      ⏱️  接下来每 {keepalive_s:.1f}s 重发一次，共保持 {duration_s:.1f}s（Ctrl+C 安全退出）…")

    # ── 3. keepalive 循环 + 安全退出 ────────────────────────────────────────────
    success_count = 1   # 已经成功发过一次 ON
    deadline = started_at + duration_s
    next_send = started_at + keepalive_s
    exit_code = 0
    try:
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            await asyncio.sleep(min(keepalive_s, deadline - now))
            ok, resp = await _send_typing(TYPING_ON)
            if ok:
                success_count += 1
                elapsed = time.monotonic() - started_at
                print(f"      ↻ keepalive {success_count} 次 @ {elapsed:.1f}s：OK")
            else:
                print(f"      ⚠️  keepalive 失败：{resp}（不影响主流程，继续）")
    except (KeyboardInterrupt, asyncio.CancelledError):
        print(f"\n  ⏹️  收到中断信号，提前结束（已成功 {success_count} 次）")
        exit_code = 130
    finally:
        # 无论怎么退出，都发 OFF 取消 typing，避免对方微信一直挂着
        print(f"\n[3/3] sendtyping status={TYPING_OFF} → 取消「正在输入」")
        ok_off, resp_off = await _send_typing(TYPING_OFF)
        if ok_off:
            print(f"  ✅ sendtyping(OFF) 成功，对话窗口的 typing 状态应已消失")
        else:
            print(f"  ⚠️  sendtyping(OFF) 失败：{resp_off}（可手动忽略或重跑）")
            if exit_code == 0:
                exit_code = 4

    print(f"\n=== 完成：成功发送 {success_count} 次 typing ON ===")
    print(f"💡 验证清单（人工看一眼）：")
    print(f"   1. 微信客户端是否在 [{started_at:.0f} ~ {started_at + duration_s:.0f}] 这段时间内")
    print(f"      对话窗口顶部持续显示「对方正在输入…」？")
    print(f"   2. typing_ticket 在 24h 内是否还能复用（重新跑脚本，不传新 context_token 试试）？")
    print(f"   3. 如果客户端没显示：检查微信版本（iOS ≥ 8.0.70 / Android ≥ 8.69）")
    return exit_code


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="微信 iLink Bot typing 接口最小验证脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--bot-token", default=os.environ.get("WECHAT_BOT_TOKEN", ""),
                   help="iLink Bot 的 bot_token（扫码登录后由 get_qrcode_status 返回，"
                        "也可从 ~/.openclaw/state/openclaw-weixin/accounts/<id>.json 里读）"
                        " [env: WECHAT_BOT_TOKEN]")
    p.add_argument("--from-user-id", default=os.environ.get("WECHAT_FROM_USER_ID", ""),
                   help="目标用户的 ilink_user_id（形如 o9cq800kum_xxx@im.wechat，"
                        "从最近一条 inbound 消息的 from_user_id 字段取）"
                        " [env: WECHAT_FROM_USER_ID]")
    p.add_argument("--context-token", default=os.environ.get("WECHAT_CONTEXT_TOKEN", ""),
                   help="同一条 inbound 消息的 context_token（端到端会话凭证，"
                        "不能复用旧消息的） [env: WECHAT_CONTEXT_TOKEN]")
    p.add_argument("--base-url", default=os.environ.get("WECHAT_BASE_URL", DEFAULT_BASE_URL),
                   help=f"iLink API 地址，默认 {DEFAULT_BASE_URL} [env: WECHAT_BASE_URL]")
    p.add_argument("--duration", type=float, default=DEFAULT_DURATION_S,
                   help=f"保持 typing 状态的总秒数（默认 {DEFAULT_DURATION_S}）")
    p.add_argument("--keepalive", type=float, default=DEFAULT_KEEPALIVE_S,
                   help=f"重发 typing 的间隔秒数（默认 {DEFAULT_KEEPALIVE_S}，与 OpenClaw 一致）")
    args = p.parse_args()

    missing = [n for n, v in [
        ("bot-token", args.bot_token),
        ("from-user-id", args.from_user_id),
        ("context-token", args.context_token),
    ] if not v]
    if missing:
        p.error(f"缺少必需参数: {', '.join('--' + m for m in missing)}（或对应环境变量）")
    return args


if __name__ == "__main__":
    args = _parse_args()
    try:
        code = asyncio.run(run(
            bot_token=args.bot_token,
            from_user_id=args.from_user_id,
            context_token=args.context_token,
            base_url=args.base_url,
            duration_s=args.duration,
            keepalive_s=args.keepalive,
        ))
    except KeyboardInterrupt:
        code = 130
    sys.exit(code)