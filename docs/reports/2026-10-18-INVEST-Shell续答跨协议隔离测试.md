# INVEST：Shell 续答失败的跨协议隔离测试

> 日期：2026-10-18
> 环境：devserver
> 对象：MiniMax-M3.1-Flash-Preview、Responses 与 Anthropic
> 目的：检查连续 Shell 工具后的失败是否来自本地 Responses 请求组装或 SDK 解析。

## 结论

本次没有找到可以稳定触发线上故障的应用代码缺陷，也不能据此排除原生 reasoning 状态回放或特定请求兼容问题。此前“上游返回 internal_error”的判断只说明失败事件的来源，不足以证明请求完全正确。

线上记录显示：11 次 Shell 均正常退出且没有超时，第 12 轮模型请求约 2.9 秒后收到 `response.failed / internal_error`。失败轮的 51 组工具调用与结果完整配对，无重复调用 ID、非法参数 JSON 或空普通消息。

本次受控模型调用共 25 次：22 次有效实验、3 次构造不合法的 Anthropic 试验。模型返回的工具均未执行；没有发送 IM 消息、修改模型预设或写入业务数据库。回放源使用真实开发 trace，故障状态检查采用只读数据库事务。

## 有效实验

“完成”指单轮模型响应正常结束，包括返回待执行工具调用，不代表原业务全流程已经完成。

| 实验 | 次数 | 结果 | 解释范围 |
| --- | --- | --- | --- |
| 失败轮重建，Responses SDK 流式 | 1 | 完成 | 没有恢复当时独立保存的原生 reasoning |
| 同一重建请求，Responses 原始 SSE | 1 | 完成 | 绕过 SDK 事件对象解析 |
| 同一重建请求，Responses 非流式 | 1 | 完成 | 请求体仅切换 stream |
| 在重建请求中加入合成 reasoning，流式/非流式 | 2 | 均完成 | 仅验证该结构能被接受，不代替真实状态 |
| 小上下文 reasoning 种子请求 | 1 | 完成 | 单独统计，不作为原故障对照 |
| 新生成的原生 reasoning，按驱动方式回传 | 2 | 均完成 | 使用新响应及合成工具结果，不执行工具 |
| 相同续答历史，移除该原生 reasoning | 2 | 均完成 | 只去掉 reasoning 项 |
| 相同续答历史，直接回传供应商完整 output | 2 | 均完成 | 检查驱动重建与原生项回传的差异 |
| 去重后的相同历史，Anthropic 流式 | 2 | 均完成 | 正确转换 51 组工具往返，基础 system 只保留一份 |
| 去重后的相同历史，Anthropic 非流式 | 1 | 完成 | 与对应流式请求体仅 stream 不同 |
| 额外保留一份基础 system 的压力组，M3.1 Anthropic 流式 | 4 | 3 次 api_error，1 次完成 | 不是原请求，不能归因线上故障 |
| 相同压力组，M3.1 Anthropic 非流式 | 2 | 均完成 | 样本不足以证明非流式永远稳定 |
| 相同压力组，仅将模型改为 MiniMax-M3，Anthropic 流式 | 1 | 完成 | 模型也改变默认推理行为，不能独立证明 Preview 存在确定缺陷 |

压力组的两次 SDK 失败与一次原始 SSE 失败都来自 HTTP 200 之后的上游 `error / api_error`，不是仅在 SDK 解析时发生的异常。四次流式请求规范化请求体的 SHA-256 完全一致，后一次成功；这组数据证明该压力输入的失败并非固定必现，但不能外推为原线上请求的原因。

