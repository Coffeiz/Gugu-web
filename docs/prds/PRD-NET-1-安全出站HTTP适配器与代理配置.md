# PRD-NET-1：安全出站 HTTP 适配器与代理配置

> 状态：Phase 0–2 已实施；Phase 3 评估完成，其他用途待单独决策
> 创建：2026-10-02
> 最近更新：2026-10-02
> 关联模块：`backend/app/core/url_security.py`、`backend/app/core/pinned_http.py`、`backend/app/core/safe_egress.py`、`backend/app/api/v1/safe_egress_admin.py`、`backend/agent/tools/web.py`、`backend/agent/tools/search.py`、`backend/agent/tools/deep_research.py`、`backend/agent/mcp/client.py`、`backend/agent/tools/files/transfer.py`、Admin 运行配置

## 0. 决策摘要

1. 新增统一的安全出站 HTTP 适配器，负责显式代理、DNS 解析、SSRF 策略和连接目标钉扎。
2. Admin 可配置出站代理；代理未配置时维持现有直连行为。配置代理后，受管请求不得在代理失败时静默回退直连。
3. SSRF 防护在所有部署形态中默认开启，Admin 不提供“一键关闭全部 SSRF 校验”的常规开关。
4. 第一阶段只接入模型可控目标的公网内容抓取路径；后续按用途迁移其他外网 HTTP 客户端。模型供应商、平台网关和管理员配置的本地端点不因本 PRD 自动改变路由。
5. 先验证 HTTP 代理是否支持“CONNECT 到已校验 IP，同时保留原域名 TLS SNI/证书身份”。PoC 未通过前不进入全量适配器实现。

## 1. 背景与问题

`http_get` 当前先用运行环境的 `socket.getaddrinfo()` 做公网地址校验，再通过 IP 钉扎传输直连目标。钉扎用于确保 SSRF 校验的 IP 与实际连接目标一致，但传输层设置了 `trust_env=False`，因此不会自动读取 `HTTP_PROXY` / `HTTPS_PROXY`。

2026-10-02 在 devserver 上复现：系统解析器和直连公共 DNS 查询均给 `ja.wikipedia.org` 返回非预期地址，其中 IPv6 结果 `2001::1` 被 Python 判为非公网，触发 SSRF 拦截；经现有 HTTP 代理访问 Cloudflare DoH 得到的结果则指向 Wikimedia。直连 HTTPS DoH 连接被重置，经代理可达。这表明当前问题同时涉及解析路径和出站连接路径。

仅给 Admin 增加代理地址并使用普通 `httpx(proxy=...)` 不够：代理会自行解析目标域名，应用校验的地址可能与代理最终连接的地址不同。关闭 SSRF 校验也不是解决方式，会扩大模型可控 URL 对内网的访问风险。

## 2. 目标与非目标

### 2.1 目标

- 让受管外网请求按 Admin 配置显式使用代理。
- 对模型或用户可控的目标 URL 保留 SSRF 防护，检查 DNS 结果并确保实际连接目标与校验结果一致。
- 代理、DoH 或解析失败时给出可诊断错误，禁止静默直连降级。
- 将代理、解析、URL 安全校验和目标连接从各工具重复实现收口到共享边界。
- 让管理员能检查代理可达性，并区分代理失败、DNS 异常、SSRF 拒绝和上游 HTTP 错误。

### 2.2 非目标

- 不以部署包形态决定安全默认值；一体化镜像也默认启用 SSRF 防护。
- 不将代理配置等同于 SSRF 例外，不允许代理配置关闭私网地址校验。
- 不在第一阶段把所有 HTTP 请求无差别改走代理。
- 不更改入站回调、数据库、Redis、内部 sidecar、localhost 本地模型端点的现有网络策略。
- 不实现任意目的域名白名单。公网网页抓取允许访问任意公网目标，安全边界按解析后的 IP 和连接目标执行。
- 不在本 PRD 中管理代理服务器、修改系统 DNS 或部署网络层代理服务。

## 3. 核心概念和策略边界

### 3.1 安全出站请求

安全出站请求是访问模型/用户可控 URL 的 HTTP 请求，例如网页抓取和外部文件 URL 下载。它必须经过 URL 规范化、目标解析、IP 分类和连接钉扎。

### 3.2 管理员配置的固定端点

