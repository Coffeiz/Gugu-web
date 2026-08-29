# OPT-LLM-16：工具 Schema 优化实施报告

## 结论

Phase 0-1 已完成第一批落地。全量工具基线为 100 个工具、完整定义约 59,757 字符；20 个脱敏场景的评测已拆为工具轨迹、参数契约和任务结果三层，不再把合理核实调用、测试期望错误和 Schema 校验错误混成一个错误率。

## 高风险契约清单

| 工具 | 发现 | Phase 1 处理 |
| --- | --- | --- |
| `copy_file` | 来源字段可全部省略或同时出现 | 增加来源二选一约束 |
| `send_file` | 文件、URL、附件来源没有互斥约束 | 增加四选一来源和 URL 标题依赖 |
| `add_event_reminder` | 活动定位可为空，提醒输入可冲突 | 增加活动定位二选一和提醒互斥 |
| `update_todo` | 修改动作全部可省略，多个动作可同时出现 | 增加 `action` 分支，并保留旧字段兼容 |
| `search_conversations` | 搜索与列最近对话共用宽松结构 | 明确 query/queries/兼容别名/最近对话分支 |
| `http_get` | 已有 URL 单个/批量互斥约束 | 保持现状 |

## 验证

新增 `backend/tests/test_tool_schema_phase1.py`，与现有 Schema validator、HTTP URL 约束测试合计通过 28 项。测试覆盖合法调用、空对象、互斥来源、条件字段、旧 `update_todo` 调用和最近对话无参数分支。

Phase 3-4 定向回归在 devserver 通过 13 项；能力注入、LoopScope trace 和 HTTP Schema 相关回归通过 40 项。当前工作区未提交，待后续 Phase 5 A/B 测试统一提交报告。

## Phase 5 description 优化

通过 `backend/scripts/audit_tool_descriptions.py` 对 devserver 的 101 个注册工具进行审计，并压缩第一批高成本工具的顶层说明：`move_items`、定时任务、`call_tool`、`create_skill`、画布创建/更新工具。工具级 description 当前均不超过 100 字符；字段 description 保留日期格式、清空语义、资源边界和确认要求等不可由 Schema 结构推断的信息。下一阶段进入 Phase 6 A/B，比较完整 Schema 的 token 与工具准确性。

## 后续边界

本阶段只完成契约表达和 handler 参数规范化，不改变文件、日历或项目业务数据，也没有把条件 Schema 的 provider 兼容性视为已验证。旧调用的集中版本适配和真实 provider wire-level 测试留在后续阶段。

## Phase 2 更新

已完成 `all_day`、附件 `source`、复制 `destination`、发送 `source_type`、提醒活动定位和 `update_todo.action` 的 Schema/handler 改造。旧调用仍保留兼容分支；新字段进入调用时由 Schema 与 handler 双重校验。devserver 定向回归测试通过 29 项。
## Phase 3-4 实施更新（2026-08-29）

- `create_project` 已改为要求 `start_date` 与 `deadline`，不再在 handler 中生成今天/一周后的隐式日期。
- 增加统一旧调用适配入口；当前仅转换无歧义的 `create_event.all_day`，其它缺失业务信息的旧调用返回结构化校验错误。
- LoopScope 已在保留单次脱敏 trace 的基础上，聚合 `by_tool`、`by_field_path`、`by_error_kind` 和 `by_provider`，不记录参数值。
- 轻量模式的错误恢复继续只回注失败工具的当前 Schema，未改变全量工具注入策略。

## Phase 5 全量 description 复核

全量复核结果：101 个工具、394 条字段 description；顶层 description 超过 100 字为 0 条，字段 description 超过 50 字为 0 条，字段说明总字符数为 7,057。后续新增或修改工具时，必须重新运行审计脚本并保持这两个长度门槛。

## Phase 6 完整 Schema 前后对照

按 Git 基线与当前 devserver 版本，仅比较两版共同存在的 71 个工具，避免工具数量变化污染结果：旧版完整 OpenAI Schema 为 42,712 字符（约 10,678 token），当前版为 41,126 字符（约 10,281 token），减少 1,586 字符，约 3.71%。这只是结构/token 对照，不等同于模型准确率；旧版 20-case 真实模型脚本源码当前不在工作树，准确率、恢复轮数和真实业务成功率仍待用同一批脱敏 case 补测。

## Phase 6 完整 Schema A/B（2026-08-29）

已用 devserver 的真实 provider 配置，对固定 20 个复杂脱敏场景执行 shadow A/B。两组都注入全量工具 Schema；`prd_compact_full` 仅移除 `description`、`title`、`default`、`example/examples` 等结构可表达或非必要元数据，工具执行统一拦截为 no-op，不写入真实数据。每个方案先完整预热同一批 20 个 case，再测量第二遍；预热结果不计入汇总，避免 A/B 顺序造成冷缓存偏差。

| 指标 | 当前全量 Schema | 精简全量 Schema | 变化 |
| --- | ---: | ---: | ---: |
| Provider context input | 535,027 | 398,360 | 下降 25.5% |
| fresh input | 6,855 | 7,710 | 不单独作为总输入结论 |
| 缓存读取 token | 1,676,412 | 1,188,851 | 不单独作为成本结论 |
| Provider 总输入（fresh + cache） | 1,683,267 | 1,196,561 | 下降 28.9% |
| 缓存率（cache / 总输入） | 99.59% | 99.36% | 下降 0.24 个百分点 |
| 输出 token | 2,997 | 3,076 | 上升 2.6% |
| 工具参数/轨迹准确率 | 16/20，80% | 15/20，75% | 下降 5 个百分点 |
| Schema 校验错误 | 0 | 0 | 无变化 |

本轮精简全量的 Schema 负载下降约 28.9%，但没有达到“完整 Schema 只剩很少 token”的程度，原因是工具数量、字段名、类型、枚举、必填关系和 action 分支仍然必须发送；本方案主要删除自然语言元数据。当前 provider 为 Anthropic 口径，`input` 是 fresh input，`cache_read` 单列，因此总输入按 `input + cache_read` 计算，缓存率按 `cache_read / (input + cache_read)` 计算。预热后两组缓存率接近，说明此前冷缓存测试中 26.2 个百分点的差距主要由测试顺序和缓存前缀切换造成，不能作为方案固有特征。

失败轨迹已保留在 `/tmp/phase6-full-vs-compact-warm-20260829.json`。当前全量未命中目标的 case 为 `create_document`、`create_folder`、`move_items`、`note_create`、`list_folders`；精简全量未命中目标的 case 为 `update_todo`、`create_document`、`create_folder`、`note_create`、`list_folders`。两组 `schema_errors` 均为 0，因此这些属于模型工具路由或调用轨迹问题，不应误报成字段 Schema 校验失败。当前结果支持保留精简方案作为实验开关，但不支持直接替换当前默认模式；真实业务灰度和默认模式决策仍未完成。
