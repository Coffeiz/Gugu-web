# Agent 可靠性架构（基于 OpenClaw 机制重构）

> 本文是 [`agent.md`](agent.md)（模块全景）的**可靠性视角姊妹篇**。agent.md 回答「有哪些模块、各自干啥」；本文回答**「怎么保证咕咕说做了就真做了、改了就真改了」**，并对照 OpenClaw（38 万星的 AI agent 框架）的可靠性工程，给每个环节标出**现状 / 演进方向**。
>
> 一轮对话内部步骤见 [`agent-决策环.md`](agent-决策环.md)；**两张架构全景图**（可靠性执行 + 系统模块）见 [`agent-architecture.md`](agent-architecture.md)；变更记录见 [`CHANGELOG.md`](../CHANGELOG.md)。

---

## 〇、为什么单独写这篇

咕咕是伙伴不是助理——而**伙伴的地基是可靠**。一个会「嘴上说排好了、文档其实没动」「说改好了、实际把别的内容覆盖丢了」的伙伴，记忆再好、主动性再强也立不住。

实战暴露的三类失败，都不是「不会用工具」，是**可靠性**问题：
1. **动嘴不动手**：模型用文字叙述「让我读一下…读到了…改好了」，却没真发工具调用。
2. **自作主张不做**：用户明确要「排序」，模型判断「现状已合理、不用改」，一个工具都不调。
3. **改了不核对**：`edit_file` 用 `replace_all` 把整段冲掉，模型只看「文件还在」就说成功。

**核心教训（来自把 OpenClaw 仓库拉下来逐层读）**：OpenClaw 的可靠性**不是靠更聪明的 prompt**，是靠四件工程事——① 把 agent 拆成**可观测的结构化 pipeline**；② 每个反复出现的坑加一个**确定性守卫**（不是再写一段 prompt）；③ 工具系统**确定性 + 强类型契约**，能代码保证的绝不交给模型；④ 诚实承认**强模型是底座**。下面四节就按这四条审视咕咕。

---

## 一、把一轮对话当 Pipeline，不是黑盒 LLM 调用

**OpenClaw 的做法**：一个 turn 被拆成 14 个有序、可观测的阶段里程碑（`src/agents/embedded-agent-runner/execution-phase.ts`）：
```
runner_entered → workspace → runtime_plugins → before_agent_reply → model_resolution
→ auth → context_engine → attempt_dispatch → context_assembled → turn_accepted
→ process_spawned → tool_execution_started → assistant_output_started → model_call_started
```
agent 不是「调一次大模型」的黑盒，是**流水线**——哪一步卡了、慢了、出错了，一眼看穿。

**咕咕现状**：一轮的实际链路是清晰的（`web.stream → _generate → core 工具循环 → 核实 → 持久化`，见 agent.md「消息链路」），但 `core.py` 内部是一个 `while round_i < MAX_ROUNDS` 的工具循环——**对外是黑盒**：没有阶段里程碑、没有结构化状态。出问题时（如今天的「没调工具」）只能靠临时 `print` 猜是哪一步。

**演进**：给 core 工具循环引入**显式阶段**（参照 OpenClaw 的里程碑枚举），每轮 emit `{phase, round, did_mutate, verify_mode}` 结构化事件，喂给下面第四节的可观测层。**收益**：今天那种「没调工具」的诊断，从「加临时日志 + 复现 + 猜」变成「看轨迹第几阶段断的」。

---

## 二、可靠性守卫层（核心：坑 → 确定性守卫，而不是坑 → prompt）

这是 OpenClaw 给咕咕最重要的一课。OpenClaw 对每个失败模式都有一个**专门的小守卫模块**（空轮检测 `empty-assistant-turn.ts`、工具结果守卫 `tool-result-context-guard.ts` 569 行、工具策略、名字白名单…），而不是把所有约束堆进 prompt。**prompt 是软的（模型可以不听），守卫是硬的（代码兜底）。**

咕咕已经有一批守卫，也有一批还停在 prompt 层（软）。逐个对照：

