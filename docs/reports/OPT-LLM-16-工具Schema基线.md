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

已用 devserver 的真实 provider 配置，对固定 20 个复杂脱敏场景执行 shadow A/B。两组都注入全量工具 Schema；`prd_compact_full` 仅移除 `description`、`title`、`default`、`example/examples` 等结构可表达或非必要元数据，工具执行统一拦截为 no-op，不写入真实数据。

测试口径已更新为**每个策略一个连续会话**：先用 case 1 执行一次 warmup，再在同一份 `PromptMessages` 历史中依次输入 case 1、case 2，直到 case 20。warmup 单独记录，不计入正式准确率和 token 汇总；每个正式 case 保留两轮之间的 assistant 回复、工具调用和工具结果。这样缓存率按真实连续对话测量，而不是把每个 case 当成独立冷启动请求。

执行脚本：[`test_full_schema_compact_ab.py`](../../backend/scripts/diagnostics/test_full_schema_compact_ab.py)。脚本默认使用上述连续会话口径，每个 case 支持独立超时，并记录 `tool_selection`、缺失字段、字段值不匹配和续轮错误。运行需要显式传入 `--allow-real-llm`；原始结果必须保存为脱敏 JSON，不能把真实工具 dispatch 或用户数据带入测试。

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

### Phase 6 新模型连续会话复测（2026-08-29）

使用 `glm-4.5-air` 重新执行连续会话 A/B：每组先预热 1 轮，再连续执行同一批 20 个 case；工具执行统一拦截，测试进程已清理。

| 指标 | 全量 Schema | 精简全量 Schema | 变化 |
| --- | ---: | ---: | ---: |
| 工具准确率 | 20/20（100%） | 20/20（100%） | 无变化 |
| Schema 错误 | 0 | 0 | 无变化 |
| Input token | 1,518,592 | 1,205,121 | 下降 20.64% |
| Context token | 610,190 | 475,453 | 下降 22.08% |
| Output token | 4,855 | 6,352 | 上升 30.82% |
| 缓存读取 token | 1,509,248 | 1,195,008 | 下降 20.82% |
| 缓存率 | 99.38% | 99.16% | 下降 0.22 个百分点 |

本轮两组工具准确率相同，均未发现 Schema 错误；精简全量的主要收益是减少输入和缓存读取量，而不是提高准确率。缓存率差异仅 0.22 个百分点，不能抵消输入量下降带来的收益。原始日志保留在 devserver：`/tmp/schema-ab-model-20260829.log`、`/tmp/schema-compact-seq-glm-20260829.log`。

## 两种生产模式的边界（2026-08-29）

生产环境最终只保留两种模式，默认使用简介模式：

- **简介模式（`description`）**：能力目录只提供工具名称、短描述和路由提示；模型需要调用业务工具时，通过 `get_tool_schema` 按需取得当前工具定义。
- **全量模式（`full`）**：直接向 provider 注入工具源码中的规范 Schema。101 个工具已完成源码规范化，因此不需要再维护独立的 compact Schema 算法。

旧版 `catalog`、`compact_schema`、`full_schema` 只作为存量配置读取兼容值，统一归一化为 `description` 或 `full`，不再作为产品模式或 API 输出值。

## 简介模式补测（2026-08-29）

本轮使用模型 `glm-4.5-air` 和 devserver 真实 provider 配置，按连续会话方式先预热 1 轮，再执行 20 个脱敏 case。测试按生产实现组装 `build_fixed_adapter_context()` 与 `catalog_block()`：目录提供工具名称、短描述和紧凑字段签名，工具 Schema 通过 `get_tool_schema` 按需回注；工具 dispatch 统一 no-op，不访问或写入真实业务数据。

| 指标 | 简介模式 |
| --- | ---: |
| 工具准确率 | 17/20（85%） |
| Schema/字段差异 | 3 |
| 续轮错误 | 0 |
| Provider 总输入（含 fresh + cache） | 867,514 |
| Context input | 341,339 |
| 缓存读取 token | 853,120 |
| 缓存率（cache / Provider 总输入） | 98.34% |
| Output token | 7,727 |

3 个失败 case 均有明确的 schema/语义问题：`save_uploaded_file` 的来源字段语义不够可判定；`update_todo` 仍生成旧参数，缺少当前契约要求的 `action`；`note_create` 的 `blocks` 内容没有稳定生成。它们应纳入 PRD-LLM-16 后续 schema 语义显式化目标，而不是归因于 provider 不稳定。

此前的 45% 结果以及随后 5% 左右的结果均为无效探针数据：前者错误地丢失了 properties 字段名，后者的评估器没有解包模型返回的 `{name, arguments}` 包装。两轮数据不作为生产模式指标，本报告只采用本轮修正后的 v3 结果。

