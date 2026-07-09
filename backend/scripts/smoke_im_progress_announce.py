"""IM 慢工具进度声明 · 冒烟测试（agent/tools/base.py::_maybe_announce_progress + agent/imctx.py）。

跑法：
    cd backend && .venv/bin/python scripts/smoke_im_progress_announce.py   # 退出码 0=全绿，1=有失败

覆盖：
  · 没有 start_message 的工具：任何路径都不发声明
  · web 路径（imctx 未 set）：不发声明
  · IM 路径首次调用慢工具：发声明，且用的是工具 metadata 里的固定/回调文案
  · 同一 Busy Session 内重复调用：只发一次，不重复打扰
  · 新 Busy Session（重新 set_im）：announced 状态重置，可以再发一次
  · 全局开关关闭：即使在 IM 路径也不发
  · 发送失败（worker._send 抛异常）：不影响工具本身，只打日志
"""
import asyncio
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

from agent import imctx
from agent.tools.base import Tool, _maybe_announce_progress
from app.core.config import get_settings

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✅' if cond else '❌'} {name}" + (f"  [{extra}]" if extra and not cond else ""))


class _FakeWorker(types.ModuleType):
    """占位 worker 模块：记录 _send 调用，塞进 sys.modules 让 base.py 里的 `import worker` 命中它。"""

    def __init__(self):
        super().__init__("worker")
        self.calls = []
        self.should_raise = False

    async def _send(self, payload, text):
        if self.should_raise:
            raise RuntimeError("模拟发送失败")
        self.calls.append((payload, text))


_fake_worker = _FakeWorker()
sys.modules["worker"] = _fake_worker


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

    print("【1】没有 start_message 的工具：任何路径都不发声明")
    imctx.clear()
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_no_msg, {})
    check("无 start_message + web 路径 → 不发", len(_fake_worker.calls) == 0)
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_no_msg, {})
    check("无 start_message + IM 路径 → 仍不发", len(_fake_worker.calls) == 0)

    print("【2】web 路径（imctx 未 set）：不发声明")
    imctx.clear()
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("web 路径 → 不发", len(_fake_worker.calls) == 0)

    print("【3】IM 路径首次调用：发声明，文案来自工具 metadata")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("首次调用 → 发了 1 条", len(_fake_worker.calls) == 1, str(_fake_worker.calls))
    check("文案就是工具登记的固定文案", _fake_worker.calls and _fake_worker.calls[0][1] == "我去查一下。")
    check("payload 带上了平台/会话信息", _fake_worker.calls and _fake_worker.calls[0][0].get("platform") == "qq")
    check("发送后 imctx 标记为已声明", imctx.was_announced() is True)

    print("【3b】回调式文案：按 args 生成，且只读 dispatch 时已知参数")
    imctx.set_im("qq", "m2", "c1", "g1", "u1")   # 新 session，重置 announced
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_with_callable_msg, {"query": "今天天气"})
    check("回调文案按 args 渲染正确", _fake_worker.calls and _fake_worker.calls[0][1] == "我去查『今天天气』。")

    print("【4】同一 Busy Session 内重复调用：只发一次")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    await _maybe_announce_progress(tool_with_msg, {})
    await _maybe_announce_progress(tool_with_msg, {})
    check("连调 3 次只发 1 条", len(_fake_worker.calls) == 1, str(_fake_worker.calls))

    print("【5】新 Busy Session（重新 set_im）：announced 重置，可以再发")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("第一个 session 发了 1 条", len(_fake_worker.calls) == 1)
    imctx.set_im("qq", "m2", "c1", "g1", "u1")   # 新一轮消息 = 新 Busy Session
    check("新 session 里 was_announced 已重置", imctx.was_announced() is False)
    await _maybe_announce_progress(tool_with_msg, {})
    check("新 session 里能再发 1 条", len(_fake_worker.calls) == 2)

    print("【6】全局开关关闭：即使在 IM 路径也不发")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    settings.agent.im_progress_announce_enabled = False
    _fake_worker.calls.clear()
    await _maybe_announce_progress(tool_with_msg, {})
    check("开关关闭 → 不发", len(_fake_worker.calls) == 0)
    settings.agent.im_progress_announce_enabled = True

    print("【7】发送失败：不抛出、不影响工具本身（fire-and-forget）")
    imctx.set_im("qq", "m1", "c1", "g1", "u1")
    _fake_worker.should_raise = True
    try:
        await _maybe_announce_progress(tool_with_msg, {})
        check("worker._send 抛异常也不会向上传播", True)
    except Exception as e:
        check("worker._send 抛异常也不会向上传播", False, f"{type(e).__name__}: {e}")
    _fake_worker.should_raise = False

    settings.agent.im_progress_announce_enabled = _orig_enabled
    imctx.clear()

    print(f"\n{len(PASS)} 通过，{len(FAIL)} 失败")
    if FAIL:
        print("失败项：")
        for f in FAIL:
            print(f"  - {f}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
