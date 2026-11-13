# N3 Provider 协议迁移与 Harness 整合复查

本轮在已完成的 Harness 分支上迁移 Provider，保持 `harness/` 的固定 18 文件树。协议、native wire/thinking/signature、历史投影归 `providers/`；Run、历史修订、工具派发、交互恢复和终态仍由现有 Harness/Tools/Executor 负责。共享契约、注册、错误和接线由主 Agent 统一修改，三组协议实现完成后由主 Agent 阅读生产源及测试并自行整合验收。

## 真实实现与边界

Chat Completions、Responses、Anthropic 和原生 Ollama 都通过实际 HTTP 请求/响应状态机运行；`connectProviderHarness` 接入实际 Canonical 及工具轮。厂商策略保留模型/协议差异，独立文本和 JSON 分支复用真实驱动。搜索、MiniMax 上传和 ASR 执行受控 HTTP/multipart，文件授权、FFmpeg 探测/转码和外部数据适配仍需独立责任方接入。

Node transport 单独导出，校验并固定 DNS、保留 Host/TLS SNI、拒绝重定向，分别限制连接、写、读空闲和池等待。真实本地 TCP/TLS/代理用例使用合成域名及每次在内存生成的证书，不调用付费 API。HTTP(S) CONNECT 目标是已校验 IP；代理认证不送给目标。SOCKS、自定义 CA 环境文件读取及 Host 网络配置热更新未完成，调用方须显式注入可信代理/CA 和客户端池网络身份。

Provider 私有续接有 TTL、数量/字节上限及 owner/session/run/model/scope 绑定；成功收尾清理，等待交互保留，失效时明确失败。进程内状态不能代替加密跨进程 ReasoningStore。默认 prefix coordinator 只做同进程排序，不共享答案；Redis 租约/续租、失败继续和 LoopScope 白名单尚待 runtime/Host。可信 `resolve` 是配置入口，不证明 BYOK 查询、解密和目的地绑定已经迁移。

## 本轮复查修复

- Responses 流错误在尚无输出时错误标记 `outputStarted`，阻止了 Harness 的合法超限恢复；现按真实输出事实分类。
- 非法 JSON/非对象参数保留错误标记并反馈模型，禁止派发空对象。标记同时保存到 Canonical 待执行轮检查点，防止恢复后误执行。
- 首轮图片消费由 Provider 报告实际 entry/revision，Harness 校验并修订；不允许 Provider 修改 ledger，也不吞后续工具新增图片。
- Anthropic 缺块只有尚无任何输出时才同参非流恢复一次；私有/工具片段之后不重放。旧 SDK 的某些非空缺块 delta 曾恢复，属于明确安全收紧。
- Ollama 仅收到 thinking/工具片段后断连仍记录输出事实，禁止共享重试误重放。取消错误使用固定安全文案，原始 signal reason 不外泄。
- 探针/usage sink 与诊断同时失败不能打断正常请求；探针接到主聊天、分支和独立请求的实际 body/raw usage。指纹只涵盖锚点前缀，动态任务不改变稳定指纹；预算、历史、工具变化会改变协调键。
- HTTP 错误读取 `response.status_code` 并限制合法错误状态范围；未知响应编码拒绝时释放实际连接配额，防止后续请求卡在池中。

## 验证

Python 从当前提交的跟踪源码建立隔离副本，排除用户 `.env`/override，临时配置路径默认不存在，串行执行 43 个相关文件；未改 Python 基线、未连接生产模型或用户服务。初轮为 516 通过、1 个缺 ffprobe 的跳过，补齐本地原生依赖后重新执行：**517 通过、0 失败/错误/跳过，13.75 秒**。原生环境依照用户此前本地授权，不代表 devserver 验收；现有弃用提示未修改。

Core 的正式分层入口、Provider 专项、严格测试类型检查和构建均由主 Agent 执行；最终计数及逐定义限制见 [Provider 映射](../testing/node-agent-provider-parity.md)。测试中的 HTTP/数据库/Tools 替身只用于观察实际 Core 行为，不构成 Host、数据库、Redis、授权媒体和生产切换验收。旧 Harness 的 737 定义清单没有因新增 Provider 文件而批量提升状态。

本轮按用户后续授权统一提交、推送并更新评审 PR。未触发 GitHub CI、合并、部署或改写用户运行配置；原有无关桌面资源未纳入提交。
