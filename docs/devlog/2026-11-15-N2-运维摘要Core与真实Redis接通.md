# N2 运维摘要 Core 与真实 Redis 接通

新增目标结构的 `GET /api/v1/admin/ops/summary`，真实消费者为 `apps/web/src/views/Admin/Ops/index.vue`。生产链路为 `main/app → modules/admin/ops-summary → Core admin/ops-summary → createRedisHashReader → Redis ops 按日 hash`；管理员认证由 Host 提供。包导出和生产组合根由主会话增量接线。未修改现有 `domains/admin/admin-ops-summary.ts` 原型，也未将新链路指向旧兼容转发。

## Python 行为与业务边界

基线为 `backend/app/api/v1/ops_admin.py:ops_summary` 和 `backend/app/core/opsmetrics.py:summary`。Core 读取工具、延迟、安全、邮件、文件系统授权五类日 hash，汇总近 1–14 个 UTC 日，保持工具排序、完整零值、未知安全事件、延迟桶/P99 和邮件错误码计数；邮件正文、主题及地址不是该指标来源。

使用与 Python 相同 Redis 键，真实 Node 文件系统授权生产者也写其中的 `ops:filesystem-auth`，不是没有消费者或生产者的新队列。迁移本读接口不代表全部 Python 工具/邮件计数生产者已迁入 Node。无 DB 业务查询或写入；生产 Host 测试使用隔离 PG 仅供既有基础设施初始化，不能据此声称双库业务适配完成。

Host 解析 HTTP 参数、建立认证和映射错误；Core 负责完整聚合用例。新增 Redis 只读 hash reader 复用现有连接、认证、TLS、超时和 RESP 字符串传输，Lua 仅把 HGETALL 数组编码为 JSON，不改 hash、不采集或启动任务。检查了该适配器其他会话已有 102 行增量，仅增加本次 reader；保留全部已有修改。

## 红灯、修复和最终验证

全部测试、Python 对照、构建与 typecheck 在 devserver；Python 串行，所有指标为私有测试 Redis DB9 的合成数据，测试开始确认精确日键不存在，结束只删除本次精确键，不使用 FLUSH。

1. 移植旧回归场景到目标 route 测试，先执行 `node --import tsx --test tests/admin/ops-summary.test.ts`，退出 1：目标 module 尚不存在。此时没有新增 Core/Host 实现。
2. 实现后，真实生产 Host 初次读取得到 503 而非预期 200：Redis Lua cjson 将空 HGETALL 编为对象，而 reader 需要数组。修改 Lua 在空结果时明确返回 `[]`，保留断言。
3. 下一次真实 Python 全字段对照失败：输入 `session:granted:ignored`，Python 不计数，Node 沿用原型的 split 限制误计 granted=3。按 Python partition 保留整个冒号余串，修复后串行 Core build 退出 0。
4. 协议补充测试先红：`days=1e0` 被 Ajv 错收为 1（200，预期 422）。改为原始查询解析，兼容整数小数 `1.0`、下划线整数和重复参数取最后值，拒绝科学计数法；Python Pydantic 类型解析对照也确认该语法。
5. 最终 `tests/admin/ops-summary.test.ts` 5/5、`tests/host/ops-summary-main.integration.test.ts` 1/1、未修改的旧原型回归 `tests/admin/admin-ops-summary.test.ts` 4/4：合计 10/10，0 跳过。生产测试调用真实 `startServer`，登录管理员后读取真实 Redis，并启动实际 Python handler 对同一 Redis、相同 UTC 日期及 days=2 计算完整响应逐字段比较；不是测试替身替代正式 Redis。

生产回归还覆盖未认证 401、空 hash、错误 Redis 类型、无 Redis 配置明确 503 和脱敏。工具及邮件 `1/32` 失败率按 Python IEEE754 half-even 舍入为 `.0312`，未使用 JS toFixed 近似替代。测试附加场景有部分在初始切片红灯之后编写；只有科学计数法补充场景另行取得明确行为红灯，不宣称每条场景都单独先红。

邻近 Python pytest：`tests/platform/observability/test_trace_ops.py -k 'bucket_edges or security_events_defined or record_security_no_loop'` 3/3，15 未选；不把这三项当作 handler 对照。真正 handler 对照由 `tests/admin/fixtures/ops_summary_python.py` 在上述生产 Node 测试中完成，fixture 使用临时配置路径，默认拒绝未显式标识的隔离 Redis。

最终 Core build 和 Host `corepack pnpm typecheck` 都退出 0。Core、Host route、Redis adapter、生产测试和 Python fixture 5 项本地/远端 SHA-256 一致。局部 `git diff --check` 通过；ripwire edit-check 为新目标目录 `no-baseline`，quality-delta 因无基线未形成通过证据。

## 主动差异与未验收范围

Redis 未配置、不可达、错误类型或非法计数统一返回脱敏 503 `暂时无法读取运维指标`；Python 原 handler 会传播部分依赖异常，未把它们伪装成零值。超出 JS 安全整数范围的单个计数明确拒绝，未声称完全复刻 Python 任意精度计数。真实部署、Redis ACL/TLS/代理、14 天大数据及所有 Node 指标生产者未验收。

未读取或修改真实运行配置/用户数据，未调用真实外部 Provider，未测试 Docker，未提交、推送、fetch 或触发 CI。

## 本轮额外盘点

同时核对了账号删除、BYOK、交互恢复和终端：

- `DELETE /auth/me` 与 `DELETE /admin/users/{user_id}` 共享 Python `account_deletion.delete_account`：先删按 file_id 的缩略图、两个历史用户存储前缀，尽力清 Redis 暂存与 IM reach，再 DB cascade/commit，最后广播 auth-state。用户需密码，管理员需审计；缺共享完整存储/账号清理且本轮禁止破坏性文件操作，未简化成删用户表。
- BYOK POST/PATCH 有加密主密钥版本、同 capability 启用切换、联网搜索能力校验、目的地绑定/空 Key 规则、continuation 失效和事务；Core 当前只有独立删除与状态用例，不能借 gcm1 普通 secret adapter 代替 BYOK envelope。模型/媒体/试呼还依赖待对齐 Provider resolver、预览复用 Key 安全裁决和真实协议探测。未扩整个 BYOK 领域。
- `POST /agent/interactions/{prompt_id}/resume` 与 `/resume-text` 调用 Python `consume_action/consume_text` 后必须唤醒原等待 Run，拒绝无 tool_call_id 的交互。当前 Node 有通用 coordinator 和恢复 worker 原型，但生产 main 未装配完整等待 Run/worker/确认执行器闭环；不能只写收据或恢复队列。
- 终端剩余 12 个接口逐核：列表/metrics/detail/PATCH/reopen 仍需真实 page_access、pty_access、授权和 sandbox readiness；列表还会 prune/enforce cap；POST 创建要工作区绑定；events 需序号回放、账户停用结束与实际 broker；input/cancel/terminate/reset/ws 需执行、取消、PTY 续存与租约及断开清理。当前目标只有独立删除视图用例，不能把它等同完整 terminal manager。真实消费者为 `services/api.ts:terminalsApi`；不能仅固定拒绝和空统计。

这些盘点没有额外修改实现或完成状态；发现的独立可接通切片是本记录的 ops summary。