| 失败模式 | 现状守卫 | 软/硬 | 演进方向 |
| --- | --- | --- | --- |
| **动嘴不动手**（叙述读改却没调工具） | `core._looks_like_narration` 正则检测 + `_NARRATION_NUDGE` 强制纠偏；skills.md「真实性铁律」 | **半硬**（检测是代码、纠偏靠再喂 prompt） | 检测命中后，可直接**拦截这条回复不发给用户**，强制进工具调用轮，而非只喂提醒 |
| **改了不核对** | `core` 自我核实闭环（`MAX_VERIFY=3`，`did_mutate` 触发）+ `_VERIFY_FORCE_PROMPT`（只嘴上确认没真查 → 强制再调查询工具）+ 「改文件正文必须 `read_file` 读回比对」 | **半硬**（触发是代码 `did_mutate`/`verify_queried`，查证内容靠 prompt） | 对 `edit_file` 可加**确定性差异校验**：改前后字节数骤降 / 关键段落消失 → 代码层告警，不全靠模型自己「读回来发现」 |
| **自作主张不做**（明确请求判断「不用改」） | skills.md「用户明确要改就执行，别用『现状已合理』驳回」 | **纯软**（只有 prompt，今天 M3 也没听） | 这是当前最大的「软」缺口。OpenClaw 思路：把「明确的修改请求」做**意图分类 → 确定性要求进入执行**，而不是让模型先判断「要不要做」 |
| **内部机制/工具名泄露** | `outbound.sanitize_outbound`（IM 出口确定性清洗 tool_id/trace_id，系统提示词被复述整条换话术）+ policy.md 对外口径 | **硬**（出口代码扫） | 已较完善；web 流式路可同样接一道出口清洗 |
| **emoji 红线**（活泼语气冒阴阳表情） | `sanitize.strip_disallowed_emoji`（白名单外 emoji 出口删，三出口挂载） | **硬** | 已落地，是「prompt 压不住 → 输出层确定性兜底」的范本 |
| **不可逆误删** | `confirm.py` 两步确认（不带 confirm 拿影响 → 用户同意 → `confirm=true` 执行） | **硬** | 已完善 |
| **SSRF**（skill 抓内网） | `tools/web.http_get` 私网/环回/元数据全拦 | **硬** | 已完善 |
| **MiniMax 标记漏进正文** | `sanitize.StreamSanitizer` 流式清洗 | **硬** | 已完善 |
| **会话生成中被删 → FK 违约** | `web._generate` 持久化前查会话存活、usage 降级、`IntegrityError` 静默 | **硬** | 已完善 |

**读法**：右侧「演进」集中在前三行——咕咕**已经在走 OpenClaw 这条「坑→守卫」的路**（emoji strip、confirm、SSRF、narration 检测都是），只是**真实性三大坑**（动嘴不动手 / 不核对 / 自作主张）还卡在「半硬 / 纯软」，是把守卫从 prompt 硬化的主战场——**收口成独立的 Execution Verifier 层，见第三节**。

---

## 三、Execution Verifier（执行验证层）—— 真实性守卫的收口

> 综合 OpenClaw「Runtime 信 Tool 不信 Assistant」的理念 + 实战。把第二节散落的「真实性守卫」收口成一个**命名清晰、且从「半硬」升到「全硬」**的统一层——这是当前最该补的一块。

**理念一句话**：Runtime 永远相信 Tool 回执，不相信 Assistant 的文字。模型说「已保存」不算数；Runtime 没看到对应的成功 Tool 回执，就当它在胡说。

**四层定位**（Verifier 是发回用户前的最后一道）：
```
用户 → Planner(LLM 决定调什么) → Runtime(执行 + 控制循环) → Tools(原子能力)
                                                        ↓
                                          Execution Verifier(收尾回复发出前校验)
```

**咕咕已有零件，但散落、且大多停在「喂 prompt」**：

