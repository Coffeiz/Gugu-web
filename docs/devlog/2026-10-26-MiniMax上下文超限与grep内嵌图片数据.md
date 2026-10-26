# MiniMax 上下文超限与 grep 内嵌图片数据

## 现象

一次 QQ 私聊请求失败，用户侧看到：

```text
MiniMax 请求失败（上游 400 BadRequestError，错误码 2013 / invalid_request_error：
请求参数错误，请检查模型、接口格式和请求参数）。诊断编号 D4FB27C41A294589；
MiniMax 请求 ID：072d77af4fca321ae7ccc8c7d7b8fdd7
```

会话是 `gugu:qq:388`，失败发生在第 9 轮模型请求（本地时间 2026-10-26 02:04:35）。

## 根因

失败请求的上下文里，文件 `grep` 的结果包含 minified SVG 的内嵌 `data:image/...;base64`。
`grep` 原先按整行返回文本，minified SVG 是超长单行，于是整行连同图片编码一起被送进
模型上下文。上游 MiniMax 的真实输入窗口约 100 万 token，这份请求的输入约 108 万 token，
直接越界，上游返回 `invalid params, context window exceeds limit (2013)`。

这次失败**没有调用图片读取工具**：问题不在图片附件，也不在 Base64 图片块的 provider 编码，
而是 grep 把 SVG 源码里的 data URI 当普通文本塞进了工具结果。

### 三层叠加

1. **主因（工具输出失控）**：grep 只按命中**条数**截断，没有单行或总字节上限。
   单次工具结果 1.41 MB，占整个请求的 62%；其中 12 段 base64 共 1,367,104 字符，
   占工具结果的 97%。
2. **第二层（恢复路径漏判）**：`agent/context/budget.py` 的 `is_context_overflow_error()`
   只认 `context window exceeded`（过去时），MiniMax 说的是 `context window exceeds limit`
   （现在时 + limit）。判定返回 False，导致 `agent/loop/runner.py` 里两道恢复分支
   （摘要压缩 → 确定性截断）全被跳过，400 直接抛给用户，`attempts=0`，零重试。
3. **第三层（文案误导）**：上游把上下文超限也归进 2013 这个通用参数错误码，
   应用侧 `_ERROR_MESSAGES["2013"]` 与前端 `code2013` 都压成「请求参数错误，
   请检查模型、接口格式和请求参数」，把「内容太长」说成「参数格式不对」。

## 证据链

### 原始请求体确实还在

最初以为 LoopScope 没有留下原始 trace，后在 `loopscope/data/loopscope.db` 的 `spans` 表里
找到了它：run 状态 `error`，span 名 `LLM round 9`，时间 `2026-10-25T18:04:29Z`
（= 本地 02:04:29，与失败时刻逐秒对上），`input_json` 2,255,765 字节。

这份原文的构成：

| 指标 | 值 |
| --- | --- |
| 消息数 | 171 |
| data URI 段数 | 12 |
| base64 字符总数 | 1,367,104 |
| 命中文件 | `ethereum.svg`、`bsc.svg` |
| 最后一条消息 | `user`，内含一个 1,408,865 字节的 `tool_result` 块 |
| usage | 空（失败 run 没有 usage 记录） |

对应的是 `grep(query="COTA")`，扫描 63,670 个文件后返回 6 个命中。

### 逐轮轨迹：一步越界

LoopScope 的 span 序列完整记录了这次 run 的每一轮模型请求：

| 轮次 | 请求体字节 | provider 上报 input | 状态 |
| --- | --- | --- | --- |
| 1 | 542,289 | 179,591 | success |
| 2 | 549,553 | 181,612 | success |
| 3 | 555,997 | 183,461 | success |
| 4 | 585,571 | 196,311 | success |
| 5 | 587,378 | 196,754 | success |
| 6 | 589,559 | 197,363 | success |
| 7 | 593,386 | 198,778 | success |
| 8 | 607,585 | 204,910 | success |
| **9** | **2,029,858** | — | **error（400 2013）** |

第 8 轮结束时 provider 上报的上下文用量是 204,910 token，低于本地触发阈值
（`context_tokens` 256,000 的 90% = 230,400），所以**没有触发压缩**；
紧接着第 9 轮的 grep 回执把请求体从 607,585 字节抬到 2,029,858 字节，
一步增加约 142 万字节、约 90 万 token，直接越界。

这说明本地预算不是「配小了」，而是**结构性看不见这一跳**：压缩触发只看
provider 上一轮回报的 usage，本轮新追加的工具结果在下一次请求发出前不参与判定。

### 上游自己怎么数这份请求

用 MiniMax 的 `count_tokens` 端点（不产生输出 token、不计费）直接问上游：

- 原样发送这份请求 → `{"input_tokens": 0}`：请求已经装不进窗口，上游连数都不数。
- 把 12 段 data URI 换成占位符 → `input_tokens = 183,911`，请求体 707,309 字节。

按比例截断 base64 载荷扫一条曲线，斜率稳定在 **1.52 字节/token**（对比：中文 4.42、
普通 ASCII 3.91），据此外推原请求的真实输入：

```text
183,911 + 1,367,104 / 1.52 ≈ 1,080,000 tokens
```

三组独立拟合给出 1,076k / 1,078k / 1,081k，取 **≈108 万 token**。

上游停止计数的边界在本请求形态下落在 914,235（正常返回）与约 92 万之间，
即名义 100 万窗口之外还要预留输出与思考余量；用 `messages` 端点单独标定时
90 万 → 200、100 万 → 200、1,048,576 → 400，与名义 100 万窗口一致。

