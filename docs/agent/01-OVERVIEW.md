# Agent 系统概览

> 本文描述 Gugu Agent 当前实际运行方式。目标架构、实验方案和历史实现不属于本文；相关内容分别放在专题文档和 `../agent/_archive/` 中。

## 1. 系统定位

Gugu Agent 是咕咕的统一对话执行层。它接收网页、QQ、微信、飞书和定时任务产生的请求，读取当前用户和会话上下文，根据模型能力决定是否调用工具或 Skill，最后将结果以网页消息、IM 消息或定时任务通知的形式返回。

Agent 不直接等同于网页聊天页面，也不等同于某个模型供应商。网页和各个 IM 渠道是输入输出适配层，模型供应商是执行适配层，Agent 核心负责上下文、工具调用、任务循环和结果持久化。

## 2. 当前技术边界

| 层 | 当前实现 | 主要职责 |
|---|---|---|
| Web 前端 | Vue 3、TypeScript、Vite | 项目、文件、日历、画布、对话和管理页面 |
| 业务后端 | Python、FastAPI、SQLAlchemy、PostgreSQL、Redis | 用户数据、业务 API、Agent 编排、持久化和后台任务 |
| Agent 核心 | `backend/agent/` | 请求路由、上下文、模型调用、工具、Skill、记忆、RAG 和交互 |
| 模型适配 | `backend/agent/providers/` | Anthropic、OpenAI-compatible、Ollama 等供应商协议适配 |
| RAG 检索服务 | Python 业务层 + 常驻 TypeScript lexical worker | 文档投影、索引缓存、BM25 召回、评分过滤和诊断 |
| 可观测性 | `backend/agent/runtime/loopscope_trace/` + LoopScope 前端 | Run、Round、Span、输入输出和性能诊断 |
| IM 进程 | Worker、Supervisor 和渠道适配器 | 接收外部消息、执行 Agent、推送回复和处理平台差异 |
| Shell 沙盒 | `sandboxd` + Docker 执行器 | 在权限、配额和容器边界内执行 Shell 命令 |

TS worker 和 LoopScope 是配合 Python 业务后端运行的专项服务；当前不能把它们描述为完整 TypeScript 后端。

## 3. 核心能力

### 对话执行

- 多渠道请求统一进入 Agent run。
- 一个 run 可以包含多个 LLM round，以及工具调用、工具结果和最终回复。
- 工具调用失败、模型瞬时错误、用户取消和交互等待都有结构化状态。
- 需要确认的操作通过统一交互协议暂停，确认后继续原任务。

### 上下文管理

- `Snapshot` 保存一轮会话使用的稳定上下文，例如系统提示词、能力目录和会话级状态。
- `History` 保存已经持久化的对话、工具和交互事实。
- 当前轮的动态内容在统一组装阶段生成，不能由各渠道自行拼接另一套上下文。
- 上下文接近模型预算时，对历史部分执行压缩；系统提示词、快照和当前用户消息不应被压缩任务误吞。
- 上下文缓存依赖稳定的消息顺序和前缀，动态尾部、工具续轮和重复 reminder 不能破坏 canonical history。

### 工具与 Skill

- 工具由注册表提供名称、短描述和 Schema；模型先看到目录信息，必要时再获取具体 Schema。
- Skill 描述处理方法和使用约束，不新增工具权限；加载后的 Skill 正文在当前会话生命周期内复用。
- 实际权限由代码中的注册过滤、用户设置、会话状态和 dispatch 校验决定，不能依赖提示词自行扩大权限。
- 工具结果以统一 canonical 结构进入历史，再由 Web、QQ、微信和飞书适配成各自的展示形式。

### RAG 与记忆

- Memory 用于用户相关的长期信息；Knowledge 用于项目、系统、规则、流程和资料结论。
- RAG 按来源和 scope 进行权限过滤，再使用 TypeScript lexical worker 执行词法召回和评分。
- 索引、文档投影和 worker 具有 TTL 与增量更新策略；无命中或低于阈值时不注入上下文。
- RAG 注入属于当前 run 的上下文事实，是否写入长期 Memory 或 Knowledge 由各自反思流程决定。

### 业务操作与执行工具

Agent 可以通过工具访问项目、日历、文件库、画布、通知、定时任务、联网能力和 Shell。工具本身只声明业务契约；用户归属、危险操作确认、沙盒范围和配额由后端执行层再次校验。

## 4. 一次请求的高层流程

```text
渠道输入
  -> gateway / router
  -> 找到或创建 ConversationSession
  -> 读取会话 Snapshot、History、Memory 和可用能力
  -> 执行 RAG 召回与过滤
  -> 统一组装本轮 provider-neutral context
  -> 调用模型
  -> 无工具调用：持久化最终回复并结束 run
  -> 有工具调用：校验参数和权限，执行工具，记录结果，进入下一 round
  -> 需要用户操作：持久化交互状态并暂停，收到选择后恢复 run
  -> 渠道适配并发送结果
  -> 写入 LoopScope trace、用量和审计信息
```

Web、IM 和定时任务可以有不同的传输和展示方式，但不应重新实现上下文组装、工具校验、交互状态或 run 生命周期。

## 5. 数据和权限边界

- 业务数据以用户归属为基本隔离边界，跨用户查询必须经过 ownership 校验。
- 会话、消息、工具调用、工具结果和交互状态分别持久化，不能用一段展示文本替代结构化事实。
- 用户输入、附件名、工具参数和模型输出不得写入普通可见日志；诊断信息需经过脱敏或受限记录。
- Shell 的危险命令分类只用于确认和用户提示；真正的文件系统、网络、身份和资源隔离由沙盒执行器负责。
- 系统配置、用户设置和运行时权限是代码事实，不由模型提示词决定。

## 6. 文档使用边界

本文只回答“Agent 是什么以及如何连接各层”。继续阅读时：

- 上下文和缓存：`04-CONTEXT-AND-CACHE.md`
- 工具与 Skill：`05-TOOLS-AND-SKILLS.md`
- RAG 与 Knowledge：`06-RAG-AND-KNOWLEDGE.md`
- 多渠道：`08-CHANNELS.md`
- 可靠性：`10-RELIABILITY.md`

上述专题文档尚未全部重写前，以当前代码、测试和部署文档为准。
