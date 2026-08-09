"""IM 慢工具进度声明 · 冒烟测试（agent/tools/base.py::_maybe_announce_progress + agent/imctx.py）。

跑法：
    cd backend && .venv/bin/python scripts/smoke_im_progress_announce.py   # 退出码 0=全绿，1=有失败

覆盖：
  · 没有 start_message 的工具：任何路径都不发声明
  · web 路径（imctx 未 set）：不发声明
  · 定时任务路径（set_im 但 message_id=None）：不发声明
  · IM 路径首次调用慢工具：发声明，且用的是工具 metadata 里的固定/回调文案
  · 同一 Busy Session 内重复调用：只发一次，不重复打扰
  · 新 Busy Session（重新 set_im）：announced 状态重置，可以再发一次
  · 全局开关关闭：即使在 IM 路径也不发
  · 发送失败（send_text 抛异常）：不影响工具本身，只打日志

说明：_maybe_announce_progress 实际通过 agent.im.replies.send_text 发送（send_text →
send_reply → 各平台 gateway），不经过 worker。因此这里 mock 的是 send_text，而不是
塞占位 worker 模块（旧实现拦截 `import worker` 已失效，见 git 历史）。
"""
import asyncio
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

from agent.im import imctx
from agent.tools.base import Tool, _maybe_announce_progress
from app.core.config import get_settings

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✅' if cond else '❌'} {name}" + (f"  [{extra}]" if extra and not cond else ""))


# 记录 send_text 调用；should_raise=True 时模拟发送失败。
sent: list = []
should_raise = False


async def _fake_send_text(payload, text):
    if should_raise:
        raise RuntimeError("模拟发送失败")
    sent.append((payload, text))
    return True


async def main():
    settings = get_settings()
    _orig_enabled = settings.agent.im_progress_announce_enabled
    settings.agent.im_progress_announce_enabled = True

    tool_with_msg = Tool(
        name="_smoke_slow_tool", description="测试用慢工具", input_schema={"type": "object", "properties": {}},
        handler=lambda db, uid, args: None, start_message="我去查一下。",
    )
    tool_with_callable_msg = Tool(
        name="_smoke_slow_tool2", description="测试用慢工具（回调文案）", input_schema={"type": "object", "properties": {}},
        handler=lambda db, uid, args: None, start_message=lambda args: f"我去查『{args.get('query')}』。",
    )
    tool_no_msg = Tool(
        name="_smoke_fast_tool", description="测试用快工具", input_schema={"type": "object", "properties": {}},
        handler=lambda db, uid, args: None,
    )

    global should_raise
    with patch("agent.im.replies.send_text", _fake_send_text):
        await _run_cases(settings, tool_with_msg, tool_with_callable_msg, tool_no_msg)

    settings.agent.im_progress_announce_enabled = _orig_enabled
    imctx.clear()

    print(f"\n{len(PASS)} 通过，{len(FAIL)} 失败")
    if FAIL:
        print("失败项：")
        for f in FAIL:
            print(f"  - {f}")
    return 0 if not FAIL else 1


async def _run_cases(settings, tool_with_msg, tool_with_callable_msg, tool_no_msg):
    global should_raise
    print("【1】没有 start_message 的工具：任何路径都不发声明")
    imctx.clear()
    sent.clear()
    await _maybe_announce_progress(tool_no_msg, {})
    check("无 start_message + web 路径 → 不发", len(sent) == 0)
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    sent.clear()
    await _maybe_announce_progress(tool_no_msg, {})
    check("无 start_message + IM 路径 → 仍不发", len(sent) == 0)

    print("【2】web 路径（imctx 未 set）：不发声明")
    imctx.clear()
    sent.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("web 路径 → 不发", len(sent) == 0)

    print("【2b】定时任务路径（set_im 但 message_id=None）：不发声明")
    imctx.set_im("qq", None, "c1", "g1", "u1", chat_type="group")   # 群定时任务：无具体触发消息
    sent.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("message_id=None → 不发", len(sent) == 0)

    print("【3】IM 路径首次调用：发声明，文案来自工具 metadata")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    sent.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("首次调用 → 发了 1 条", len(sent) == 1, str(sent))
    check("文案就是工具登记的固定文案", sent and sent[0][1] == "我去查一下。")
    check("payload 带上了平台/会话信息", sent and sent[0][0].get("platform") == "qq")
    check("发送后 imctx 标记为已声明", imctx.was_announced() is True)

    print("【3b】回调式文案：按 args 生成，且只读 dispatch 时已知参数")
    imctx.set_im("qq", "m2", "c1", "g1", "u1")   # 新 session，重置 announced
    sent.clear()
    await _maybe_announce_progress(tool_with_callable_msg, {"query": "今天天气"})
    check("回调文案按 args 渲染正确", sent and sent[0][1] == "我去查『今天天气』。")

    print("【4】同一 Busy Session 内重复调用：只发一次")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    sent.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    await _maybe_announce_progress(tool_with_msg, {})
    await _maybe_announce_progress(tool_with_msg, {})
    check("连调 3 次只发 1 条", len(sent) == 1, str(sent))

    print("【5】新 Busy Session（重新 set_im）：announced 重置，可以再发")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    sent.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("第一个 session 发了 1 条", len(sent) == 1)
    imctx.set_im("qq", "m2", "c1", "g1", "u1")   # 新一轮消息 = 新 Busy Session
    check("新 session 里 was_announced 已重置", imctx.was_announced() is False)
    await _maybe_announce_progress(tool_with_msg, {})
    check("新 session 里能再发 1 条", len(sent) == 2)

    print("【6】全局开关关闭：即使在 IM 路径也不发")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    settings.agent.im_progress_announce_enabled = False
    sent.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("开关关闭 → 不发", len(sent) == 0)
    settings.agent.im_progress_announce_enabled = True

    print("【7】发送失败：不抛出、不影响工具本身（fire-and-forget）")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    should_raise = True
    try:
        await _maybe_announce_progress(tool_with_msg, {})
        check("send_text 抛异常也不会向上传播", True)
    except Exception as e:
        check("send_text 抛异常也不会向上传播", False, f"{type(e).__name__}: {e}")
    should_raise = False


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