测试脚本：[`test_full_schema_compact_ab.py`](../../backend/scripts/diagnostics/test_full_schema_compact_ab.py)。实际命令为 `--allow-real-llm --mode description --case-timeout 180 --output /tmp/schema-description-catalog-20260829-v3.json`；使用 devserver 真实 provider 配置，工具 dispatch 为 no-op，测试进程已清理。

## 简介模式与全量模式复测（2026-08-29）

本轮使用 devserver 当前 provider 配置，先预热 1 轮，再在同一会话连续执行 20 个脱敏 case；两组均使用相同 case 顺序，工具 dispatch 为 no-op，不写入真实数据。Schema token 为运行时序列化文本的本地 token 估算，provider usage 仍以真实返回为准。当前模型走 OpenAI 兼容协议，`input` 已包含缓存命中量，因此缓存率按 `cache_read / provider_input_total` 计算；总 token 为 provider 输入加输出。

| 指标 | 简介模式 | 全量模式 | 全量相对简介 |
| --- | ---: | ---: | ---: |
| 工具调用准确率 | 20/20（100%） | 20/20（100%） | 无变化 |
| Schema 工具数 | 4（固定 Adapter） | 100 | 全量模式多 96 个 |
| Schema 字符数 | 1,438 | 49,244 | +3,325.00% |
| Schema token（每次请求估算） | 约 440 | 13,918 | 约 31.6 倍 |
| Schema token（含预热 21 次） | 约 9,240 | 292,278 | 约 31.6 倍 |
| 简介目录 token（每次请求估算） | 6,512 | 0 | 仅简介模式 |
| Provider 输入 token（20 个 case） | 1,008,647 | 1,291,074 | +28.00% |
| 输出 token | 6,720 | 6,427 | -4.36% |
| 总 token（输入 + 输出） | 1,015,367 | 1,297,501 | +27.79% |
| 缓存读取 token | 992,512 | 1,280,256 | +29.00% |
| 缓存率 | 98.40% | 99.16% | +0.76 个百分点 |
| Schema 错误 | 0 | 0 | 无变化 |

结论：本轮两种生产模式的工具调用准确率相同且没有 Schema 错误；全量模式的 Schema 负载明显更高，简介模式主要发送 14,849 字符能力目录和 4 个固定 Adapter Schema，但整体输入和总 token 仍更低。缓存率不能单独代表成本，需与总输入 token 一起看。旧原始结果中的简介 Schema 字符/token 是统计脚本误将 100 个工具声明计入的诊断值，已按实际固定 Adapter 修正口径；provider usage 和准确率不受影响。脱敏原始结果：`/tmp/schema-modes-ab-20260829.json`。

## Phase 8 首批源码规范化（2026-08-29）

已将 `create_project`、`create_event`、`update_event`、`save_uploaded_file`、`note_create` 的
`input_schema` 迁移为源码即线上精简 Schema：删除可由结构表达的字段说明，补充日期/时间
`pattern`，保留全天、附件来源、待办动作和块结构等真实约束。运行时精简器同时修正了
`properties` 上下文，字段名为 `title` 或 `description` 时不会被误删。

迁移前审计为 101 个工具、394 个字段级 `description`；截至本轮已删除 394 个冗余字段说明，必要安全语义已移到工具级短描述。
审计入口：[audit_tool_schemas.py](../../backend/scripts/audit_tool_schemas.py)；注册级一致性和
日期/时间结构约束测试位于 [test_tool_schema_phase1.py](../../backend/tests/test_tool_schema_phase1.py)。

第二批覆盖日历查询/提醒及项目查询、日期和阶段/待办结构；保留默认值、清除语义和确认门等
无法仅由类型推断的业务说明，未做机械删除。

第三批覆盖笔记读取/更新/删除/恢复、文件读取和文件夹查询；笔记块、颜色、版本和时间等
字段的结构约束保持不变，仅移除重复性说明。

本轮另外迁移项目详情及历史对话的纯定位字段；读取数量增加了 `minimum/maximum`，默认值
仍由 handler 保持，不再通过字段级自然语言说明重复注入。

后续剩余说明主要集中在搜索别名、文件来源与目标、定时任务默认行为以及确认门等字段；
这些需要先完成语义和兼容性审查，再决定是否转为结构字段，暂不机械删除。

本轮已完成全局搜索和画布搜索的结构化迁移；搜索别名仍由兼容解析逻辑处理，工具级短描述
负责告知模型统一入口，Schema 字段不再重复注入相同说明。

后续文件批次已完成复制、删除和发送文件的来源字段迁移；`oneOf` 与条件约束继续负责
来源互斥和 URL/title 依赖，文件夹跨项目同名定位等安全语义仍保留在字段说明中。

