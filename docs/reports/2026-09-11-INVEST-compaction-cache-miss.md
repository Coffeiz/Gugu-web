# INVEST：会话压缩场景缓存命中率 0.1% 根因分析与修复

> 排查日期：2026-09-10 至 2026-09-11
> 排查环境：devserver（192.168.110.51，systemd gugu-backend/gugu-worker，MiniMax-M3 走 anthropic 兼容端点）
> 排查对象：Admin 用量页 `compaction` 场景缓存命中率（364.7K 输入 / 0.1% 命中）
> 排查目的：追加式压缩上线当天场景命中率仍接近 0%，定位原因并修复

---

## 1. 现象

- Admin 用量页按场景统计，`compaction` 场景长期贴着 0.1% 缓存命中率。
- 当天已把 run 内溢出压缩改为「追加式」（复用主会话 canonical 序列、末尾追加压缩指令），按设计应与主对话共享 MiniMax 的会话内前缀缓存（主对话 run 内逐轮命中率 95%+），实际没有兑现。

## 2. 关键证据：分支请求与主对话帧不同前缀

先在真实链路上做对照：同一次 run 里，主对话帧 `cache_read=71950`，紧随其后的压缩分支 `cache_read=128`（约 0.2%）。说明分支请求与主 run 刚发过的请求**从第一个 token 起就不一致**，前缀缓存整段落空，而不是「缓存过期」或「provider 不支持」。

随后用 provider 层探针 + 真实 web run 逐项定位失配点，共三个：

### 2.1 分支只发中段（结构性失配）

`_generate_append_summary` 当时收到的是「待压缩的中间片段」作为消息序列，分支请求的第一条消息就是对话中段，与主 run 的请求序列根本不同前缀。

**修复**：新增 `compaction._branch_prefix_history`，分支改发「固定前缀 + 待压缩区间之前的完整历史」，与主 run 请求逐 token 同前缀；被压缩区间之后的近期窗口不参与本次摘要，直接截掉不影响语义。

实现要点：切片必须按 `message_history` 的位置计算——`_drop_orphan_tool_results` 会 `dict(message)` 浅拷贝、必要时丢消息，两个列表长度不一定相等，跨列表用下标会切偏；身份匹配只在 `message_history` 内成立。

### 2.2 anthropic 路由角色投影缺失

主 run 在 `render_history` 之后还会把「消息级 system」投影成 user（`loop_drivers.AnthropicDriver.run_round`），分支没做这一步。实测同一前缀只换角色：`cache_read` 3840 → 384。

**修复**：`_branch_prefix_history` 里 anthropic 路由补 `render_anthropic_message_roles`。

### 2.3 工具声明缺失（决定性）

provider 把 `tools` 一并算进可缓存前缀。生产规模（101 个常驻工具、anthropic schema 约 5.5 万字符）下实测：

| 配置 | 命中率 |
|------|--------|
| 带 tools、不设 tool_choice | 接近 100% |
| 不带 tools | 约 15% |
| 带 tools 但设置 `tool_choice` | 约 15% |

**修复**：`BranchInput.tools` → `ContextBranch.run` → `provider_runner.complete_messages/_anthropic/_openai` 贯通工具声明；`core.compact_context_now` 传 `branch_tools=getattr(ctx, "tools", None)`。anthropic 路径只发 `tools`、**不设** `tool_choice`，改用追加指令尾部「也不要调用任何工具」承担约束；OpenAI 兼容路径复用主 run 的 `build_tool_params`。

## 3. 修复后验证（真实 web run，2026-09-11 00:07 CST）

同一会话连续四轮真实 web run，在 `provider_runner._record_usage` 插桩直接读每次分支调用的真实 usage（不按 `agent_usage` 行号猜轮次——worker 的 baseline 压缩也会写 `compaction` 行，混在一起容易误读）：

| 轮次 | 分支调用 | 输入 | cache_read | 命中率 | 同轮主对话 |
|------|---------|------|-----------|--------|-----------|
| 1 | 第 1 块 | 1009 | 30233 | 96.8% | cr=30233 / 99.2% |
| 1 | 第 2 块 | 3748 | 128 | 3.3% | — |
| 3（强制去掉 tools） | 第 1 块 | 16755 | 13392 | 44.4% | cr=29540 / 98.3% |
| 4（仍去掉 tools） | 第 1 块 | 2157 | 29392 | 93.2% | cr=30053 / 95.5% |