官方 [Create Response 文档](https://platform.minimax.io/docs/api-reference/responses-create) 支持流式与非流式调用，并描述原生 reasoning/function call 输出项；HTTP 请求被接受不代表后续生成一定成功。

## 对照构造检查与剔除

- 旧诊断脚本生成的无 reasoning 请求，在驱动发送边界以相同 Provider projection 捕获后逐字段比较，差异为零。此检查不重新将 provider 消息冒充 canonical 历史，不执行网络请求。
- 三次早期 Anthropic 请求将 OpenAI 的 `role=tool` 消息直接送入历史渲染，构造不合法并返回 HTTP 400，全部剔除。后续先转换为 provider-neutral 工具块，再确认 51 个 tool_use/tool_result 完整配对、没有 role=tool 或孤立结果。
- 初版跨协议转换额外带入了一份约 5.3 万字符的基础 system。该组重新标记为压力组，没有作为“与线上相同输入”的证据；去掉重复后另行完成三次规范对照。
- 当前模型预设已为 Anthropic；Responses 回放只在探针进程的模型副本中恢复对应协议，没有修改用户配置。不能声称恢复了故障当时的所有配置或出站字节。

## 仍缺少的关键证据

线上当时启用了 continuation，驱动会在历史投影后注入上一轮原生 reasoning。当前 trace 保存了状态摘要与会话投影，但没有完整的最终 SDK 请求体。旧回放脚本不读取这份原生状态。

失败后的状态失效流程已经清空持久化密文。只读检查确认原 payload 不再存在；新生成或合成的 reasoning 不是当时的 payload。因而本报告所有“重建”均不能声称是失败请求的完整复现。

下一步最有价值的证据，是在再次发生时从驱动最终发送边界捕获失败请求及原生状态到受控诊断位置，校验请求摘要后按同一 body 重放。不得保存认证头、API Key 或客户端配置，也不得用重跑 Shell、删除历史或自动切换协议代替定位。

上述隔离实验阶段没有修改业务驱动、状态生命周期、Shell、重试策略或运行配置，也没有向运行服务植入持续探针。后续补充的失败捕获见下节。

## 测试脚本与产物

- 重建请求及 Responses 初始组使用 [`probe_responses_trace_replay.py`](../../backend/scripts/diagnostics/probe_responses_trace_replay.py)。跨协议转换、原生状态组和结构比较由独立调查进程执行；生成的请求体与结果保存在同一受控目录。
- 新增 [`probe_saved_provider_request.py`](../../backend/scripts/diagnostics/probe_saved_provider_request.py)，直接读取保存的 SDK 请求体，以原始 SSE 或非流式方式回放。最终交错流式/非流式组及去重后的规范组使用该脚本，避免重新构造请求引入隐含变量。
- 原始请求、响应和 summary 位于 `<devserver临时目录>/gugu-responses-isolation-20261018-<随机后缀>/`，根目录权限为 0700，尚未清理；包含真实开发正文，不可提交或公开分享。目录中的原始产物没有凭据或请求头。

从 backend 目录复测保存的规范请求，每次使用新输出目录：

```bash
PYTHONPATH=. .venv/bin/python scripts/diagnostics/probe_saved_provider_request.py \
  --allow-real-data --allow-real-llm \
  --request-json '<受控调查目录>/anthropic_deduplicated_request.json' \
  --protocol anthropic --preset MiniMax-M3.1-Flash-Preview \
  --output-dir '<受控调查目录>/repeat-stream'
```

增加 `--non-stream` 仅切换流式开关；`--model MiniMax-M3` 仅覆盖请求模型名。原始 Responses 重建请求可从 `original-1/request.json` 读取并改用 `--protocol responses`，但仍有前述原生状态缺失限制。

脚本默认拒绝读取真实数据和联网；两项危险开关缺失分别退出 2。`--allow-real-data --dry-run` 只输出字段名、请求摘要与传输模式，不读取运行预设或发起请求。脚本不会运行返回的工具、写数据库或覆盖运行配置。

## 后续：失败轮精确请求捕获

Responses 驱动在创建请求最终失败、流式消费异常或收到 `response.failed` 时，将当轮最终 SDK 请求捕获到已启用的 LoopScope。失败 LLM 节点下新增 `Responses 失败请求` 子节点，记录失败类型、规范化请求 SHA-256、原生 reasoning 项数和完整 `request_json`；正常轮不新增捕获节点。

`request_json` 使用完整 JSON 字符串，而非嵌套对象，避免通用 trace 对象序列化的深度上限改写深层工具 Schema。此记录只写 Collector/SQLite，不写普通日志；客户端认证配置不属于 SDK body。发现当前 Provider Key、认证字段或已知凭据模式时，整份捕获标记为不可回放，不保存替换过凭据的伪原始请求。该检查不是对任意自然语言秘密的完整识别，导出仍按受控开发数据管理。

从 Collector 数据库只读读取失败捕获，先离线校验：

```bash
PYTHONPATH=. .venv/bin/python scripts/diagnostics/probe_saved_provider_request.py \
  --allow-real-data --dry-run --trace-db '<LoopScope数据库>' \
  --run-id '<Collector run ID>' --round 12 --protocol responses
```

将 `--dry-run` 替换为 `--allow-real-llm --preset '<对应预设>' --output-dir '<新建受控输出目录>'` 可进行原始 SSE 回放，增加 `--non-stream` 进行单变量对照。没有精确捕获、同轮多份捕获、协议不符或摘要不匹配时拒绝执行，绝不回退到历史重建。预设仅在进程内读取，认证与网络配置仍来自当前配置；因此只能保证捕获 body 的一致性，不声称恢复原网络条件或供应商内部状态。

捕获不改变重试、协议选择、reasoning 生命周期或 Shell 执行。再次拿到失败样本后，优先比较同一 body 的流式与非流式结果，再做仅移除 reasoning 项的对照；不提前把偶发失败归因于 SDK 或供应商。

### 后续验证与生效状态

- 后端串行运行失败捕获、reasoning 驱动、trace 恢复、快照分支请求前缀回归，共 73 项通过；新增捕获测试覆盖正常响应不记录、失败原生项保留、凭据拒绝、捕获后源对象变化、深层 Schema 往返，以及缺失或篡改捕获时拒绝重放。
- Collector HTTP 合成测试 2 项、存储测试 3 项通过；新增 HTTP 用例经过真实 Collector、Schema 校验和临时 SQLite，确认 UI 读取接口返回的子节点关联和 `request_json` 不变。复用现有通用 Input 展示，不增加前端业务逻辑。Collector TypeScript 检查通过。
- 本轮新增测试元数据以 HEAD 为基线校验通过；全分支默认基线校验另有既存 `providerWebSearch.test.ts` 元数据缺项，不在本次范围内修改。
- 经用户确认重启 devserver 四个后台服务，服务均恢复运行，后端健康检查正常，Worker 已开启 LoopScope。没有切换模型预设；只对后续实际走 Responses 的失败轮生效。
- 这些是合成回归与服务健康验证，没有再次调用真实模型、执行 Shell 工具或发送 IM 消息，也没有取得新的线上失败样本。根因仍待真实捕获对照确认；定位完成后应清理临时捕获接入。