定时任务与工作区批次已完成基础字段迁移；工作区的项目/文件夹绑定已用条件 Schema 表达，
而 cron、渠道和投递模式等无法由类型直接推断的业务语义仍保留。

本轮补充客户 CRUD、画布便签标题、情绪枚举和工作区创建字段迁移。删除类工具的确认字段
继续保留必要的用户确认语义，不纳入机械清理。

本轮补充文档创建工具：`space=project` 时由条件 Schema 要求 `project_id`，未指定空间
继续保持 personal 默认行为；格式、名称和正文字段不再重复注入自然语言说明。

本轮继续迁移项目归档/删除、项目颜色、文件夹重命名/删除、知识删除和回收站永久删除的
结构性字段。确认门、清除语义以及跨项目同名定位说明继续保留，避免把安全行为压缩成
模型无法推断的空字段。

本轮补充项目阶段更新和文件重命名；`done` 默认值与 `format` 后缀语义移到工具级短描述，
字段 Schema 仅保留类型、枚举和边界约束。

本轮继续迁移 `edit_file` 与 `search_memory`。文件编辑的三种 `mode` 已在单文件和批量编辑项中用条件 Schema 表达：`replace_all/append` 要求 `content`，`find_replace` 要求 `find/replace`，并禁止不适用字段；记忆搜索的范围、来源和策略枚举及默认语义集中到 `description_short`，字段 Schema 不再重复注入自然语言说明。该批次后剩余 102 条字段级 `description`，未发现 `title/default/example/examples`。

随后批次继续迁移搜索与读取工具：`group_context_search`、`search_conversations`、`note_search`、`list_files`、`web_search`、`deep_research` 和 `http_get` 的重复字段说明已移到工具级短描述或直接由枚举/边界表达；兼容别名、搜索模式、来源互斥和 URL 数量限制保持不变。审计当前剩余 69 条字段级 `description`，本轮测试 37 项通过。

本轮继续迁移 `save_knowledge`、`remember` 和 `web_download`。知识写入的字段结构由必填项、枚举和数值边界表达，下载工具的空间默认值与目录优先级集中到工具级短描述；确认门、跨空间安全语义未做机械删除。审计当前剩余 53 条字段级 `description`，已累计删除 341 条，测试仍为 37 项通过。

本轮继续迁移 `image_search` 和 `inspect_images`。图片搜索模式、附件来源及结果数量由枚举、结构和边界表达，图片读取的候选来源由嵌套 `anyOf` 表达；工具级说明保留使用顺序。审计当前剩余 45 条字段级 `description`，已累计删除 349 条，测试仍为 37 项通过。

本轮继续迁移 `add_event_reminder`：提醒提前量数组、单个提前分钟数和投递渠道的结构已由类型、枚举及工具级短描述表达，`reminders` 与 `lead_minutes` 的互斥约束保持不变。审计当前剩余 42 条字段级 `description`，已累计删除 352 条。

本轮继续迁移 `move_items`：批量源、统一目标、空间和目标类型的字段说明已移到工具级短描述，目标对象及 `destination` 的结构和枚举保持不变。审计当前剩余 35 条字段级 `description`，已累计删除 359 条。

本轮继续迁移 `archive_project` 与 `use_skill`。归档方向和技能名称的字段级提示已移到工具级短描述，布尔默认值及技能标识语义保持不变。审计当前剩余 33 条字段级 `description`，已累计删除 361 条；剩余说明均归入确认、安全边界或调度语义。

本轮继续迁移 `update_project.priority` 以及定时任务创建/更新的 `channels`。优先级枚举和 `none` 清除语义、渠道数组和默认行为已移到工具级短描述；cron 格式与 QQ 投递模式仍保留字段级说明。审计当前剩余 30 条字段级 `description`，已累计删除 364 条。

本轮继续迁移 shell 的基础执行参数。`command/cwd/timeout/max_output_chars` 的格式与默认值已集中到工具级短描述，网络、scope 和确认凭证等安全语义仍保留字段级说明。审计当前剩余 26 条字段级 `description`，已累计删除 368 条。

本轮继续迁移 `call_tool.arguments` 及定时任务的 `cron/delivery_mode`。动态工具参数的原生 JSON 约束、定时表达式格式和 QQ 投递模式已集中到工具级短描述；删除确认、shell 网络与 scope、跨项目定位等高风险语义继续保留字段级说明。审计当前剩余 21 条字段级 `description`，已累计删除 373 条。

本轮完成确认字段的统一处理：删除类工具的 `confirm/confirm_token` 已全部改为无重复说明的基础类型，确认流程继续由工具级描述、handler 和确认门共同约束。最终审计剩余 5 条字段级说明，分别用于永久删除的 `all`、文件夹跨项目定位以及 shell 的 `network/scope` 安全边界；这 5 条属于必要语义，不再机械删除。测试仍为 37 项通过。

