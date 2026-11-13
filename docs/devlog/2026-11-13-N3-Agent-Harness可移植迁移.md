# N3 Agent Harness 可移植迁移

状态：Core 已实现部分完成本轮复查回归；逐项部分覆盖继续保留，生产适配器及入口切换独立验收。参考分支 `Ningxue/n3`，HEAD 保持 `dbedef7e`。只修改 Harness、共用 Executor 的可移植协调入口、相应回归与文档；工作区原有桌面生成资源保持原状，不提交。

## 迁移边界

入口为 `@gugu/core/harness`。实现严格使用固定树的18个文件：`harness.ts` 薄组合，`contracts.ts`/`ports.ts` 分开领域类型和依赖接口，Run、历史、上下文、流及交互分别归入 `run/`、`history/`、`context/`、`streaming/`、`interactions/`。执行授权桥接归入既有 `executor/executor.ts`，只调用共用 Executor。原 `executor/platform.ts` 的协调器原样抽到 `executor/executor.ts` 并保留 re-export，防止 portable Harness 隐式装载原生 SDK。

`createCanonicalHarness` 的标准 `runPreparation` 选项直接接入 `context/prepare.ts`：owned 来源后并发工具发现与一次 RAG，之后按可信入口/授权主体做能力过滤、Shell system 说明、工具/Skill 目录分区与前缀格式化，最后交 Canonical。共享 `buildRunRagContext` 维持同一有效历史和当前消息排他水位，主 prepare 复用已召回结果。选中的公开工具名称/schema 随 context 冻结给 Provider，未开放调用在派发前失败；能力查询也接收取消信号并在结束前清理。自定义完整 load 必须交付同等准备结果和能力快照，缺失即失败。重启后的冻结前缀仍由真实 `prepareRequest` adapter 按 Run 身份恢复，不能由当前配置代替。

Provider wire、具体工具、SQL/Redis、Web/IM transport、桌面 Host 和持久 Job 不在本切片实现。它们必须通过明确端口提供真实能力，不使用 Python 隐式回退，也不把测试 fake 作为生产适配器。

## 已定位并保护的契约

- 正常 final、错误与取消使用不同持久规则；已完成工具不因下一轮 Provider 报错变成成功历史。取消可以保留允许的完成轮次/部分正文，最终取消响应不补发正文。
- Run checkpoint、owner/session 互斥租约、fencing、CAS、交互回执与 outbox 有显式原子契约。提交结果未知后停止，不自动重放 Provider 或有副作用工具；恢复只凭确定收据 reconcile。
- Canonical 消息与 Provider 投影分离，稳定序号、revision、批次身份和水位必须保留。未派发调用不因 Provider 声明过就落历史；交互等待只保留实际调用子集，回答替换同一结果。
- 凭据交互内容不进入 Canonical、checkpoint 或 outbox；交互服务消费秘密后给 Harness 安全状态与稳定回执。HTTP 工具 header 在持久副本中脱敏，真实工具参数不随历史清洗改变。
- 实际当前请求输入量达到窗口 85% 才自动压缩；压力窗口与普通十轮历史保留分开。无进展后须增长 8000 输入 token 才重试，不以本地估算触发截断。
- Canonical context 使用稳定附件引用持久化；媒体、私有推理和授权材料由独立适配器持有。主请求反思快照保存实际冻结的系统规则、工具 schema 和不透明原生前缀，通知仅传身份/指纹；缺少普通反思原快照时延后。
- 成功收尾前仅保存待提交压缩计划，失败/中断不提前推进会话摘要水位。成功主 Run 提交后才捕获反思快照并唤醒独立 Job；Job 的可靠登记由同事务 outbox 负责。

## 独立适配与明确差异

Core 的并行交互路径先持久化全部兄弟工具收据、按模型顺序保存 Canonical/`tool_done`，再幂等活化首个交互门；其余门保留在可恢复队列。与 Python 部分内存流路径相比，首个 `tool_done(waiting)` 可能先于 `interaction_required`。这是为避免交互已可作答而兄弟结果尚未持久化的退出窗口；Host 仍需按稳定事件身份更新，不能把两者当成两份展示来源。本切片没有修改现有 HTTP/SSE 或平台适配器。

准备早退仍使用同一 Harness：附件/额度/语音检查的非 errored 响应不执行模型、不写正常 Canonical、不反思；Provider 错误早退保留 failed 语义。Core 新增的 `run_started` 是持久元数据，早退的渠道投影只交付 final。准备业务判断不因编排已实现而被称为已迁移。

`CanonicalContextPort` 的历史参数副本会隐藏 HTTP headers，但 RunStore 为确认/恢复保存的真实工具意图仍可能含敏感请求参数。生产 Data/Tools 适配器必须采用受限加密存储或安全意图引用；当前内存 fake 不构成该边界验收。凭据交互正文只交安全存储、Harness 仅留回执是另一条已实现规则，不能替代工具意图的机密存储。