### 复现

按线上构成重建请求（2.26 MB，其中 1.37 M 字符 base64）真实发送，
上游返回 **HTTP 400，文案与线上逐字一致**：`invalid params, context window exceeds limit (2013)`。

## 修复

### 主修：grep 的输出必须有内容级上限

- 搜索前把 `data:[...];base64,...` 替换成短标记：编码载荷既不参与关键词匹配，
  也不进入模型上下文；载荷之外的正常文本命中照常保留。
- 超长行按命中位置截短到 700 字符，命中词在窗口内。
- 整批序列化结果限制 128 KiB，超出时保留靠前命中并停止继续扫描。
- 用 `truncation_reasons`（`embedded_data_uri` / `match_limit` / `line_length` /
  `result_byte_limit`）说明省略原因，让模型知道自己拿到的是节选。
- 工具 description 同步说明截断行为。

### 配套一：溢出分类要认 MiniMax 的措辞

`agent/context/budget.py` 抽出 `CONTEXT_OVERFLOW_PHRASES` 常量并补上
`context window exceeds limit`。命中后 `agent/loop/runner.py` 的既有恢复链会接管：
先摘要压缩，再走确定性截断，
各一次，失败才明确收尾。

### 配套二：2013 区分上下文超限

- 后端 `agent/providers/minimax/__init__.py` 按上游文案识别上下文超限，
  给出专用文案与 `chatUi.minimaxErrorCodes.contextOverflow`，
  而不是笼统的「请求参数错误」。
- 前端 `chatUi.minimaxErrorCodes` 补 `contextOverflow` 的中 / 日 / 英三份文案。

**判定与定性用两份清单**：判定走不走压缩/截断兜底用宽清单
`CONTEXT_OVERFLOW_PHRASES`（含 `request too large` 这类 413 体量语义——请求体过大时
截断兜底仍然有效）；给用户定性用窄清单 `CONTEXT_WINDOW_OVERFLOW_PHRASES`，
只包含明确指向模型上下文窗口的措辞。否则「请求体过大」会被说成「上下文超限」，
把用户引到缩短上下文这个无效方向。

## 验证

后端定向回归（devserver 串行）：

```text
PYTHONPATH=. .venv/bin/pytest -q \
  tests/agent/providers/test_minimax_error_details.py \
  tests/agent/context/test_context_overflow_classification.py \
  tests/agent/knowledge/test_grep_tool.py
25 passed
```

- 复现用例构造单行 SVG，含 12 段、合计 1,367,104 个 Base64 字符，并在载荷内外
  放置相同搜索词。验证：载荷内容不产生命中、不进入返回结果；载荷外命中保留；
  长行和返回字节数均受限；超限分类能认出 MiniMax 原始超限文案。
- `test_minimax_error_details.py` 覆盖 2013 的两种分支：上下文超限走专用文案，
  其它 2013（例如 thinking 相关）仍保持通用参数错误文案。

后端全量回归（`tests/agent`，devserver 低负载串行）：

```text
2409 passed, 1 skipped, 74 warnings in 1411.91s
```

前端 i18n 三语 key 一致性扫描（`node scripts/check-i18n-static.mjs`）通过；
改动文件单独类型检查（`tsc --noEmit` 指向 `src/i18n/sections/chat.ts`）通过。

全量 `vue-tsc --noEmit` 未取到结论：共享 devserver 当时负载冲到 150+，
在 25 分钟预算内未跑完（exit 124）。本次前端改动只涉及 i18n 文案表新增一个 key，
未触及组件与类型定义；全量类型检查留待 CI 的 frontend typecheck 复验。

## 经验与约束

- **Base64 是「隐形的高密度载荷」**。同一份字节，1.52 字节/token 是中文的近 3 倍。
  应用侧若按「4 字符 1 token」估 base64，会把 137 万字符估成 34 万 token，低估近 3 倍——
  本地估算本身就看不见这次超限。工具输出必须按**字节**设闸，不能按字符或按条数。
- **通用错误码不能直接当语义用**。2013 同时覆盖「上下文超限」和「参数非法」，
  只有上游文案带真实信息。判定和文案都必须读文案。
- **上游超限的兜底路径要先于错误文案存在**。分类漏判会让压缩与截断两道恢复全部失效，
  一次 400 直接变成用户可见的硬失败，零重试。
- **诊断数据要落在能取回的地方**。这次失败 run 的中间轮次在 DB 侧没有落库、usage 也没落库，
  差点导致「无法精确重建」。最终是靠 LoopScope 的 span 原文才拿到真实的 2.26 MB 请求体。

## 尚未处理（建议后续单独排期）

- `read_file` 对文本文件仍可返回最多 32 MB，且同时给出 `content` 与 `numbered_content`
  两份，同属「单个工具结果撑爆上下文」的风险面，只是这次没被触发。
- 工具结果在**发请求前**没有总体预算闸门：压缩触发只信 provider 上一轮回报的 usage，
  本轮新追加的工具结果在下一次请求前不参与判定——这次就是第 8 轮判定「不压缩」
  （204,910 token，离 230,400 的触发线还差 25,490），第 9 轮一步加了约 90 万 token。
  可考虑对「本轮待发工具结果」单独做字节闸，而不是只收紧单个工具。
- 失败 run 的中间轮次与 usage 不落库，事后只能靠 LoopScope 原文回捞。
- 本地凭据里的 `context_tokens` 配的是 256000，与上游真实 100 万口径差 4 倍；
  这会让本地提前压缩，但**不是本次失败的原因**——真正的缺口是上面那条
  「本轮工具结果不参与判定」。
