"""自我核实闭环 · 冒烟测试（无 API 成本，可反复跑）。

跑法：
    cd backend && . .venv/bin/activate
    python scripts/smoke_self_verify.py        # 退出码 0=全绿，1=有失败

做法：在接缝处打桩（_stream_round / OpenAI client / registry.dispatch），
用脚本化的假 LLM 回复驱动 core.py 的**真实工具循环**，断言核实闭环行为：
  · 做过增删改 → 收尾强制注入「系统自检」轮
  · 自检轮补做(再调增删改) → 再触发一轮；只查没改 → 通过即停（不是固定3轮）
  · 反复改 → 封顶 MAX_VERIFY 轮、不报"太多没做完"错误
  · 只读任务零额外开销（不触发）
  · Anthropic / OpenAI 两路同构
"""
import asyncio, json, collections, os, sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

import agent.core as core
from agent.skills import registry
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
    ev = collections.Counter()
    async for chunk in gen:
        try:
            ev[json.loads(chunk[len("data: "):]).get("type")] += 1
        except Exception:
            pass
    return ev

def patch_anthropic(script):
    q = collections.deque(script)
    async def fake_stream_round(client, kwargs):
        m = q.popleft()
        txt = "".join(b.text for b in m.content if b.type == "text") or ""
        if txt:
            yield ("token", txt)
        yield ("final", m)
    core._stream_round = fake_stream_round

def count_verify(messages):
    return sum(1 for m in messages if m.get("content") == _VERIFY_PROMPT)


async def scenario_A():
    print("\n【场景A · Anthropic】复杂建项目→核实发现不全→补做→二次核实通过")
    DISPATCHED.clear()
    patch_anthropic([
        msg([TX("好，我来建项目"), TU("create_project", "1", {"name": "上线计划"}),
             TU("add_stage", "2", {}), TU("add_todo", "3", {})]),          # R1 增删改×3
        msg([TX("项目建好了，三个待办都加了 ✅")]),                          # R2 收尾 → 触发核实1
        msg([TU("get_project", "4", {}), TU("add_todo", "5", {})]),         # R3 核实：查证+补1个 → 再触发
        msg([TX("发现少了一个待办，已补上")]),                              # R4 收尾 → 触发核实2
        msg([TU("get_project", "6", {})]),                                  # R5 核实：只查证，无改动
        msg([TX("已核实，阶段和待办都齐了")]),                              # R6 收尾 → did_mutate=False → 结束
    ])
    messages = [{"role": "user", "content": "帮我建个上线计划项目，分几个阶段"}]
    ev = await drain(make_runner()._run_anthropic("u1", "sys", messages, AI))
    check("注入了 2 次系统自检", count_verify(messages) == 2, f"实际 {count_verify(messages)}")
    check("核实轮真用查询工具(get_project ×2)", DISPATCHED.count("get_project") == 2)
    check("补做被执行(add_todo ×2)", DISPATCHED.count("add_todo") == 2)
    check("正常收尾(有 _usage)", ev["_usage"] == 1)
    check("无报错事件", ev["error"] == 0)
    check("_new_round = 工具轮3 + 核实注入2 = 5", ev["_new_round"] == 5, f"实际 {ev['_new_round']}")

async def scenario_B():
    print("\n【场景B · Anthropic】纯查询任务不应触发核实")
    DISPATCHED.clear()
    patch_anthropic([
        msg([TU("get_project", "1", {})]),
        msg([TX("这个项目现在有3个阶段")]),
    ])
    messages = [{"role": "user", "content": "看看上线计划项目啥进度"}]
    ev = await drain(make_runner()._run_anthropic("u1", "sys", messages, AI))
    check("没有注入系统自检", count_verify(messages) == 0)
    check("直接收尾(有 _usage)", ev["_usage"] == 1)

async def scenario_C():
    print("\n【场景C · Anthropic】反复增删改 → 核实封顶 MAX_VERIFY=3")
    DISPATCHED.clear()
    script = []
    for _ in range(4):
        script.append(msg([TU("update_todo", "x", {})]))   # 改
        script.append(msg([TX("改好了")]))                  # 收尾 → 触发核实(前3次)
    patch_anthropic(script)
    messages = [{"role": "user", "content": "把待办都标记完成"}]
    ev = await drain(make_runner()._run_anthropic("u1", "sys", messages, AI))
    check(f"恰好注入 {MAX_VERIFY} 次后停", count_verify(messages) == MAX_VERIFY, f"实际 {count_verify(messages)}")
    check("最终正常收尾(有 _usage)", ev["_usage"] == 1)
    check("没撞轮次上限报错", ev["error"] == 0)

async def scenario_D():
    print("\n【场景D · OpenAI】建项目→核实查证→收尾（OpenAI 路同构）")
    DISPATCHED.clear()
    def text_chunks(text):
        return [SimpleNamespace(usage=None, choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=text, tool_calls=None))]),
                SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5), choices=[])]
    def tool_chunks(name):
        tc = SimpleNamespace(index=0, id=f"call_{name}",
                function=SimpleNamespace(name=name, arguments="{}"))
        return [SimpleNamespace(usage=None, choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=None, tool_calls=[tc]))]),
                SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5), choices=[])]
    rounds = collections.deque([
        tool_chunks("create_project"),   # R1 改
        text_chunks("项目建好啦"),        # R2 收尾 → 触发核实1
        tool_chunks("get_project"),       # R3 核实：只查
        text_chunks("已核实，都建好了"),  # R4 收尾 → did_mutate=False → 结束
    ])
    class FakeCompletions:
        async def create(self, **kw):
            data = rounds.popleft()
            async def agen():
                for c in data:
                    yield c
            return agen()
    class FakeOpenAI:
        def __init__(self, **kw): self.chat = SimpleNamespace(completions=FakeCompletions())
    import openai
    openai.AsyncOpenAI = FakeOpenAI

    messages = [{"role": "user", "content": "建个项目"}]
    ev = await drain(make_runner()._run_openai("u1", messages, AI))
    check("注入了 1 次系统自检", count_verify(messages) == 1, f"实际 {count_verify(messages)}")
    check("核实轮查证(get_project)", DISPATCHED.count("get_project") == 1)
    check("正常收尾(有 _usage)", ev["_usage"] == 1)
    check("无报错事件", ev["error"] == 0)


async def main():
    await scenario_A(); await scenario_B(); await scenario_C(); await scenario_D()
    print(f"\n{'='*48}\n通过 {len(PASS)} / {len(PASS)+len(FAIL)}",
          "✅ 全绿" if not FAIL else f"❌ 失败: {FAIL}")
    return 1 if FAIL else 0

raise SystemExit(asyncio.run(main()))
