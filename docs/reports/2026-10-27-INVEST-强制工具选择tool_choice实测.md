# INVEST：强制工具选择（`tool_choice`）在群聊选择门的可用性实测

> 日期：2026-10-27
> 结论摘要：**强制 `tool_choice` 不能一刀切启用**。它能否用取决于 provider × 协议 × thinking 三者组合，且判错会让整轮请求 400、直接打断群聊 run。最终采用「提示词 + 协议检测 + 纠错轮」的 provider 无关方案。

## 1. 问题

群聊自动回复要求模型先调用 `group_reply_decision(should_reply)` 决定静默还是发言（PRD-IM-16）。实测发现模型偶尔跳过选择工具、直接输出正文，本轮内容因此被回复门丢弃——该回的回复没发出去，还白烧一轮模型开销。

一种更彻底的做法是让 provider 在协议层强制模型调用该工具（`tool_choice`），从根上消除「忘记」这回事。本报告回答：这条路在本项目的 provider 组合里能不能走。

## 2. 实测方法

探针：`backend/scripts/diagnostics/probe_forced_tool_choice.py`（需显式 `--allow-real-llm`）。

每个 provider 跑固定序列，前缀固定、逐项只换 `tool_choice`：

```
warmup(auto) × N  →  baseline(auto)  →  forced  →  required/any  →  regression(auto)
```

- **必须先预热**：`warmup` 两轮把前缀缓存打热，之后的对比才落在同一个热前缀上；未预热的首轮命中率天然为 0，会把「缓存塌陷」和「冷启动」混为一谈。
- `forced` = OpenAI 兼容端 `{"type":"function","function":{"name":...}}`；Anthropic 协议用官方扁平形状 `{"type":"tool","name":...}`。**两种协议的形状不通用，混用会被 provider 当非法参数拒掉。**
- 观察点：`cache_read` / `cache_ratio`（前缀命中）、是否真的产出目标工具调用、HTTP 状态。
- 前缀用合成文本，不含任何真实用户内容；输出只含量化指标与状态码。

## 3. 实测数据

`cache_ratio` 列中「基线」是同一前缀下 `tool_choice=auto` 的对照值。

| provider / 模型 | 协议 | thinking | 强制形态 | 结果 | cache_read | 命中 |
|---|---|---|---|---|---|---|
| MiniMax-M3.1-Flash（当前激活预设） | anthropic | `''` | 强制 | **未测** | — | 额度耗尽（429） |
| agnes-2.5-flash | openai | adaptive | `function` | **200 ✓** | 14592 | 98.88%（基线 98.88%） |
| agnes-2.5-flash | openai | adaptive | `required` | **200 ✓** | 14592 | 98.88% |
| Mimo-v2.6-flash | openai | `''` | `function` | **200 ✓** | 15360 | 99.76%（基线 99.76%） |
| Mimo-v2.6-flash | openai | `''` | `required` | **200 ✓** | 15360 | 99.76% |
| deepseek-flash | openai | adaptive | `function` | **400** | — | 拒绝 |
| deepseek-flash | openai | adaptive | `required` | **400** | — | 拒绝 |
| deepseek-flash | openai | disabled | `function` | **200 ✓** | 13824 | 98.76%（基线 98.80%） |
| deepseek-flash | openai | disabled | `required` | **200 ✓** | 13824 | 98.76% |
| deepseek-flash | anthropic | adaptive | `{"type":"tool"}` | **400** | — | 拒绝 |
| deepseek-flash | anthropic | adaptive | `{"type":"any"}` | **200 ✓** | 13824 | 与基线一致 |
| GLM glm-5.3-flash | openai | adaptive | — | **未测** | — | 余额不足（429） |
| qwen qwen3.8-flash | openai | adaptive | — | **未测** | — | API key 无效（401） |

失败响应原文（deepseek，chat.completions）：

```
400 invalid_request_error: Thinking mode does not support this tool_choice
```

## 4. 结论

### 4.1 OpenAI 兼容端（chat.completions）不吃 `tool_choice`

`base.py` 的 `build_tool_params` 本来就恒发 `tool_choice: "auto"`，而这条路径的缓存命中率长期在 98%+，说明缓存键不含 `tool_choice`。实测换成强制值后 `cache_read` 与 `auto` 基线一字不差（13824 / 14592 / 15360），**强制不塌缓存**。

### 4.2 但可用性强烈依赖 thinking

同一个 deepseek-flash：

- thinking 开启 → 强制 `tool_choice` 直接 **400**
- thinking 关闭 → 强制 **200**，缓存命中不受影响

**这不是本项目能统一控制的变量**：模型预设里的 `thinking` 是用户/管理员配置，group bot 用哪个预设也不是写死的。

### 4.3 Anthropic 协议路径另有硬约束

`{"type":"tool","name":...}` 被拒，但 `{"type":"any"}` 在同一端点、同一 thinking 配置下可用——判定轮本来就只暴露一个工具，「必须调用任意工具」在这里精确等价于「必须调用 group_reply_decision」。

但 Anthropic 协议路径有历史实测记录（`docs/reports/2026-09-11-INVEST-compaction-cache-miss.md` §2.3，生产规模 101 工具 / 约 5.5 万字符）：

| 配置 | 命中率 |
|---|---|
| 带 tools、不设 tool_choice | 接近 100% |
| 不带 tools | 约 15% |
| **带 tools 但设置 tool_choice** | **约 15%** |

当前激活预设正是 MiniMax（Anthropic 协议），恰落在这一条上；而 MiniMax 因 Token Plan 额度耗尽本次未能实测。

### 4.4 判错代价不对称

- 现状问题：模型偶尔忘了 → 群里少一条回复（低频、低危）
- 误用强制：在不支持的组合上 → 整轮 400 → **群聊 run 直接挂掉**（高频、高危）

用高危方案换低危问题不划算。

## 5. 最终方案

不引入强制 `tool_choice`，改用 provider 无关的**协议纠错轮**：

1. 判定轮工具集仍只有 `group_reply_decision`（`loop/runner.py`），模型除了选没有别的路。
2. 模型直接输出正文且未做选择 → 判定为协议违反 → 把协议错误作为合成控制消息回给模型，**在同一 run 内**让它补做选择。
3. 纠错上限一轮。补选后仍不选 → 落静默 + error 终态 + 受限诊断。
4. 纠错轮的正文与提示只存在于本次请求上下文，不落库、不外发。

实测代价接近零：纠错只在模型真忘了时触发（异常路径），且纠错轮的前缀仍然命中缓存（多一次 cache read，而非重付全价前缀）。

**若将来要启用强制 `tool_choice`**，必须先满足：① 按 provider × 协议 × thinking 逐个探测并持久化能力；② 探测不通过时优雅降级到纠错轮，不能让 400 直接打断 run；③ 重新验证 Anthropic 协议路径的前缀缓存命中。

## 6. 复现

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/diagnostics/probe_forced_tool_choice.py \
    --allow-real-llm --warmup 2 --prefix-chars 30000
```

可在 devserver 或本地测试环境运行；部分 provider 需要该环境自身的凭据与额度。本地与 devserver 的 `config.override.json` 是各自独立的一份，凭据不通用。
