# 长任务内联压缩与 DeepSeek 追加反思缓存 A/B

> 日期：2026-10-19
> 环境：devserver，DeepSeek `deepseek-flash` / Chat Completions
> 范围：经用户授权读取真实 LoopScope 正文，隔离回放实际请求；不执行历史工具，不修改业务数据库或用户运行配置。

## 调查结论

这次存在两个独立原因。

1. **内联压缩保留窗口过大且后续边界更新不完整。** 原策略保护上一个 run 和当前 run 各最近十个完整执行轮。搜索正文很大时，即使已经生成摘要，大部分正文仍受保护。一次实际 run 中，输入依次为 117,730、142,680、114,839、115,291、113,073 token，三次压缩后的下一请求分别出现约 35,000 cache read。压缩确实应用了，但没有把长任务的工作集降下来。上一 run 的保护起点也没有随新 baseline 更新，可能在下一次压缩中误将仍受保护的历史当作旧历史。
2. **DeepSeek 的 `response_format=json_object` 改变追加分支的缓存复用。** 实测历史完全相同、JSON 任务完全相同，仅切换这项参数，命中输入从 116,991 降至 35,072 token。主对话使用普通输出，而反思使用 JSON 模式，因此存在跨分支失配。

另修复了两处相关边界：保护索引必须基于 Area 常规投影，不能拿它切经过孤儿工具清理的 wire 消息；仅达到 90% 并不等于 Provider 已明确溢出，不能因此进入硬裁切。

## 修复行为

- 仍以最近一次 Provider 实际完整输入达到上下文窗口 90% 为自动触发条件，缓存读取也计入输入；不使用本地估算提前触发。
- 运行中压力压缩可以摘要本 run 已完成的较早执行轮，单独原样保留本次用户最后请求，以及最近一个已完成的完整执行轮。正在返回的本轮响应和工具结果随后继续追加。
- 普通历史恢复、手动/持久 baseline 的十轮保留规则不因本次修改而全局缩小。
- 压缩后同步更新用户锚点、当前执行轮起点和上一 run 的保护位置。摘要分支仍复用真实 wire 前缀，包括原生 thinking/signature；选取压缩范围时使用索引所属的 Area 投影。
- 没有可压缩历史时保留原上下文；硬裁切只用于 Provider 明确返回溢出的路径。
- DeepSeek Chat Completions 的追加式 JSON 分支使用任务提示生成 JSON，并保留统一 JSON 解析及业务校验。独立 JSON 请求仍发送 `response_format`；其他 Provider 继续使用原有参数。

## A/B 1：真实长任务请求回放

A 使用原 run 压缩后实际记录的三个后续请求。B 使用同一压缩前历史，通过修复后的实际压缩器生成摘要，并顺序追加相同的三组工具往返。两边使用独立前缀标记，各自预热；`tool_choice=auto` 与真实运行一致。模型输出限制为 16 token，提示只回复诊断结果，工具从不派发。

历史配置未保留完整上下文窗口字段。本次根据原 run 的 90% 触发边界，显式以 128,000 token 重放；当前已保存配置为 120,000，未修改它。摘要输出预算沿用捕获请求的 8,000 token。

| 后续请求 | A 完整输入 | A cache read | A 命中率 | B 完整输入 | B cache read | B 命中率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 141,923 | 35,456 | 24.98% | 100,456 | 35,072 | 34.91% |
| 2 | 113,843 | 35,072 | 30.81% | 100,896 | 100,352 | 99.46% |
| 3 | 114,283 | 113,792 | 99.57% | 101,336 | 100,864 | 99.53% |
| 合计 | 370,049 | 184,320 | 49.81% | 302,688 | 236,288 | 78.06% |

排除各自预热后，完整输入减少 **18.20%**，未命中输入从 **185,729 降至 66,400，减少 64.25%**。B 后续没有再次触发压缩，用户最后原文的完整保留断言通过。

压缩后的第一个请求仍会因历史开头的摘要变化而失去部分旧缓存，这属于前缀缓存的正常行为。新策略避免的是工作集仍过大时连续改写摘要并反复重算历史。该表只统计三个主请求，不将摘要生成本身混入主请求指标。

对应受控 LoopScope 诊断 run：`run-compaction-ab-bc7d3dca22a2`。它同时保留压缩分支的实际 Provider 请求和 usage，确认摘要由真实模型成功生成，没有用本地摘要替代验收。

## A/B 2：完全相同 JSON 任务

通过实际 `provider_runner.complete_messages` 路径运行，同一历史、工具 Schema、模型、thinking 设置、任务及输出预算，仅改变 Provider 的追加 JSON 参数策略。A 临时启用旧 `response_format` 参数，B 使用修复后的 Provider 实现。任务只生成合成对象 `{"ok":true}`，不会写记忆。

| 请求 | 完整输入 | 未命中输入 | cache read | 命中率 | JSON 解析 |
| --- | ---: | ---: | ---: | ---: | --- |
| 主对话参数预热 | 117,125 | 117,125 | 0 | 0% | 通过 |
| A：上游 JSON 模式 | 117,147 | 82,075 | 35,072 | 29.94% | 通过 |
| B：追加 JSON 提示及解析 | 117,125 | 134 | 116,991 | 99.89% | 通过 |
| B：再次复用 | 117,125 | 134 | 116,991 | 99.89% | 通过 |

对应受控 LoopScope 诊断 run：`run-json-cache-ab-8afeb9472a4f`。该结果证明本模型、该协议下参数切换对缓存的影响，不推断所有 Provider 都有同样行为。

## MiniMax Chat API 交叉验证