本轮完成 Phase 8 的源码一致性收尾：`rename_folder`、`delete_folder`、`permanent_delete` 和 `shell` 的必要语义已全部移到工具级短描述。当前 101 个注册工具均满足 `input_schema == _compact_schema(input_schema)`，Schema 审计为 `issues=0`，一致性检查 `noncanonical=0`，37 项 Schema 回归测试通过。随后已完成运行时兼容精简器降级、devserver 注册/注入/dispatch 回归和 README 收尾。

运行时收尾已完成：provider 的 `to_openai()` 与 `to_anthropic()` 现在直接深拷贝源码 Schema，不再调用 `_compact_schema`；该函数仅保留为迁移期审计辅助。新增测试验证 provider 序列化不会触发 compactor；当前回归测试为 38 项通过，审计 `issues=0`、`noncanonical=0`。

Phase 8 devserver 回归已完成。同步后的在线版本通过全量 Schema 注册、能力快照、固定 Adapter、目录注入和双 provider 序列化检查：工具数 101、能力快照工具数 101、Adapter 工具数 101、目录长度 14,900 字符、Anthropic/OpenAI Schema 各 101 个，`noncanonical=0`、短描述超长数为 0、审计 `issues=0`。本阶段完成。

Phase 8 checklist 收尾：关键业务语义已改为显式字段、枚举、`oneOf`、条件 Schema 或 action；可选字段已按独立状态、行为影响、默认安全性和低风险便利参数分类复核；日期/时间 pattern、全天 `all_day`、嵌套结构和互斥输入均有结构约束。正例、缺字段、互斥、嵌套和历史兼容覆盖在 `test_tool_schema_phase1.py` 与 `test_tool_schema_validation.py`，最新 38 项通过。此前未勾选项属于文档状态滞后，现已同步完成。

### 三个错误的修复后复测

针对上述三个失败点收紧 `description_short` 后，使用相同的 20 case 连续会话重新测试（v4）：

| 指标 | 修复前 v3 | 修复后 v4 |
| --- | ---: | ---: |
| 工具准确率 | 17/20（85%） | 18/20（90%） |
| Schema/字段差异 | 3 | 0 |
| 工具选择/解析差异 | 0 | 2 |
| Provider 总输入 | 867,514 | 834,956 |
| 缓存率 | 98.34% | 98.20% |
| Output token | 7,727 | 6,832 |

复测中 `save_uploaded_file`、`update_todo`、`note_create` 均通过。剩余两项是 `search_conversations` 与 `list_folders` 的工具名被 provider 返回为带 XML 参数标签的字符串，属于调用结果解析兼容问题，应单独作为 provider wire/parser 任务处理。

### 5 工具连续会话累积测试（2026-08-29）

使用 `test_schema_accumulation_5tools.py`，每种模式先预热 1 轮，再在同一会话连续执行 20 轮；测试用例固定为 3 个简单工具（`list_folders`、`read_file`、`list_events`）和 2 个复杂工具（`create_project`、`note_create`）。简介模式的固定 Adapter 首次只带 4 个基础 Schema，目标工具按需加载；工具 dispatch 被拦截，不写入真实数据。

| 指标 | 简介模式 | 全量模式 |
| --- | ---: | ---: |
| Schema 工具数 | 4 | 100 |
| 单次 Schema 估算 token | 351 | 13,918 |
| 首轮 provider input | 20,529 | 43,336 |
| 末轮 provider input | 50,124 | 78,067 |
| 20 轮 input 总量 | 687,861 | 1,137,687 |
| output 总量 | 5,198 | 4,074 |
| cache rate | 98.46% | 99.28% |
| 工具准确率 | 20/20（100%） | 19/20（95%） |
| Schema 错误 | 0 | 1 |

简介模式的首轮到末轮增长 29,595 input token，主要来自连续历史和首次按需加载的工具 Schema；第 6 轮以后同一批工具重复调用时，Schema 本身没有按轮无限复制，但复杂工具仍可能触发关联工具（如 `list_projects`、`note_search`），因此会出现阶段性增长。全量模式从首轮就携带全部工具 Schema，连续历史叠加后末轮达到 78,067 input token。本轮全量模式第 1 轮将 `list_folders` 误选为 `list_files`，属于工具选择错误，不是参数 Schema 解析错误。该结果也说明连续多轮对话下，简介模式的固定目录成本会持续存在，按需 Schema 和关联工具事件会分阶段增加；不能只用单轮 Schema 大小判断总消耗。

原始脱敏结果：[SCHEMA-ACCUMULATION-5TOOLS-20260829.json](schema-probes/SCHEMA-ACCUMULATION-5TOOLS-20260829.json)；测试脚本：[test_schema_accumulation_5tools.py](../../backend/scripts/diagnostics/test_schema_accumulation_5tools.py)。