结论：分支读到的 `cache_read` 与同轮主对话帧一致（30233/30233、29392/30053），确认两者共享同一份可缓存前缀；去掉 tools 后首轮立即跌到 44.4%，下一轮靠同形前缀才热回来，反证工具声明确实参与前缀。修复前同一位置的对照是 128 对 71950。

## 4. 聚合命中率仍会偏低的结构性原因（后续已处理其一）

1. **run 结束后的 baseline 压缩**（`compress_conv._call_llm`）走 `BranchInput(stable_system=..., delta=...)`，没有 `history_messages` → 落到旧的重编译路径（历史摊平成一段文本），结构上不可能与主 run 共享前缀，每次约 3 万输入、`cache_read=0/128`。**它也打 `scenario=compaction`**，所以 Admin 场景表的聚合命中率仍会被它持续拉低——单看聚合数字会误判修复没生效。
   **→ 已于同日处理（见 §4.1）**：baseline 不再用摊平文本重放生成，直接复用本 run 刚生成、且已命中缓存的 run 内摘要。
2. **分块滚动摘要的第 2 块**必然冷：它的前缀包含第 1 块刚生成的摘要，与主 run 无同形前缀，这是设计使然。

### 4.1 baseline 复用 run 内摘要（2026-09-11 追加）

评估过「给重放路径换追加式」：worker/收尾阶段从 DB 重放历史，要与主 run 的 system、工具声明和消息渲染逐字节对齐，成本高且脆。而 baseline 的触发时机（`run_finalize` 里 `compaction_applied=True`）本 run 刚生成过同一批历史的摘要——那次摘要生成本身就是命中缓存的追加式调用。因此改为**复用摘要、只重算水位**：

- `run_finalize` 从收尾帧提取 `<compacted-summary>` 正文传给 `compress_if_needed(reuse_summary=..., reuse_before_message_id=本轮用户消息 id)`；
- `compress_conv` 复用路径不再调用摘要 LLM，保留窗口规则照旧重算水位，且可压缩范围限制在本轮消息之前（run 内压缩不覆盖本轮消息，水位不得越过它们）；
- 无 run 摘要可复用时（手动 `/compact`、确定性截断兜底）仍走原重放路径。

水位安全性：baseline 保留窗口按内容字符计、run 内按渲染字符计（渲染 ≥ 内容），同预算下 run 保留只少不多，baseline 想压缩的集合恒为 run 摘要覆盖集的子集；加上本轮消息排除，两个方向都不会越过覆盖边界。

验证（真实 run，连续两轮触发压缩）：两轮重放 LLM 调用均 0 次、审计行 `trigger=run_reuse`、summary 落库；水位停在保留窗口边界且恒小于本轮用户消息 id（0 → 38078 压缩 171 条；再 38078 → 38088 压缩 10 条并滚动合并出 614 字符新摘要）；此前每次压缩后必然出现的「in≈3 万、cr=0/128」重放用量行不再出现。全量后端测试 2480 passed（含新增回归 3 项）。

### 4.2 生产规模复测揪出第四个失配点：thinking 参数（2026-09-11 续）

baseline 复用上线后做生产规模复测（预设 120k、合成填充触发 90% 线），结果**分支仍然 0.1%**，且暖前缀对照更矛盾：同一轮里主请求 `cr=105932`（99.9%，30 秒前刚写过缓存），紧随其后的分支 `in=94418 cr=128`。说明 §2 的三个失配点修完后还有一个，而且不是「缓存过期」能解释的。

逐参数受控实验（小请求手工构造，MiniMax-M3）：

| 变体 | 结果 |
|------|------|
| 同内容原样重发 | 命中（打不打 cache_control 都命中） |
| 末尾追加 assistant+user（正常续轮） | 命中 |
| 末尾追加**连续第二条 user 消息**（服务端合并进前一条） | 全 miss |
| 同一消息末尾续写内容 | 全 miss |
| 只改 `max_tokens` | 仍命中 |
| **追加 `thinking` 参数** | **全 miss** |
| system 末尾多一个字 | 全 miss |