Provider、MCP server 等端点由管理员或用户配置，可能合法地指向 localhost、局域网或私有部署。它们不应直接套用“公网网页 URL”策略，而应使用独立的 endpoint policy：区分公网服务与明确配置的本地服务，并限制可访问范围。

### 3.3 代理配置

- 代理是出站路由，不是可信目标白名单，也不是关闭 SSRF 的授权。
- 代理地址由 Admin 管理；工具输入不能覆盖代理地址。
- 代理认证信息如存在，单独作为秘密字段保存，前端只显示已配置状态，不回显原文。
- 环境代理变量不作为该功能的隐式配置来源，避免服务进程环境变化造成不可见的路由改变。

## 4. 请求处理契约

### 4.1 端到端流程

```text
工具 URL
  → 规范化和协议校验
  → 通过显式代理访问可信 DoH
  → 解析 CNAME 链及 A/AAAA 结果
  → 校验所有地址均为公网地址
  → 代理 CONNECT 到已校验的 IP:端口
  → 对原始域名执行 TLS SNI、证书校验及 HTTP Host
  → 返回响应
```

### 4.2 URL 与 IP 校验

- 仅允许 `http` / `https`；拒绝格式错误、userinfo、非法端口和无法规范化的主机名。
- 对 IP 字面量执行与域名解析一致的地址分类。
- 复用 `app.core.url_security.is_blocked_ip()` 的公网地址判定，包括 loopback、私网、链路本地、保留地址、IPv4-mapped IPv6 和 CGNAT 等非全球地址。
- DNS 的 CNAME 链和全部 A/AAAA 结果都要检查；只要存在一个非公网地址，本次请求就拒绝，不挑选“看起来安全”的子集继续访问。
- DNS 答案为空、格式非法或 DoH 失败时拒绝请求，不回退到 `getaddrinfo()`。

### 4.3 DNS 与连接绑定

- DoH 请求经配置的显式代理发出，使用 HTTPS 证书验证；第一阶段使用产品维护的 DoH endpoint，后续如有多部署需求再评估可配置 resolver。
- 建立目标连接时，代理隧道目标必须是本次通过校验的数字 IP，而不是原始域名。
- HTTPS 隧道内 TLS SNI 和证书 hostname 必须是原始域名；HTTP `Host` 也必须与原域名一致。
- 如果代理不能连接数字 IP，或传输实现不能保留原始域名的 TLS 身份，PoC 判定失败；不得退化为“域名交给代理解析”。
- 应用不得自动跟随未校验的重定向。当前 `http_get` 不自动跟随重定向的行为在第一阶段保持；后续若增加手动重定向，则每一跳完整重新执行上述流程并限制跳数。

### 4.4 失败语义

- 代理配置错误、代理不可达、DoH 不可达、DNS 结果含非公网地址、目标 TLS 验证失败均返回不同的安全错误类别。
- 代理启用后，任何代理错误都不得触发 direct fallback。
- 可见错误不包含代理认证信息、上游原始错误正文或未经脱敏的内部运行配置。
- 诊断日志只记录错误类别、请求阶段和安全指纹；不记录聊天正文、代理 URL 凭据或完整敏感 URL。

## 5. Admin 配置需求

### 5.1 第一阶段界面

新增“出站网络”设置区，包含：

- **外网代理**：启用开关、代理 URL、可选认证信息；URL 显示时去除凭据。
- **应用范围说明**：第一阶段仅用于模型可控的外网内容工具，不影响 Provider API、平台网关和内部服务。
- **测试代理**：测试代理 CONNECT、经代理访问 DoH、解析一个固定公网域名并建立 TLS；只显示阶段、结果和耗时，不把目标响应正文写入日志。
- **保存与取消**：复用 Admin 现有配置校验、保存和 toast 行为；未保存编辑不得影响正在运行的请求。

### 5.2 配置与运行时

- 未启用代理时，保持当前出站路径及 SSRF 保护行为。
- 启用并保存后，新请求读取新配置；进行中的请求使用启动时捕获的同一配置版本，避免一次请求过程中切换代理或 DNS 策略。
- 配置更新失败或代理 URL 不合法时，旧配置保持不变。
- 若存储复用全局运行配置，必须沿用现有 secret 加密/脱敏约定；不得在 JSON 响应或日志中返回认证信息。

## 6. 统一适配器设计

### 6.1 建议模块

建议新增 `backend/app/core/safe_egress/`，内部拆为：