| 零件 | 现在做什么 | 软/硬 |
| --- | --- | --- |
| `did_mutate` | 调过增删改 → 触发核实轮 | 半硬 |
| `_VERIFY_FORCE_PROMPT` | 只嘴上确认没真查 → 再喂 prompt 求查 | 半硬 |
| `_looks_like_narration` | 叙述读改却没调工具 → 再喂 prompt 纠偏 | 半硬 |
| `verify_mode` 静默缓冲 | 核实轮确认文字丢弃、不重复刷给用户 | 硬（已硬，是范本） |

**核心差距，也是真正的升级点：半硬 → 全硬**
- **现状**：检测到「说了没做」→ **再喂一段 prompt 求模型改**。模型可以继续不听（今天 MiniMax-M3 实测就没听）。
- **目标**：检测到 → **Runtime 直接拒发这条回复，带失败原因强制重新生成**。模型没有「继续耍赖」的机会——在运行时**物理阻止**，不靠自觉。

**Verifier 的判定铁规则**：
1. 回复出现完成语（「已创建 / 已保存 / 已删除 / 已发送 / 已记住」）但本轮**无对应成功 Tool 回执** → 拒发，要求重新生成。
2. 工具调用**返回 error** → 禁止输出成功语，按失败结果重新生成回复。
3. 承诺「稍后提醒 / 我会记住」→ 必须真建了提醒（`create_scheduled_task`）/ 写了记忆（`remember`），否则拒发。

**落地要点（实现时参考）**：
- 收口成 `agent/verifier.py` 一个模块，core 在「模型 text-only 收尾」那一刻过一道 Verifier，不通过就重生成——**复用现有核实轮的 `_new_round` 机制，只是把「喂 prompt 求改」换成「拒发 + 强制重生成」**。
- 完成语检测：维护「完成语 ↔ 期望工具前缀」轻量映射（「已保存/已建」↔ 写动词前缀、「稍后提醒」↔ `create_scheduled_task`、「记住了」↔ `remember`），**代码层匹配，不靠模型**。
- 封顶防死循环（沿用 `MAX_VERIFY`）；到顶仍不达标 → 如实告诉用户「这步我没做成」，而不是放它说谎。

**为什么这层比继续改 prompt 值**：prompt 是软的（模型可不听，今天反复验证过）；Verifier 在**运行时物理拦截**「说了没做」。Claude Code / Cursor 等成熟 agent 产品，可靠性都靠这种运行时校验，不靠提示词约束。

---

## 四、工具系统：确定性 + 强类型契约

**OpenClaw 的做法**：`src/tools/planner.ts` 是 **Deterministic planner**——哪些工具可见/可用、名字是否唯一、executor 路由，全是**代码层确定性校验**（重名直接 `throw ToolPlanContractError`，executor 是封闭 discriminated union）。模型只负责「选哪个工具」，工具系统本身对不对是代码保证的，不掺模型判断。

**咕咕现状**：方向一致且已落地不少——
- **工具一等公民**（agent.md「工具一等公民」）：`Tool` 声明自动派生 Anthropic/OpenAI 双格式并注册，Profile 按名组合，消除手抄工具名的双重维护。
- **`registry.dispatch` 是所有工具执行的唯一咽喉**：实时刷新、user_id 归一、异常兜底、（新加的）`[TOOL-DBG]` 都挂在这一个点。
- **命名约定驱动核实覆盖**（`core._mutating_tools`）：写动词前缀（`create_`/`edit_`/…）自动纳入自我核实，新工具零登记。

**差距 / 演进**：
- 咕咕工具的「可用性 / 契约校验」比 OpenClaw 弱——没有「重名即报错」「executor 强类型封闭联合」这类**启动期契约断言**。新工具声明错了（重名、schema 不合法）多半是**运行时静默失效**，不是启动就 throw。
- **演进**：给 `registry` 注册加一道**契约校验**（重名、schema 必填字段、handler 签名），启动期 fail-fast，对齐 OpenClaw 的 `assertUniqueNames` / `ToolPlanContractError`。

---

## 五、可观测性：从「临时 print」到「轨迹」

