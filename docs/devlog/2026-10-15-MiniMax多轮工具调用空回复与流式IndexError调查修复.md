# MiniMax 多轮工具调用空回复与流式 IndexError 调查修复

> 排查日期：2026-10-15
> 排查环境：devserver，Python 3.12
> 排查对象：MiniMax Anthropic 兼容接口、多轮工具调用、空回复恢复
> 状态：已实施修复并完成专项验证；尚未完成发布级全量验证

## 结论

已捕获真实上游异常事件序列：MiniMax 在没有创建内容块的情况下发送 `content_block_stop(index=0)`。Anthropic SDK 累积响应时直接访问空列表的第一个元素，抛出 `IndexError`。

这是「上游流式协议异常 + SDK 未防御该异常顺序」共同形成的解析故障，不是已确认的笔记或画布工具内部异常。应用原先在同一流式路径重试，未进入已有的非流式恢复，因此可能连续失败。

另有独立的应用状态缺陷：空回复重试额度在工具成功推进后没有重置，后续再次遇到空回复时会过早结束。这两条路径均已修复。SDK 已从 1.4.0 升级到 1.14.0，但升级本身不能替代应用侧修复。

## 现象与证据链

用户观察到多轮笔记、画布操作后出现通用空回复提示，或没有上游 HTTP 状态的请求失败提示。工具卡片已完成不代表后续模型响应已成功解析。

故障链路为：

1. 业务工具执行并返回结果。
2. 应用请求模型继续生成，HTTP 返回 200。
3. SDK 累积流式事件时发生列表越界。
4. 原实现重复请求流式接口；达到重试上限后以内部错误结束。

定位到的抛错位置是 `anthropic.lib.streaming._messages.accumulate_event`，访问表达式为 `current_snapshot.content[event.index]`。HTTP 200 仅说明请求建立成功，不能证明流式正文符合协议。

绕过 SDK 累积器读取真实事件，再将事件交给 SDK 累积器时，捕获到以下结构（仅列协议元数据）：

```text
message_start        content=[]
content_block_stop   index=0
message_delta        stop_reason=end_turn, output_tokens=71
message_stop
```