- `config.py`：代理配置结构和配置版本读取，不暴露秘密值。
- `resolver.py`：通过代理调用 DoH、解析并校验 CNAME/A/AAAA。
- `policy.py`：URL 规范化和目的地址策略；复用现有 IP 安全判定。
- `transport.py`：代理 CONNECT 到钉扎 IP，并保留域名 TLS/Host 语义。
- `client.py`：面向调用方的 `SafeEgressClient` facade，统一超时、响应上限、错误类别和重定向策略。

该目录是设计建议；实施前先按仓库既有模块边界复核，不要求机械采用以上文件拆分。

### 6.2 调用方接口

外部工具不直接构造 `httpx.AsyncClient`，而调用共享 facade，例如：

```python
async with safe_egress.open(url, purpose="agent_web_fetch") as response:
    ...
```

Facade 的公开接口不接收用户提供的 `proxy_url`、transport、resolver 或“跳过 SSRF”标志。代理配置由服务端配置注入，策略由调用用途注入。

### 6.3 共享与隔离

- URL 安全校验、代理连接、DoH 和错误归一可以共享。
- 每个调用方仍声明用途和响应限制，不能让供应商 SDK、IM gateway、MCP endpoint、本地服务自动获得相同目的地址授权。
- `PinnedHTTPTransport` 当前直连且 `trust_env=False`；不直接复用为代理传输，先验证代理 CONNECT 与 TLS 语义。

## 7. 分阶段实施

### Phase 0：传输层 PoC

验证现有代理能否：

1. 与外部 DoH 服务建立经验证的 HTTPS 连接。
2. 对已校验 IP 建立 `CONNECT <ip>:443`。
3. 隧道内使用原始域名 SNI 并通过证书 hostname 校验。
4. 发出原域名 `Host` 的 HTTP 请求并取得预期站点响应。

PoC 必须同时验证连接确实钉扎目标 IP。代理不支持时停止并比较受控 egress proxy/本地 egress gateway 方案；不绕过 IP 钉扎直接上线。

**Phase 0 实测结果（2026-10-02）**：在 devserver 使用现有 HTTP 代理运行 curl `--connect-to` 探针，将 `ja.wikipedia.org:443` 的网络连接目标映射到 DoH 返回的 Wikimedia 公网 IP，同时保持请求 URL 为 `https://ja.wikipedia.org/wiki/Muque`。代理收到 `CONNECT <已校验 IP>:443` 并返回 200；TLS 证书为 `*.wikipedia.org` 且验证成功；原域名请求得到 HTTP 200。替换另一个 DoH 返回的 Wikimedia IP 也成功。由此确认现有代理支持 IP 目标 CONNECT，且可保留原域名 TLS 身份和 HTTP 路由，Phase 0 通过。

该探针验证的是代理和 curl 的传输语义，不等于 Python/httpcore 适配器已经实现；Phase 1 仍需以行为测试证明同一契约，并确认没有直连 fallback。

### Phase 1：适配器与网页抓取

- 实现 Admin 代理配置、显式运行时注入和统一 `SafeEgressClient`。
- 迁移 `http_get` 的外部 URL 路径。
- 保持已有响应大小、timeout、重试和不自动跟随重定向的行为，除非单项变更另有批准。
- 在 devserver 以被污染的系统 DNS 环境和经代理 DoH 结果进行回归。

**Phase 1 实施结果（2026-10-02）**：完成 Admin 专用代理配置接口和设置卡片；代理认证在统一配置写入层加密，读取只返回配置状态；配置 URL 不接受内嵌认证。`SafeEgressClient` 在代理启用时使用经代理 DoH、检查 A/AAAA/CNAME 答案，并通过 CONNECT 到校验 IP、原始域名 TLS SNI/证书及 HTTP Host 完成请求；失败不直连回退。代理传输仅在启用代理时协商 HTTP/2（新增 `h2` 依赖），未启用代理继续使用原 IP 钉扎传输。`http_get` 已迁移。

行为验证：7 项初始契约测试加密/脱敏、混合 DNS 拒绝、系统 DNS 不回退、IPv4/IPv6 CONNECT authority 与原域名 TLS 身份；与 `http_get` 既有重试用例合计 17 项通过。前端 `typecheck`、i18n 扫描和 license policy 检查通过。当前代理下真实请求 `https://ja.wikipedia.org/wiki/Muque` 得到 HTTP/2 200；对照测试发现 HTTP/1.1 GET 会得到上游 403，因此仅代理路径启用 HTTP/2，避免改变直连请求协议。

