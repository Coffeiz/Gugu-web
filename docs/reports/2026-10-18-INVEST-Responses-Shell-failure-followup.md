# 调查补充：BYOK Responses 的 Shell 后续请求失败

> 日期：2026-10-18
> 范围：QQ 会话中的 BYOK Responses 请求；只记录可验证的诊断事实。

## 配置确认

用户补充其 BYOK 设置使用 Responses。只读核验会话生效配置后，确认该故障请求使用 BYOK、MiniMax、`responses` 格式和 `MiniMax-M3.1-Flash-Preview`；不是 Anthropic，也不是服务器预设接管请求。推理持久化配置为 continuation，但 22:53 失败请求中实际没有原生 reasoning 项，因此该次 `internal_error` 不能归因于错误回放了 reasoning 项。

## 已确认的故障样本

| 时间（本地） | 响应结果 | 轮次上下文 | 可确认事实 |
| --- | --- | --- | --- |
| 10:39 | `response.failed / internal_error` | 第 12 轮；此前 11 次 Shell 均成功 | 上一轮模型输入约 159.7k token；失败轮估算输入约 211.8k token。该时刻没有捕获最终请求 body，不能做精确重放。 |
| 22:53 | `response.failed / internal_error` | 第 3 轮；前两次 Shell 均成功退出且未超时 | 精确最终请求已捕获并通过摘要校验；436 个输入项、121 组完整工具调用/结果配对、102 次 Shell 调用；没有重复调用 ID、无效参数 JSON 或未注册工具。输入约 189.1k token，原生 reasoning 项为 0。 |

这两次失败均发生在 Shell 工具进程已返回之后、下一轮 Responses 请求期间。它们不是 Shell 命令执行异常。此相关性仍不足以证明 Shell 导致上游拒绝或内部错误。

## 精确重放

对 22:53 捕获的同一请求 body，使用已核实的有效 BYOK 配置进行了 6 次官方 Python SDK 流式重放，全部收到 `response.completed`，输入 token 均为 189,079；另有一次原始 SSE 直连重放也完成。重放生成的工具调用没有执行。由此可排除“该 body 必然失败”这一确定性解释，但不能还原或排除供应商在故障时的瞬态状态。

另一个约 22:39 的故障属于 `create_exhausted`：当时没有记录 SDK 异常分类。精确 body 以有效 BYOK 重放 3 次均完成。这与收到明确 `response.failed` 终态的两例属于不同故障阶段，不合并统计。

## 当前判断与限制

- 可确认失败轮收到了 Responses 服务端发出的 `response.failed` 终态；本地 SDK 将它映射为 `ResponsesStreamError`。因此这两例不是仅由本地 SSE 解析器伪造的失败状态。
- 22:53 捕获的请求结构完整且可重放，连续重放成功；当前证据更符合间歇性上游/传输故障，而非可稳定复现的 Shell 历史组装错误。
- 现有证据不能证明 MiniMax 官方服务发生了广泛事故，也不能解释为什么用户观察到的故障都与 Shell 使用相邻。一次失败后多次成功不等价于根因已查明。
- `response.failed` 发生在请求已建立之后；当前驱动在此终态直接报错，不进行整轮自动重试。是否安全重试需要单独评估已提交文本、工具调用和副作用，不能在此诊断中无条件重放 Shell。

## 后续诊断探针

为捕获下一次 `create_exhausted` 或流异常的分类，失败请求诊断节点新增受限 `exception_chain` 元数据：只记录异常类名、有效 HTTP 状态码，以及符合字符白名单的 `code/type/param/request_id`；不读取或保存异常正文、响应正文、请求头或凭据。提取失败不会覆盖原 Provider 异常。此变更不改变请求、重试、协议选择或 Shell 执行。

本地及 devserver 的定向测试均为 14 项通过，覆盖异常链分类和异常正文不落入捕获数据。devserver 后端健康检查正常，探针随已授权的服务重启加载。探针应在获得足以区分故障阶段的新真实样本后清理；任何样本均应继续通过受控 LoopScope 诊断读取，不能写入普通日志或提交原始请求内容。

## 截止前观察

2026-10-18 23:52 至 2026-10-19 01:32（本地时间）只读跟随 devserver 后端诊断日志，监控期间未发现新的 `response.failed`、`internal_error`、`llm.stream_exhausted`、`create_exhausted` 或流异常标记。观察覆盖的只是该日志源，并非 LoopScope 数据库的实时轮询；因此结论是“本窗口未复现”，不能证明问题已消失。