即：缓存按「消息数组逐元素前缀 + system + 请求参数」匹配，`max_tokens` 不参与。对照代码发现：预设 `thinking="adaptive"`，主循环经 `adapter.build_anthropic_thinking_params(ai)` 得到 `{}`（MiniMax 不发 thinking），而分支 `provider_runner._anthropic` 手拼了 `kwargs["thinking"]={"type":"adaptive"}`——分支比主请求多一个参数，缓存键不同，整段 miss。对分支与主请求的 messages 逐元素比对（456 条）与 tools 比对均逐字节一致，唯一差异就是这个参数。

**修复**：`complete_messages` 改传 `align_with_main_run=True`，`_anthropic` 在该模式下用与主循环同一个 adapter 构造 `build_anthropic_thinking_params` / `build_anthropic_generation_params`，不再手拼。新增单测 2 项（adaptive 时分支不得发 thinking；adapter 参数必须原样合并）。全量后端测试 **2482 passed**。

**修复后同条件复测**：主请求 `cr=106037`（99.9%），分支**单次调用** `in=758 cr=94009`，命中率 **99.2%**。修复前同位置是 `in=94418 cr=128`。

真实会话（388，活跃长会话）补充两个边界事实：

- 正常聊天轮次命中 96–97%；但闲置约 40 分钟后下一轮 `cr=0`——MiniMax 前缀缓存 TTL 以十分钟计，跨 TTL 的首次请求必然冷写。
- 手动 `/compact` 走的仍是摊平重放（独立 compress-prompt system、无历史帧），与主对话请求结构上零共享，实测预热后调用命中 1.2%。它不在本次修复范围内，是剩余的结构性冷路径（低频、用户手动触发）。

结论修正：§7 原来写的「聚合命中率随新数据积累回升」不成立——聚合回升的前提是分支请求与主请求逐参数对齐（本节修复）+ 会话前缀在 TTL 内；跨 TTL 冷启动与手动 `/compact` 仍会是冷的。

## 5. 变更与质量

- 提交 `d62f4fbb2`（dev 分支，未推送）：`compaction.py`、`branch_types.py`、`branch.py`、`provider_runner.py`、`core.py` + 单测（前缀头锚定与角色投影、工具贯通含不设 tool_choice 的断言）+ devlog（`docs/devlog/2026-09-10-压缩分支前缀缓存命中修复.md`）。
- 定向测试 65 passed；全量后端测试 **2467 passed**（约 3 分 36 秒）。
- devserver 服务 23:53 已带新代码重启；远端文件 mtime 早于服务启动时间，代码内容 grep 确认。

## 6. 排查手法备注

- 在 `provider_runner._record_usage` 插桩是本次最可靠的观测点：直接拿到每次分支调用的真实 usage，避免按数据库行号对轮次（多个进程都会写 `compaction` 行）。
- wire 帧比对（拦截 anthropic 客户端的请求，逐条消息做哈希对照）用于定位「主 run 与分支从第几条消息开始失配」。
- 所有探针只落在本机 `/tmp`，未进仓库，验证后已清理；探针产生的测试会话、填充消息与对应用量行已从 devserver 数据库清除。

## 7. 结论

- [x] 0.1% 的直接原因查明：分支请求与主 run 不同前缀（中段切片 + 角色投影缺失 + 工具声明缺失），已修复并在真实 run 验证分支命中 93–97%。
- [x] baseline 压缩的重放调用已去除（复用 run 内摘要 + 只重算水位），`compaction` 场景最大的冷输入来源消除。
- [x] 生产规模复测发现第四个失配点：分支手拼 `thinking` 参数与主 run 不一致（请求参数参与 provider 缓存键），修复后暖前缀分支实测命中 **99.2%**（§4.2）。
- [x] 聚合命中率的现实边界：会话闲置超过 MiniMax 缓存 TTL（实测约 40 分钟）后的首次压缩、以及手动 `/compact` 的摊平重放，仍会是冷的；这两块是剩余的冷输入来源。
- [x] 全量测试绿，修复已提交本地 dev 分支，等待推送指令。
