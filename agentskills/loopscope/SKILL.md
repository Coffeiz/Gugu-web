# LoopScope 开发观测约定

LoopScope 是 Gugu 的开发、回归和运行排障工具，不是普通业务日志，也不是生产审计系统。它的首要目标是让开发者看到 Agent 实际收到的上下文、工具参数、工具结果、模型输出和每轮缓存边界。

## 数据记录策略

- LoopScope trace 允许保留完整的开发正文，包括用户输入、模型输出、Prompt、Memory、RAG、文件名、工具参数、工具结果和工具 Schema。
- 不要为了复用普通日志规范而对 trace 正文做 fingerprint、截断或隐藏，否则会破坏 Input/Output/Context/Tool 面板的排障能力。
- 仍然记录结构化 metadata：长度、token、digest、cache anchor、Prefix Diff、Provider usage 和代码位置，用于比较与统计。
- trace 属于受控开发数据，只能写入 LoopScope Collector/SQLite，不得复制到普通日志、SystemLog、用户可见错误或业务审计记录。
- 导出、截图和分享前必须确认目标位置受控；不要把 trace 当作匿名或脱敏数据。

## 凭据边界

- Gugu 登录 Token、Cookie、Provider API Key、工具认证信息和数据库密码绝不能进入 trace payload、LoopScope SQLite、日志或 URL。
- LoopScope 前端通过 Gugu `/dev` 的 `postMessage` bootstrap 获取登录 Token，Token 只保存在当前浏览器 `sessionStorage`，请求 Gugu API 时放在 `Authorization: Bearer` 请求头中。
- Gugu bridge 上报 trace 到 Collector 不需要把 Gugu 登录 Token 写入每条 Run。
- Collector 默认绑定 `127.0.0.1`。如果部署到非本机网络，必须在部署层增加独立认证、来源限制和网络访问控制。

## 实现边界

- `_jsonable()` 是 trace 对象序列化工具，不是正文脱敏器；不要把它描述成 redact/sanitize。
- `digest` 和 fingerprint 只用于结构比较、缓存诊断和关联，不代替可展开的开发正文。
- 普通 Gugu 日志仍必须遵循后端安全规范，使用 `redact()`、`diag_log()` 或 `fingerprint()`；该规则不自动套用到 LoopScope trace。
- 修改 LoopScope trace 字段时，优先保证 Provider 实际输入与 trace 展示一致；不要为了“看起来安全”只记录二次摘要。
- Collector 不可用时不能阻塞 Agent 主链路；上报失败应静默失败或进入独立诊断处理。

## 修改前检查

1. 确认新增字段是否为开发诊断正文、结构 metadata 或凭据。
2. 开发诊断正文可以进入 trace；凭据必须拒绝或清除；普通日志单独走后端日志脱敏规范。
3. 检查 `Input`、`Output`、`Context`、`Tool` 面板是否仍能还原真实排障现场。
4. 增加或更新 trace contract、Collector 存储和前端展示测试。
5. 用 `git diff --check`，并确认没有把真实 Token、API Key、密码或生产用户凭据写进测试 fixture、报告和提交历史。
