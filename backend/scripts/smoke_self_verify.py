"""自我核实闭环 · 冒烟测试（无 API 成本，可反复跑）。

跑法：
    cd backend && . .venv/bin/activate
    python scripts/smoke_self_verify.py        # 退出码 0=全绿，1=有失败

在接缝处打桩（_stream_round / OpenAI client / registry.dispatch），用脚本化假回复驱动 core.py
的真实工具循环，断言：
  · 做过增删改 → 收尾强制核实阶段；只读任务不触发；反复改封顶 MAX_VERIFY。
  · 【抑制】核实阶段干净通过 → 它的确认文字不刷给用户（不再"重复说一遍差不多的话"）。
  · 【抑制】核实阶段发现并补做 → 把"发现漏了X"说明发一次；之后核对文字仍静默。
  · Anthropic / OpenAI 两路同构。
"""
import asyncio, json, collections, os, sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

import agent.core as core
from agent.tools import registry
from agent.core import LLMRunner, _VERIFY_PROMPT, MAX_VERIFY

PASS, FAIL = [], []
def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✅' if cond else '❌'} {name}" + (f"  [{extra}]" if extra and not cond else ""))

# ── 假 Anthropic 消息块 ───────────────────────────────────────────────
class TU:  # tool_use
    type = "tool_use"
    def __init__(s, name, i, inp): s.name, s.id, s.input = name, i, inp
    def model_dump(s): return {"type": "tool_use", "name": s.name, "id": s.id, "input": s.input}
class TX:  # text
    type = "text"
    def __init__(s, t): s.text = t
    def model_dump(s): return {"type": "text", "text": s.text}
def msg(blocks):
    return SimpleNamespace(content=blocks,
        usage=SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0))

# ── 通用打桩 ──────────────────────────────────────────────────────────
DISPATCHED = []
async def fake_dispatch(uid, name, inp):
    DISPATCHED.append(name)
    return (f"ok:{name}", None)
registry.dispatch = fake_dispatch
registry.anthropic_schemas = lambda names: []
registry.openai_schemas = lambda names: []
registry.labels = lambda: {}

AI = SimpleNamespace(model="fake", base_url="http://local", api_key="dummy",
                     max_tokens=100, temperature=0.7, thinking="disabled")

def make_runner():
    return LLMRunner(tool_names=[], settings=SimpleNamespace(ai=AI))

async def drain(gen):
    """跑完 SSE 生成器：返回 (事件计数, 流式出去的全部 token 文本)。"""
    ev = collections.Counter()
    text = []
    async for chunk in gen:
        try:
            d = json.loads(chunk[len("data: "):])
        except Exception:
            continue
        ev[d.get("type")] += 1
        if d.get("type") == "token":
            text.append(d.get("content", ""))
    return ev, "".join(text)

def patch_anthropic(script):
    q = collections.deque(script)
    async def fake_stream_round(client, kwargs, adapter=None):
        m = q.popleft()
        txt = "".join(b.text for b in m.content if b.type == "text") or ""
        if txt:
            yield ("token", txt)
        yield ("final", m)
    core._stream_round = fake_stream_round

def n_verify(messages):
    return sum(1 for m in messages if m.get("content") == _VERIFY_PROMPT)


async def scenario_clean():
    print("\n【场景1 · Anthropic】干净通过 → 核实阶段确认文字被抑制（核心诉求）")
    DISPATCHED.clear()
    patch_anthropic([
        msg([TX("好的"), TU("create_project", "1", {})]),          # R1 建（带字）
        msg([TX("建好了项目X，3阶段5待办 ✅")]),                    # R2 收尾确认 → 触发核实
        msg([TX("我来核实一下"), TU("get_project", "2", {})]),     # R3 核实：查（只读）
        msg([TX("已核实，项目X的3阶段5待办都在 ✅")]),             # R4 核实确认（干净）→ 应被抑制
    ])
    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    check("第一条确认正常显示", "建好了项目X" in text)
    check("核实确认「已核实…」被抑制（不重复刷屏）", "已核实" not in text, f"text={text!r}")
    check("核实过程「我来核实一下」也被抑制", "我来核实一下" not in text)
    check("核实确实跑了（调了 get_project）", "get_project" in DISPATCHED)
    check("注入 1 次系统自检", n_verify(messages) == 1)
    check("正常收尾、无报错", ev["_usage"] == 1 and ev["error"] == 0)

async def scenario_fix():
    print("\n【场景2 · Anthropic】核实发现漏 → 只发一次「发现漏了X」，其余静默")
    DISPATCHED.clear()
    patch_anthropic([
        msg([TX("好的"), TU("create_project", "1", {})]),          # R1 建
        msg([TX("建好了 ✅")]),                                     # R2 收尾 → 核实
        msg([TU("get_project", "2", {})]),                         # R3 核实：查（只读，无字）
        msg([TX("发现漏了一个待办，补一下"), TU("add_todo", "3", {})]),  # R4 发现+补 → 说明应发出
        msg([TU("get_project", "4", {})]),                         # R5 复查（只读）
        msg([TX("好了，补全了")]),                                 # R6 → 因补做过会再触发一轮核实
        msg([TU("get_project", "5", {})]),                         # R7 复查
        msg([TX("都核实过了")]),                                   # R8 干净确认 → 抑制
    ])
    messages = [{"role": "user", "content": "建个项目"}]
    ev, text = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    check("第一条确认正常显示", "建好了" in text)
    check("修正说明「发现漏了一个待办」发出来了", "发现漏了一个待办" in text, f"text={text!r}")
    check("补做确实执行（add_todo）", "add_todo" in DISPATCHED)
    check("中间「好了，补全了」被抑制", "好了，补全了" not in text)
    check("最终「都核实过了」被抑制", "都核实过了" not in text)
    check("注入 2 次系统自检（补做触发再核实）", n_verify(messages) == 2, f"实际 {n_verify(messages)}")
    check("正常收尾、无报错", ev["_usage"] == 1 and ev["error"] == 0)