### Phase 2：外网内容工具扩展

盘点并逐项迁移模型可控的任意外部 URL 请求，包括 `http_get`、文件库 `web_download`、`send_file(url=...)` 和图片 URL 读取。下载器继续流式读取并限制大小；重定向逐跳重新通过共享适配器解析、校验和钉扎，不能自动跟随或跳过安全策略。

**Phase 2 实施结果（2026-10-02）**：两个下载入口已改为调用 `SafeEgressClient`；图片下载器仍手动最多跟随 3 次重定向，每跳重新解析和验证，继续保留 Content-Length 提前拒绝、流式累计上限和附件生命周期约束。移除了下载器重复实现的 IP pin 请求构造函数，统一由共享适配器维护连接与 TLS 身份。

本阶段未迁移配置型 SearXNG endpoint 或 Tavily/You/Baidu 固定 Provider API：前者可能是本地服务，后者携带各自供应商凭据；后续须使用固定 endpoint allowlist 与独立代理授权，不套用任意 URL 策略。该边界转入 Phase 3。

行为验证：安全出站、`http_get` 重试/截断、下载分块限额、Content-Length 预拒绝、重定向逐跳重验及旧 URL 安全契约相关测试共 36 项通过。

### Phase 3：其他出站客户端评估

按请求类型评估供应商 SDK、MCP、平台 gateway 和媒体服务。Admin 可按用途开启代理范围；任何迁移必须验证鉴权、流式响应、连接池和超时行为。内部服务和入站连接不在此阶段默认迁移。

**Phase 3 评估结果（2026-10-02）**：本阶段完成边界审查，没有把这些调用纳入“公网内容抓取”开关。

| 请求类别 | 当前边界 | 评估与后续建议 |
|---|---|---|
| 模型 Provider SDK | OpenAI/Anthropic SDK 由 provider factory 构造；Base URL 可能是官方云端、自定义 BYOK，也可能是 Ollama/本地兼容服务。Anthropic SDK 目前使用不同的 HTTP runtime。 | 不应全局代理或套任意 URL 的公网校验。后续应新增独立的 `provider_api` 用途配置，按 Provider/明确 endpoint 授权；OpenAI 与 Anthropic 分别验证 SDK transport 注入、流式、超时和重试。 |
| MCP HTTP | endpoint 是用户配置，当前每次请求先校验并钉扎公网 IP、拒绝自动重定向；stdio MCP 走本地 sandbox socket。 | HTTP 代理可作为独立的 MCP server 传输选项，但要保留 endpoint 级授权、凭据头/query 注入及响应流协议。不能让本地 stdio 或内部 endpoint 继承公网代理策略。 |
| 平台 gateway / IM | QQ、飞书等有固定 API、长连接/回调、签名和重试契约。 | 不进入通用工具出站代理。若有部署网络需求，另做 gateway 专属代理和连接器配置，不能改变回调入站或长连接生命周期。 |
| 媒体与语音 API | 有固定厂商 endpoint 和凭据；图片 URL 下载已统一归入 Phase 2 任意 URL 路径。 | 固定媒体/语音 API 随对应 Provider API 用途评估；图片 URL 读取沿用 `agent_web_fetch`。 |
| 搜索服务 | SearXNG endpoint 由管理员配置，允许本地部署；深度研究/相似图搜索调用固定第三方 API 并携带各自 Key。 | SearXNG 保持现有直连语义；第三方 API 归到独立 Provider endpoint policy，不接受任意目标，也不使用 `http_get` 的普通网页 SSRF 授权。 |

本阶段没有剩余实现提交。后续若需要代理 Provider API/MCP，由独立需求明确用途开关、受信目的地址来源和本地 endpoint 行为，再分别实现；不扩大当前默认范围。

## 8. 测试与验收

### 8.1 PoC 验收

- 代理返回的 `CONNECT` 目的地址是通过校验的数字 IP。
- TLS SNI、证书校验和 `Host` 使用 URL 原始域名。
- 对同一域名，实际连接地址与本次验证的 IP 一致。
- 代理不支持相应能力时功能明确失败，不自动改为域名 CONNECT 或直连。

### 8.2 行为验收