**OpenClaw 的做法**：工具调用记成**可复现的 JSONL 轨迹**（trajectory），加上第一节的 14 阶段状态——任何一轮都能回放、审计、定位。

**咕咕现状**：观测手段是**零散且偏临时**的——
- `[TOOL-DBG]` 是今天为查「没调工具」临时加的 `print`（用完即撤）。
- 后台 Debug 面板 tail 三个日志文件（web/worker/supervisor）。
- State Manager（`runtime_state`）有 IM 运行时状态，但只为「还在吗」短路，不是完整轨迹。

**演进**：把 `[TOOL-DBG]` 正式化为**结构化工具调用轨迹**——每轮记 `{round, phase, tool, args 摘要, 成功/失败, did_mutate, verify_mode}`，落一行 JSONL（或进 Debug 面板专列）。**收益**：今天「咕咕到底调没调工具」要「加日志→复现→猜」的整个过程，变成「翻这次会话的轨迹」。这是性价比最高的一项——不改行为，只让行为**可见**，后续所有可靠性问题的定位都受益。

---

## 六、模型是底座（诚实的边界）

OpenClaw 的开发准则 `AGENTS.md` 白纸黑字：cloud 模型（Anthropic/OpenAI/Google）才适合做主编排，本地模型可靠阈值是 **32B+**。它**没有**「让弱模型可靠调工具」的银弹。

**咕咕的印证**：今天这一长串排查，逐一排除了端点（mimo 的 OpenAI vs Anthropic 端点）、思考模式（thinking adaptive），最后发现 **MiniMax-M3 也复现同样问题** → 才锁定是 prompt/决策层而非模型。但反过来也成立——**mimo 那串「空气泡、说做了没做、丢 reasoning」的毛病，确实有模型本身的份**。`core.py` 为 mimo 打的一串补丁（thinking 参数、空回复兜底 `empty_retry`、双端点适配）就是证据：**弱模型要靠工程补，强模型省一半事**。

**取向**：可靠性优先的场景（多步改数据、文档编辑），默认走**为工具调用优化的强模型**（MiniMax-M3 / Anthropic 类），把 mimo 这类推理模型留给纯对话。`llm_select.pick_model` 已是统一插槽，按场景路由模型是现成的扩展点。

---

## 七、一页纸总结：现状 → 演进

| 维度 | 现状 | 演进（OpenClaw 启发） | 优先级 |
| --- | --- | --- | --- |
| **可观测** | 临时 `print` + 日志 tail | 结构化**工具调用轨迹**（JSONL） | **最高**（不改行为、所有定位受益） |
| **决策守卫** | 「明确请求要执行」纯 prompt（软，今天没压住） | 意图分类 → **确定性要求进入执行** | 高（当前最大软缺口） |
| **Execution Verifier** | 零件散落、停在「喂 prompt」（半硬） | 收口成层 + 半硬→全硬（**拦回复重生成**），`edit_file` 差异校验 | **高**（见第三节） |
| **Pipeline** | core 黑盒 while 循环 | **阶段里程碑** + 结构化事件 | 中（配合可观测） |
| **工具契约** | 运行时静默失效 | 注册期**契约断言** fail-fast | 中 |
| **模型** | mimo/M3 双路 | 可靠场景默认**强工具模型** | 看体验数据 |

**贯穿原则（抄自 OpenClaw）**：
> **坑 → 守卫，别坑 → prompt。** 反复出现的失败，先问「能不能加个确定性检查兜住」，而不是再写一段提示词。prompt 是软的，守卫是硬的。
>
> **能确定性化的，别交给模型。** 工具系统对错、明确请求该不该执行——这些能用代码保证的，从模型手里拿走。
>
> **先可观测，再优化。** 看不见就只能猜；把每轮工具调用变成可回放的轨迹，是一切可靠性工作的地基。

---

> 本文聚焦可靠性。完整模块、工具清单、记忆/IM/并发设计见 [`agent.md`](agent.md)；并发扩量见 [`并发优化ROADMAP.md`](并发优化ROADMAP.md)。
