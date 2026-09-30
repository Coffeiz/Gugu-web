# Anthropic 工具轮 thinking 历史恢复与跨 run 缓存前缀

## 现象

同一会话先执行工具，下一轮继续对话时，provider 的 round1 缓存命中明显低于上一轮最后一个 round。排查范围限定为 BYOK Anthropic 兼容 API 的真实请求，不通过浏览器模拟。

## 根因

签名 `thinking` 是 provider 专属状态，不应写入 canonical conversation history；但旧续接状态只保存最近一轮的 thinking。工具调用轮的 `thinking` 因而不会出现在 canonical 历史中，跨 run 重建请求时，较早的 assistant 工具轮缺少原签名块，provider 请求前缀与前一 run 的最后 round 不一致，降低了可复用缓存前缀。

## 修复

- 在加密 provider continuation state 中按 `tool_use` ID 保存各历史工具轮的 thinking blocks，并保留无工具最终轮的 tail blocks。
- 新 run 只为仍存在于 canonical history 的工具调用恢复对应 thinking；在 provider 出站投影中将其插回工具调用前，不改写数据库中的 canonical history。
- 重复执行恢复不会重复插入 blocks；已有历史 thinking 的消息不再重复补入。
- 临时诊断探针只记录过数量、消息序号与哈希指纹，已在定位后移除；正文和签名内容没有进入 trace。

## 真实复测

使用 devserver 上的 Python 脚本直接调用现有 `run_collect`，两步共享同一会话：

1. 第一 run 明确要求并确认真实调用 `web_search`；LoopScope run：`run-590740d1279c-a102f7`。
2. 第二 run 基于前一轮继续对话，要求不调用工具；确认无工具调用且只有一个 LLM round1。LoopScope run：`run-bafb3a72ecda-ebe5a6`。

第二个 run 的 provider 诊断显示 3 个历史 thinking 均按工具 ID 命中并恢复（3/3），两个 cache anchors 保留。provider usage：cache_read 28,683、fresh_input 2,540、cache_ratio 91.865%。

旧行为样本 `run-bbfe2f1f9cd9-af0dd6` 的 round1 cache_ratio 为 78.255%；中间样本 `run-2a993b69bdfe-44c0e7` 为 79.907%。真实搜索结果、工具轮次及上下文长度并不完全相同，因此这不是受控同输入 A/B，比例只作方向参考；3/3 的 provider 结构恢复是本次直接验证的修复不变量。

脚本需显式建立并结束 LoopScope trace，并等待 trace 上报任务完成；否则 `asyncio.run()` 关闭事件循环时，上报会被丢弃，造成复测没有可检查的 LoopScope run。

## 回归验证

- 新增多条历史工具轮恢复测试，覆盖每一轮签名 thinking 回到其对应调用前，且重复恢复不产生重复块。
- 本地及 devserver 定向 pytest：51 项通过。
- 临时探针已移除；本次修复与测试留在工作区，未单独提交。

## 后续调查：JSONB 重排工具参数键序

用户重启后端后提供会话 909 的连续 run：`run-894713f87950-b3c8d2` 最后 round5 缓存读取 59,410 / 总输入 62,720（94.7226%），`run-b777f5d8f7a1-b7f42b` round1 缓存读取 39,192 / 总输入 63,904（61.3295%）。这说明只恢复 thinking 还没有完成跨 run 的前缀保真。

本次实际请求结构显示历史第 28、30、32 条 assistant 工具轮均已恢复 thinking；system 和工具 Schema 摘要一致。按现有 provider 投影重建并恢复 thinking 后，前 34 条消息逐条语义相等，但工具参数对象的键序不同：实时轮为 `max_results, query`，数据库重建轮为 `query, max_results`。查询 devserver 的实际列类型确认 `conversation_messages.content_json` 是 PostgreSQL `jsonb`，与 ORM 声明的泛型 JSON 不同；JSONB 不保留对象键序。

使用会话对应用户的实际 BYOK MiniMax-M3.1-Flash-Preview 配置发起五次受控请求。测试内容是虚构记录，不执行工具、不改会话或运行配置；唯一变量是工具 input 的键序。A 为原顺序，B 为相反顺序：

| 请求 | fresh input | cache read |
| --- | ---: | ---: |
| A1 首次建立 | 7,917 | 186 |
| A2 原样重复 | 2 | 8,101 |
| B1 仅交换键序 | 6,451 | 1,652 |
| B2 原样重复 B | 2 | 8,101 |
| A3 回到 A | 2 | 8,101 |

因此 MiniMax 对工具参数的序列化顺序敏感，JSONB 的键序变化可以独立复现缓存断裂。原 trace 的缓存读取退回约 39k，也与首个参数键序变化工具轮之前的上下文规模相符。

修复复用已有 canonical 工具参数字符串保真路径：Anthropic 解析工具调用时同时封存有序 JSON 字符串，canonical `arguments` 保存字符串，出站回放时解析为保持原顺序的对象。无需修改数据库列或迁移业务数据。历史已丢失的键序无法从 JSONB 逆向恢复；thinking 历史恢复仍然必要，应保留。

## 键序保真修复与复测

- 新增回归测试经过真实 Anthropic Driver 解析、live 工具轮、canonical 持久化及历史回放路径，模拟 JSONB 对对象键序的重排，比较最终工具 input 的序列化结果；包含嵌套对象、数组、null 和空对象。修复前非空嵌套参数失败、空对象通过；修复后均通过。
- 本地和 devserver 定向 pytest 均为 88 项通过，覆盖工具往返、usage、thinking 续接、canonical history 和跨 run 前缀。
- devserver 新建独立测试会话，仅调用真实搜索、不修改业务项目及用户运行配置。第一 run `run-dcde02bd9a24-f551f2` 确认执行工具，3 个 LLM rounds；最后 round cache read 25,794 / input 27,475（93.8817%）。第二 run `run-85b35c9f1fef-1b5417` 无工具调用，仅 round1；cache read 27,533 / input 27,700（99.3971%），fresh input 167。
- 进程内临时截获出站请求，仅用于比较；共同前缀 14 条消息语义无差异，工具 input 的序列化无差异；实际数据库中两个工具调用的 `arguments` 均为字符串。截获代码没有写入应用源文件。
- 脚本结束时出现子进程 transport 在事件循环关闭后的析构警告；两个 run 均无错误、trace 上报完成，此警告不属于 provider 调用或缓存失败。

受控键序 A/B 证明根因；真实工具 run 加后续对话验证完整持久化路径。不同真实 run 的比例不是相同输入 A/B，不能作为固定性能承诺。旧历史参数顺序已经丢失的会话可能仍需重新建立缓存；本修复保证新产生的工具历史不再发生该重排。

## 验收与补丁整理

用户确认 devserver 实测已修复。提交前补跑 Web 后台生成配置传递回归，与前述定向测试合计 101 项通过。BYOK 请求已经解析的 `run_config` 必须传入后台生成任务，否则其推理续接策略可能丢失；该修复与 thinking 恢复、参数键序保真分别承担不同职责，均保留。

临时探针和已否定的运行时补丁没有残留，不为凑清理改动而删除必要逻辑。提交只纳入本次缓存调查相关代码、行为测试与记录；工作区其他部署、CRUD、UI 和测试整理改动保留，不混入本次提交。
