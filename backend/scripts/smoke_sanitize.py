"""sanitize_messages · 冒烟（tool_use/tool_result 相邻配对）。

跑法：cd backend && .venv/bin/python scripts/smoke_sanitize.py   # 0=全绿

锁死一个真实线上 bug：token 窗口截断 / 删空消息 / 合并同角色会破坏
「assistant(tool_use X) 紧接 user(tool_result X)」相邻配对，留下孤儿 tool_result，
MiniMax 报 `invalid params, tool result's tool id not found` → 用户看到「咕咕开小差了」。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.security.sanitize import sanitize_messages as S

PASS, FAIL = [], []


def check(name, cond):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✅' if cond else '❌'} {name}")


def _blocks(m):
    return m["content"] if isinstance(m.get("content"), list) else []


def _has(r, typ):
    return any(isinstance(b, dict) and b.get("type") == typ for m in r for b in _blocks(m))


def _alt(r):
    return all(r[i]["role"] != r[i + 1]["role"] for i in range(len(r) - 1))


def _no_orphan_result(r):
    prev = set()
    for m in r:
        for b in _blocks(m):
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") not in prev:
                return False
        prev = {b.get("id") for b in _blocks(m) if isinstance(b, dict) and b.get("type") == "tool_use"} if m["role"] == "assistant" else set()
    return True


TU = lambda i: {"type": "tool_use", "id": i, "name": "t", "input": {}}
TR = lambda i: {"type": "tool_result", "tool_use_id": i, "content": "ok"}

# 1) 纯文本不变
r = S([{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}])
check("纯文本两条原样", [m["role"] for m in r] == ["user", "assistant"])

# 2) 头部孤儿 tool_result（对应 tool_use 被截断）→ 丢
r = S([{"role": "user", "content": [TR("X")]}, {"role": "assistant", "content": "hi"}, {"role": "user", "content": "q"}])
check("头部孤儿 result 被丢", (not r or r[0]["role"] == "user") and not _has(r, "tool_result"))

# 3) 合法相邻对保留 + 交替
r = S([{"role": "user", "content": "q"}, {"role": "assistant", "content": [TU("A")]},
       {"role": "user", "content": [TR("A")]}, {"role": "assistant", "content": "done"}])
check("合法对保留", _has(r, "tool_use") and _has(r, "tool_result"))
check("严格交替 + 无孤儿", _alt(r) and _no_orphan_result(r))

# 4) 前导 assistant(tool_use) 必须被丢（首条须 user），其 result 同步剥离
r = S([{"role": "assistant", "content": [TU("A")]}, {"role": "user", "content": [TR("A")]},
       {"role": "assistant", "content": "hi"}, {"role": "user", "content": "q"}])
check("前导对剥离后首条 user", r and r[0]["role"] == "user")
check("剥离后无残留 result", not _has(r, "tool_result"))

# 5) 全局 id 存在但顺序错位（result 在 use 之前）→ 仍判孤儿丢弃
r = S([{"role": "user", "content": [TR("A")]}, {"role": "assistant", "content": [TU("A")]},
       {"role": "user", "content": [TR("A")]}])
check("顺序错位的领头 result 不被全局 id 蒙混", _no_orphan_result(r) and (not r or r[0]["role"] == "user"))

# 6) 空 text block / 空消息丢弃
r = S([{"role": "user", "content": "q"}, {"role": "assistant", "content": ""}, {"role": "user", "content": [{"type": "text", "text": "  "}]}])
check("空消息被丢", all(_blocks(m) or isinstance(m["content"], str) and m["content"].strip() for m in r))

print(f"\n结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
sys.exit(0 if not FAIL else 1)
