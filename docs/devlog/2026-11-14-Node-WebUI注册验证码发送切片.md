# Node WebUI 注册验证码发送切片

## 路径与契约

前端注册页调用 `POST /api/v1/auth/registration-code`。Node Host 已把系统 SMTP 配置构造成认证邮件 sender，并注入验证码路由；路由在 fail-closed 限流、功能开关、邮箱占用检查及 Redis 预留成功后发送邮件。发送失败时清理验证码状态并返回通用 503。实际系统 SMTP 参数只从运行配置读取，测试使用合成配置和替身 transport，不发外部邮件。

本切片新增路由与 SMTP sender 的组合行为测试，验证规范化收件地址、已预留的验证码、邮件主题/正文及 HTTP 成功响应确实贯通同一条路径。原有独立路由测试继续覆盖限流、邮箱枚举保护、验证码预留失败、SMTP 失败清理和安全错误；sender 测试覆盖 TLS 模式、内容转义及投递边界。

## 验证

- devserver Node 定向回归：注册码、Redis store、注册路由、SMTP sender、组合路径与 Host 套件合计 **43/43 通过，0 失败，0 跳过**。
- devserver 定向 TypeScript 检查：新增组合测试及其依赖通过。
- 对应 Python 相邻基线：注册安全、邮件能力、用户 SMTP API 三个 pytest 模块 **20/20 通过**。Python 没有直接覆盖注册验证码 HTTP 投递 handler 的现成 pytest，因此这些用例作为验证码状态/邮件能力相邻基线，不表述为直接路由等价覆盖。
- Vite smoke：页面、site-config、Node readiness 均为 200；向注册验证码路由发合成空对象得到 422，确认 Vite 已代理到受保护的 Node Host 路由。该请求在请求体校验阶段结束，不发送邮件。
- 所有测试均在 devserver 原生运行；未使用 Docker、未触发 CI、未改写运行配置。

## 未验收边界

没有向真实收件地址发送 SMTP 邮件，也没有通过当前 Vite 运行进程完成验证码发送、后续认证注册及 PostgreSQL 写入闭环。后续最小验收条件是使用可控测试收件箱和隔离 Redis/PostgreSQL，执行“发送验证码→验证并注册→检查会话与播种结果”；不可将真实业务库作为测试库。