使用已配置的 `MiniMax-M3.1-Flash-Preview`，通过适配器定义的官方 Chat Completions 端点回放相同源历史，不修改持久化配置。每组历史、工具 Schema、JSON 任务和生成参数相同；A 显式发送 `response_format={"type":"json_object"}`，B 省略该参数，出站请求已确认不同。原 MiniMax 适配器本身未注入此参数，因此本实验检验的是上游参数影响，不代表 MiniMax 原实现存在该缺陷。

| 请求 | 输入 Token | 缓存命中 | 未命中输入 | 命中率 | JSON 校验 |
| --- | ---: | ---: | ---: | ---: | --- |
| 无 JSON 参数预热 | 110,623 | 128 | 110,495 | 0.12% | 通过 |
| A：上游 JSON 模式 | 110,623 | 110,592 | 31 | 99.97% | 通过 |
| B：提示及解析 | 110,623 | 110,592 | 31 | 99.97% | 通过 |
| B：再次复用 | 110,623 | 110,592 | 31 | 99.97% | 通过 |

受控诊断 run：`run-json-cache-ab-476bed465d55`。统计文件暂存 devserver 的 `/tmp/gugu-minimax-json-cache-ab-20261019.json`。该模型与协议下未复现 DeepSeek 的参数切换缓存退化，此前据此保留 Provider 差异；随后按用户要求统一追加分支策略（见下文）；运行中压缩与用户消息保护属于公共上下文逻辑，仍适用于所有 Provider。此次仅验证该 MiniMax 模型与 Chat API，未验证其 Anthropic 或 Responses 协议。

脚本支持 `--provider minimax` 选择已配置模型；默认沿用源历史的 Provider 与模型。只在原端点等于适配器默认端点时按协议切换默认地址，自定义地址保持原样。

## 统一追加分支策略

按用户确认，将追加历史的 Chat JSON 分支策略移到公共 `ProviderAdapter.build_branch_structured_output`：有历史时不额外启用上游 JSON 模式，无历史时继续调用各 Provider 的结构化输出实现。删除 DeepSeek 专用覆盖，保留提示词 JSON 要求、统一解析和业务校验。Anthropic、Responses 等协议原有分支流程不受此参数调整影响。

六个 Provider 的行为回归覆盖追加请求、独立请求，以及无效 JSON 不可应用；本轮针对性测试 32 项通过。统一属于明确的工程策略选择，并非证明所有 Provider 均存在 DeepSeek 的缓存问题，也不承诺提示词约束与上游格式约束在输出可靠性上完全等价。

## 验证和限制

- 先用新增回归复现保护位置丢失，以及 90% 阈值误走硬裁切；两项均在旧实现失败。
- 增加长任务不足十轮时也能摘要较早执行结果、最后用户原文与最新完整工具往返保留、wire 清理后锚点不偏移的行为测试。
- 新增 Provider JSON 参数隔离、独立请求保持 JSON 模式、各 Provider 独立请求保持原参数，以及无效 JSON 不可应用的回归。
- devserver 串行运行上下文、Provider、核心工具循环等相关回归 **794 项通过**；ownership、确认门和语法检查通过。
- 使用 `ripwire-quality-bar` 检查本次运行时代码，没有新增阻断级存量退化；诊断脚本的编排复杂度不作为模型能力或运行性能证据。
- 这是请求回放与缓存实验，不是让模型重新执行完整业务任务，也没有验证长期反思提取质量。最小 JSON 任务用于隔离缓存因素；生产侧仍解析 JSON、校验业务结果并拒绝无效输出。
- Collector 捕获的深层工具 Schema 存在 `<max-depth>` 截断。回放器仅在其余所有字段与当前注册表相同时补齐截断节点，否则拒绝回放。一次出现 Schema 400 的预备实验已排除，不作为上表验收结果。
- 原始对话、摘要和请求仅保留在受控 Collector；仓库内只写统计、合成测试和显式授权才能运行的诊断脚本，没有真实昵称、账号或凭据。

## 测试脚本

- [统一缓存对比入口](../../backend/scripts/diagnostics/test_cache_strategy_compare.py)
- [长任务回放](../../backend/scripts/diagnostics/probe_inline_compaction_progress.py)
- [JSON 参数严格 A/B](../../backend/scripts/diagnostics/probe_reflection_cache_format.py)
- [内联压缩回归](../../backend/tests/agent/context/test_inline_compaction_progress.py)
- [Provider 分支回归](../../backend/tests/agent/providers/test_provider_runner_cache.py)

命令在 `<devserver仓库根目录>/backend` 执行；替换受控 Collector 路径及源 run，不能复制用户凭据到命令中：

```bash
PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_cache_strategy_compare.py \
  --inline-run <源run> --collector-db <受控Collector数据库> \
  --allow-real-data --allow-real-llm --context-tokens 128000 \
  --probe-reflection-format --output <临时目录>/inline-ab.json

PYTHONPATH=. .venv/bin/python scripts/diagnostics/probe_reflection_cache_format.py \
  --run-id <源run> --collector-db <受控Collector数据库> \
  --allow-real-data --allow-real-llm --output <临时目录>/reflection-json-ab.json

PYTHONPATH=. .venv/bin/pytest -q tests/agent/providers tests/agent/context \
  tests/agent/test_agent_loop_modules.py tests/agent/test_core_loop_characterization.py \
  tests/agent/test_run_context_boundaries.py tests/agent/test_loop_driver_usage_semantics.py
```

两份验收统计 JSON 暂存于 devserver 的 `/tmp/gugu-inline-compaction-ab-20261019-final.json` 与 `/tmp/gugu-reflection-json-cache-ab-20261019.json`，未清理；只包含汇总用量和诊断 run 标识，没有原始正文。脚本只读 Collector 数据库，真实 Provider 调用可能计费；只向 Collector 写隔离诊断 run，不执行工具或修改应用配置。