- 经代理抓取 Wikipedia 等公网网页成功，响应内容和 Content-Type 正确。
- 现有系统 DNS 返回非预期地址时，开启代理后请求使用 DoH 的解析和钉扎结果，不调用系统 resolver fallback。
- `127.0.0.1`、RFC1918、链路本地、云元数据地址、CGNAT、保留 IPv6 和 `2001::1` 均在连接前拒绝。
- 混合公网/非公网 DNS、多条 A/AAAA、IPv4-mapped IPv6、CNAME 指向私网均拒绝。
- 代理故障、DoH 故障或 DNS 无记录时 fail closed；确认没有直连请求。
- 重定向默认不自动跟随；如后续支持跳转，公开重定向到私网时必须在第二跳前拒绝。
- Admin 保存、取消、秘密脱敏、代理连通性测试、旧配置保留和配置热切换语义正确。
- 未启用代理时，其他未迁移功能与现有行为一致。

### 8.3 日志和可见错误验收

- 错误区分 `proxy_unavailable`、`resolver_unavailable`、`non_public_destination`、`tls_verification_failed`、`upstream_http_error`。
- 用户错误不声称“网站本身是内网”当真实原因是 DNS 回答含保留地址；建议表述为“域名解析包含非公网地址，已为安全起见拒绝请求”。
- 可见日志无代理 URL 凭据、用户正文、完整外部响应正文；诊断使用既有 logsafe/diag_log 脱敏模式。

## 9. 安全风险与缓解

| 风险 | 缓解 |
|---|---|
| 代理按域名重新解析，绕过已检查地址 | CONNECT 目标使用钉扎 IP；保留原域名 TLS 身份；PoC 必须证明实际连接地址 |
| 攻击者通过模型输入请求内网 | 始终对全部 DNS 结果做公网校验；不提供工具级 SSRF bypass |
| DNS 返回混合公网和私网记录 | 整体拒绝，不只挑第一个公网 IP |
| 代理故障后代码退回直连 | 显式 proxy 模式 fail closed，测试断言无 direct fallback |
| Admin 代理凭据泄漏 | 加密保存、写接口 secret-preserve 语义、读接口只返回是否已配置 |
| 代理把内部 Provider/平台请求路由改变 | 按用途配置和迁移；默认不影响 gateway、内部服务和本地 endpoint |
| DoH provider 不可用 | 错误显式失败；可在后续版本增加第二可信 resolver，但切换仍需经代理且执行同一校验 |
| SSRF 报错误导用户 | 区分 DNS 非公网、代理失败和目标拒绝，不将网络异常伪装成网站属性 |

## 10. 数据、安全和兼容性

- 优先复用现有 Admin 运行配置存储；实施前确认其 secret 加密、读写和多进程刷新契约。如现有存储不满足要求，先补充数据与迁移方案再实现。
- 新配置是可选项；未配置代理时不改变其他调用路径。
- Admin 配置读取不能回显代理凭据；保存空凭据保持旧凭据的行为遵守现有运行配置契约。
- 不修改用户 `backend/.env`、`backend/config.override.json` 或 devserver 同名配置，除非后续用户明确授权具体字段和目标环境。
- 不新增“按镜像类型默认关闭 SSRF”的构建逻辑。

## 11. 未决项与推荐决策

| 问题 | 推荐决策 |
|---|---|
| 全局关闭 SSRF 校验是否提供 | 不提供常规全局开关；公网抓取始终校验。管理员配置的私有 endpoint 走独立授权策略 |
| 自部署代理默认值 | 默认不配置；Admin 明确保存后才启用，失败不直连降级 |
| DoH resolver 是否可在 Admin 自选 | Phase 1 使用受控默认值，先降低配置复杂度；多部署验证后再增加 resolver 选择 |
| 首批接入范围 | 先 `http_get`；Phase 2 再迁移其他模型可控公网内容工具 |
| 代理白名单如何确定 | 连通性测试只验证有限样例；完整白名单/路由规则由代理服务配置决定，不在应用内猜测或扫描 |
| Phase 0 PoC 失败如何处理 | 停止安全代理实现并评估代理能力或受控 egress gateway，不降级为直接交给代理解析域名 |

## 12. 实施完成定义

- Phase 0 的连接钉扎与 TLS 原域名身份验证通过。
- Phase 1 的代理配置和 `http_get` 行为按第 8 节验收。
- 无 SSRF 绕过、无失败直连降级、无敏感凭据/正文日志泄漏。
- 其他工具仍在各自范围内运行；未迁移工具的网络策略被清楚记录，不宣称“所有工具已统一”。
- 只有完成并验证的阶段才标记完成；PoC 未通过时 PRD 保持待实施并记录原因。