async def scenario_readonly():
    print("\n【场景3 · Anthropic】纯查询任务：不触发核实、正文正常显示")
    DISPATCHED.clear()
    patch_anthropic([
        msg([TU("get_project", "1", {})]),
        msg([TX("这个项目现在有3个阶段")]),
    ])
    messages = [{"role": "user", "content": "看看进度"}]
    ev, text = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    check("正文正常显示", "这个项目现在有3个阶段" in text)
    check("没有注入系统自检", n_verify(messages) == 0)
    check("正常收尾", ev["_usage"] == 1)

async def scenario_cap():
    print("\n【场景4 · Anthropic】反复补做 → 封顶 MAX_VERIFY，不报错")
    DISPATCHED.clear()
    # 注入只在"纯文字收尾轮 + 做过增删改"时发生 → 用「建/补(工具) → 确认(文字)」交替逼出多轮核实
    script = [
        msg([TU("create_project", "0", {})]),   # R1 建（tool）→ did_mutate
        msg([TX("建好了")]),                      # R2 文字收尾 → 注入核实①
    ]
    for i in range(5):                           # 每轮核实都"又补一刀"，应被封顶在 MAX_VERIFY
        script.append(msg([TU("update_todo", f"u{i}", {})]))  # 核实里补做（mutate）
        script.append(msg([TX(f"补了{i}")]))                   # 文字收尾 → 注入下一轮核实（够 3 次后不再注入）
    patch_anthropic(script)
    messages = [{"role": "user", "content": "建项目并补全"}]
    ev, text = await drain(make_runner()._run_anthropic("u", "sys", messages, AI))
    check(f"注入封顶 {MAX_VERIFY} 次", n_verify(messages) == MAX_VERIFY, f"实际 {n_verify(messages)}")
    check("正常收尾、没撞轮次上限报错", ev["_usage"] == 1 and ev["error"] == 0)

async def scenario_openai_clean():
    print("\n【场景5 · OpenAI】干净通过 → 确认文字被抑制（两路同构）")
    DISPATCHED.clear()
    def text_chunks(t):
        return [SimpleNamespace(usage=None, choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=t, tool_calls=None))]),
                SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5), choices=[])]
    def tool_chunks(name, t=None):
        ch = []
        if t:
            ch.append(SimpleNamespace(usage=None, choices=[SimpleNamespace(
                delta=SimpleNamespace(content=t, tool_calls=None))]))
        tc = SimpleNamespace(index=0, id=f"c_{name}", function=SimpleNamespace(name=name, arguments="{}"))
        ch.append(SimpleNamespace(usage=None, choices=[SimpleNamespace(
            delta=SimpleNamespace(content=None, tool_calls=[tc]))]))
        ch.append(SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5), choices=[]))
        return ch
    rounds = collections.deque([
        tool_chunks("create_project", "好的"),   # R1 建
        text_chunks("建好啦项目X ✅"),            # R2 收尾 → 核实
        tool_chunks("get_project", "核对中"),     # R3 核实查（只读）
        text_chunks("已核实，都建好了"),          # R4 干净确认 → 抑制
    ])
    class FakeCompletions:
        async def create(self, **kw):
            data = rounds.popleft()
            async def agen():
                for c in data: yield c
            return agen()
    class FakeOpenAI:
        def __init__(self, **kw): self.chat = SimpleNamespace(completions=FakeCompletions())
    import openai
    openai.AsyncOpenAI = FakeOpenAI

    messages = [{"role": "user", "content": "建个项目X"}]
    ev, text = await drain(make_runner()._run_openai("u", messages, AI))
    check("第一条确认正常显示", "建好啦项目X" in text)
    check("核实确认「已核实…」被抑制", "已核实" not in text, f"text={text!r}")
    check("核对过程「核对中」被抑制", "核对中" not in text)
    check("核实确实跑了（get_project）", "get_project" in DISPATCHED)
    check("正常收尾、无报错", ev["_usage"] == 1 and ev["error"] == 0)


async def main():
    await scenario_clean()
    await scenario_fix()
    await scenario_readonly()
    await scenario_cap()
    await scenario_openai_clean()
    print(f"\n{'='*52}\n通过 {len(PASS)} / {len(PASS)+len(FAIL)}",
          "✅ 全绿" if not FAIL else f"❌ 失败: {FAIL}")
    return 1 if FAIL else 0

raise SystemExit(asyncio.run(main()))
