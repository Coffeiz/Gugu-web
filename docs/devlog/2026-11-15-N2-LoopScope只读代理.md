# N2 LoopScope 只读代理

新增 `GET /api/v1/dev/loopscope/{path:path}`，实际消费者是 Vue DevHome bootstrap 后的 LoopScope UI。Python 基线为 `backend/app/api/v1/loopscope.py`。已核实 Python main 直接注册此 router，handler 仅依赖已认证用户，没有额外 developer guard；本次保留该身份边界，不根据 `/dev` 名称推断新权限。

此功能是 Host 专属 HTTP/SSE 协议适配，位于 `apps/web-host/src/modules/loopscope/proxy.ts`，无需在 Core 制造空业务用例。可信 Host 注入 `LOOPSCOPE_ENDPOINT`，保留 Python 默认地址和末尾 `/api` 处理。用户只可请求 health、sessions、reflections、events、指定 session 的 runs 以及 run 的 spans/context/usage 白名单，不可输入任意上游 URL。GET query 保留重复值，不把用户 token/cookie 发给 Collector，不跟随重定向。

响应只透传 content-type、cache-control、last-modified 和 etag；SSE 补充禁止缓存/缓冲语义，下游断连取消上游请求。普通读取设置 10 秒边界；SSE 建连设置 5 秒边界，收到响应后不增加流读取超时。网络异常映射安全的 503，不回显地址或原始异常。可信配置地址禁止内嵌认证及 query/fragment，是凭据安全边界。

## 验证

- devserver 先运行新增行为测试，明确缺少目标模块失败；实现后真实合成 HTTP Collector 的鉴权/白名单/重复 query/不转发 token 与 cookie/响应头/302 不跟随测试转绿。
- `compat/tests/test_loopscope_proxy.py` 通过 httpx 合成 Collector 直接运行 Python handler，相同协议与路径行为 1/1。它不启动真实 Collector，不改 Python 参考实现。
- 生产集成复用个人数据任务的隔离 PG/认证夹具，使用真实 `startServer`、真实认证用户和独立合成 Collector 验证未认证 401、普通读取及真实 HTTP SSE 透传，取消下游后确认上游连接实际关闭。与协议测试合计 2/2，通过且正常退出。
- 本地与 devserver 的 Host 实现、协议测试和生产集成三个文件 SHA-256 一致。测试元数据已由主会话登记，未重复覆盖清单。

## 范围与限制

没有访问用户 Collector、trace SQLite 或真实上下文；没有把 trace 正文抄到普通日志。未涉及 Worker、业务双库适配、付费 Provider 或 Docker。隔离 PG 仅为验证 Host 用户认证接线，不代表 LoopScope 数据模型或桌面 Collector 已迁移。生产入口协议闭环已验收，真实部署仍待验收。未提交、推送或触发 CI。