其中缺少 `content_block_start` 和 `content_block_delta`；内容列表仍为空，停止事件却引用第 0 个块。这与 [Anthropic 流式事件规范](https://platform.claude.com/docs/en/build-with-claude/streaming) 中内容块的生命周期不符。该样本输出预算为 8000，结束原因是 `end_turn`，不能解释为达到输出上限。

另一次请求仅返回 thinking 内容、没有可见文本或工具调用，以 `end_turn` 结束。它证明上游也可能正常结束但没有可见回复；不能据此断言它与越界事件具有相同的服务端根因。

## 与多轮工具、历史上下文的关系

检查的失败请求包含 102 条消息、49 次工具调用及 49 条对应结果；诊断检查未发现重复调用标识、孤立结果或调用与结果配对缺失。

历史上下文回放共进行了 8 次请求，使用了逐步补全后的不同请求版本，观察到一次上述异常事件和一次仅 thinking 的空回复。缩短到当前工具链的 16 条消息后，3 次请求均正常。

这些结果不能用于计算稳定故障率，也不能证明「长历史」或某个笔记、画布 schema 是触发条件：

- 原始 trace 的深层序列化存在 `<max-depth>` 截断；从数据库历史补回 7 处工具输入后，仍剩 3 处截断标记。
- 回放的 system 摘要一致，但实际消息摘要与原请求不一致，因此不是逐字节复现。
- 长短上下文对照样本少、请求不完全相同，不能形成因果结论。

目前能够确认的是解析故障机制。多轮调用增加模型请求次数及上下文规模，可能增加遇到问题的机会，但上游为什么发送这类事件仍未证实。

## 修复内容与边界

### 流式协议异常恢复

- 在异常链中精确识别 SDK 累积器内的缺失内容块越界，不把普通应用 `IndexError` 误判为上游协议问题。
- MiniMax 命中该异常且尚未输出可见文本时，使用相同请求参数进行一次应用层非流式恢复调用，不再反复走同一异常流式路径。
- 已输出可见文本时不重放请求，避免重复展示；恢复调用失败时保留异常链，不反复恢复。
- 恢复发生在模型请求层，不重新执行此前已成功的业务工具。恢复响应产生的新工具调用继续按正常流程执行一次。
- 非流式恢复仍没有可见内容时，继续经过空回复规则，不把空结果直接视为成功。
- 用户错误信息区分流式响应异常并保留诊断编号；原始异常只进入诊断通道，不向用户暴露上游正文。

主要实现：

- [`backend/agent/providers/errors.py`](../../backend/agent/providers/errors.py)
- [`backend/agent/loop/provider.py`](../../backend/agent/loop/provider.py)
- [`backend/agent/errors.py`](../../backend/agent/errors.py)
- [`frontend/src/i18n/sections/common.ts`](../../frontend/src/i18n/sections/common.ts)

### 空回复重试状态

每个连续无进展阶段最多重试 2 次；工具成功推进后重置额度。失败或等待确认的普通工具结果不重置额度，避免无限空转。

主要实现：[`reply_runtime.py`](../../backend/agent/loop/reply_runtime.py)、[`runner.py`](../../backend/agent/loop/runner.py)。

## SDK 升级与官方修复核对

devserver 的 `anthropic` 从 1.4.0 升级为 1.14.0；[`backend/requirements.txt`](../../backend/requirements.txt) 要求调整为 `anthropic>=1.14.0,<2.0.0`。安装新增其所需的 `opentelemetry-api`，未批量升级无关依赖。

截至排查日检查的 [v1.14.0 发布说明](https://github.com/anthropics/anthropic-sdk-python/releases/tag/v1.14.0) 包含其他流式事件顺序相关调整，但 [该版本累积器源码](https://github.com/anthropics/anthropic-sdk-python/blob/v1.14.0/src/anthropic/lib/streaming/_messages.py#L493) 对 `content_block_stop` 仍直接按索引访问内容块。没有证据表明升级已修复本次捕获的缺块停止事件，因此保留应用侧恢复。

## 测试脚本与验证结果

永久回归测试：

- [`test_anthropic_stream_recovery.py`](../../backend/tests/agent/providers/test_anthropic_stream_recovery.py)：使用真实 SDK 流与事件类型，验证缺块 stop/delta、恢复失败、已有可见输出、普通 IndexError 隔离，以及主循环中工具不重复执行。
- [`test_agent_loop_modules.py`](../../backend/tests/agent/test_agent_loop_modules.py)、[`test_core_loop_characterization.py`](../../backend/tests/agent/test_core_loop_characterization.py)：保护空回复额度上限及工具成功后重置行为。
- [`test_error_presentation.py`](../../backend/tests/agent/test_error_presentation.py)：保护错误分类及可见信息边界。

在 devserver 后端目录串行执行：

```sh
PYTHONPATH=. .venv/bin/pytest -q \
  tests/agent/providers \
  tests/agent/test_error_presentation.py \
  tests/agent/test_agent_loop_modules.py \
  tests/agent/test_core_loop_characterization.py
```

SDK 升级后结果：**379 passed，21.73 秒**。此前单独进行的 i18n 专项检查为 **13 passed**；这些结果不代表全仓库测试通过。

另进行了真实网络恢复验证：先注入已知异常流，再连接真实 MiniMax 完成一次非流式请求。记录到一次流式尝试、一次恢复调用，恢复返回工具调用；探针禁止业务工具分发，执行次数为 0。它验证恢复通道可用，不等同于完整业务端到端验收。

临时回放脚本曾位于本地及 devserver 的 `/tmp/gugu_anthropic_index_probe.py`，连接真实 provider，并读取经授权的真实配置、数据库历史；未执行业务工具，未修改运行配置。该脚本及临时结构探针源文件、测试文件均已清理，未作为永久测试提交。永久保留的是上述使用合成数据的回归测试；报告只记录脱敏结构摘要，不附原始用户内容或原始回放产物。临时脚本已删除，因此不提供已不存在的脚本链接或未经核实的重跑命令。

环境验证：`pip check` 无依赖冲突；服务重启后四个目标服务均处于 active，健康检查返回正常。没有在本次任务触发 GitHub CI、Docker 构建或完整后端测试。

## 剩余风险与交付状态

- 上游异常流的精确触发条件仍未知；本次修复降低其对用户的影响，没有修复 MiniMax 服务端。
- 协议识别依赖 SDK 异常帧的结构；后续 SDK 升级必须继续运行真实 SDK 事件回归测试。
- 非流式恢复不能渐进展示该轮文本；仅在无可见输出的明确协议异常下使用。
- 专项行为验证通过不代表发布级验收。静态质量检查仍提示流式处理函数复杂度增加，未将其表述为质量门禁全绿。
- 修复、依赖要求和本报告尚未提交推送；未修改用户运行配置。并行任务的其他工作区修改不属于本报告验证范围。