标准 Core 来源 loader 将 session snapshot 作为首次 prepared checkpoint 提交的 epoch/CAS 候选（前一 checkpoint 的 context 为空）。它不能提前单独提交，之后每个 token 也不能重复应用；恢复依赖权威 checkpoint 确认该候选已应用。稳定 Provider cache anchor 与 native reasoning continuation 分开交接，并与成功/静默收尾的 session metadata 同事务保存。

## 验证与限制

用户授权本地原生串行验收，不使用 Docker。最近完整 Core 快速层为 30 文件、506 通过、0 失败、0 跳过，包含全部 23 个 Harness 测试文件；测试源码 TypeScript 检查与 diff 空白检查通过。最新逐项状态以 [行为映射](../testing/node-agent-harness-parity.md) 为准。

专题命令在 `gugu-core/` 使用已准备的 Node 26 调用 `node_modules/vitest/vitest.mjs run tests/agent/harness`；快速层为 `scripts/run-tests.mjs unit`，测试源码类型检查为 `tsc -p tsconfig.tests.json --noEmit`。本地运行时定位只记在 Git 忽略的 local skill，不写入本文。

Python 最初在 Windows collection 阶段因 `app/core/config.py` 依赖 POSIX `fcntl` 失败，未执行用例。用户随后明确允许安装普通 WSL Linux；在 Ubuntu 原生 Python 3.12 独立虚拟环境按原 `requirements.txt`、`requirements-dev.txt` 和 `compat/core-python` 安装依赖，使用当前 Git 跟踪 Python 源码的隔离副本，排除用户 `.env`/override。原生音频依赖构建需要补齐系统 Python 开发头文件，未修改仓库依赖或 Python 基准。

按映射中的全部 76 文件先执行 `pytest --collect-only -q -p no:cacheprovider`，收集 918 项；随后同范围串行执行 `pytest -q --tb=short -p no:cacheprovider --junitxml=<临时结果路径>`，**918 通过、0 失败、0 跳过，38.32 秒**。4 条既有弃用警告来自 Sudachi 与 Redis `setex`。运行显式设置 `PYTHONPATH=.:../compat/core-python/src`，配置和存储指向专属临时路径，使用既有 fake Redis/内存 SQLite；机器可读 JUnit 计数一致，结束后基准副本仍没有用户运行配置。没有使用 Docker 或真实服务。

全仓元数据检查发现既有 WebUI 测试未登记，以及原有未跟踪桌面资源中的第三方测试被扫描，未修改无关文件掩盖这些问题。本专题新增测试均登记在 Core suites 与元数据中；逐项映射不以套件总数冒充全量等价。

最后一轮回归已覆盖混合交互/并行工具、续轮 EOF、取消与完成竞态，以及真实 Canonical 的工具完成→后续部分正文取消→中断增量物化→下一 Run 回放。压缩候选在这条取消路径不推进摘要水位。本轮复查发现准备主链和空答重试确有遗漏，已直接修复；撤回此前“无内部缺口”的结论，部分覆盖继续按具体断言和适配责任保留。真实 Provider、双库/Redis、跨进程恢复与 Job/Host 集成仍需对应责任方验收，整体 N3 不因此完成。本轮不切换生产入口，不提交、推送或触发 CI。

## 固定目录归位补充

先将Python生产调用链和737个定义映射到指定目录，再拆出实际取消API、终态持久化、交互回执消费、Provider迭代器关闭及outbox重放。旧runtime/policy平行层已移除，测试迁入 `gugu-core/tests/agent/harness/{run,history,context,streaming,interactions}/`。全部API仍由index导出，harness仅组合。

本轮Node 26完整Core快速层30文件、506项通过，0失败/跳过；测试源码类型检查通过。原有诊断码断言捕获结构归位时的字符串误改，已恢复原协议并复验；新增执行/确认凭据不得持久化回归。Python未改动，沿用上一轮普通Linux原生918项通过证据。真实共享jobs、Provider协议和Tools实现仍通过端口对接，没有在Harness建立数据库或第二条执行路径。

## 再次复查与修复

复查确认用户 Skill 元数据从未在标准入口首次冻结，定时任务误用交互 RAG/当前输入持久策略，过滤前工具 Schema 可能进入目录，空答重试未给下一轮模型实际追问。均在既定职责文件修复；另修复 SDK 异常 body 循环/BigInt 导致分类失败的问题。稳定附件与工具结果快照回到 history，工具调度计划归 streaming，history 反向依赖协调层由架构测试禁止。

补齐旧 pytest 的连续继续/失败工具回放、媒体与引用、旧历史 RAG 锚点、31轮任务工具、串行三工具、普通交互关闭、确认卡片前 flush、重复阈值与动态尾部组合。原478项基础上新增28项，最终完整Core30文件506项通过，类型检查通过；Python未改，沿用此前918项基准，本轮未复跑。

此前“所有Core必要回归均闭合”的总述过强，现已撤回。737项映射仍为149项已验收、232项部分覆盖和356项端口依赖；接口及fake不得冒充真实Provider、Tools、双库存储、持久Job或Host。生产Agent仍由Python承载。本轮不提交。
