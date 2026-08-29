# PRD-SEC-2：越权检测与快速封禁

> 状态：基础安全闭环与安全运营能力已完成；自动响应默认关闭
> 创建：2026-08-29
> 最近更新：2026-08-29
> 关联模块：`backend/app/core/ownership.py`、`backend/app/api/v1/users_admin.py`、`backend/app/api/v1/audit_log.py`、`backend/app/core/security.py`
> 背景参考：现有 `ownership.denied` 结构化告警、管理员用户封禁接口和安全审计报告 M1

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 越权事件记录与脱敏 | ✅ 已完成 | 安全事件持久化、HMAC 指纹、字段白名单和 90 天保留已接入 |
| 风险计数与策略判定 | ✅ 已完成 | Redis 5 分钟窗口、5 次真实限流、10 次冻结执行和阈值/冻结时长配置已接入；自动冻结默认关闭 |
| Admin 风险管理 | ✅ 已完成 | 风险用户 Tab、人工冻结/解封和单用户事件详情已接入 |
| 账户与长连接失效 | ✅ 已完成 | 普通 API、SSE、终端 WebSocket 已检查账户状态 |
| 清理、观测与灰度 | ✅ 已完成 | 事件清理、写入失败指标、测试和 `logged-only` 回滚边界已完成 |
| 全局安全事件视图与外部告警 | ✅ 已完成 | Admin 全局脱敏筛选和默认关闭的可选邮箱告警已接入 |

## 1. 背景与目标

当前 `get_owned()` 在发现资源属于其他用户时，会记录 `ownership.denied` 并返回 `None`。这能阻断资源枚举，但目前事件主要停留在日志和指标层，缺少：

- 可供管理员检索的持久安全事件记录；
- 针对重复探测的短窗口计数和限流；
- 对已登录用户的快速冻结与现有连接失效；
- Admin 页面中的风险状态、事件详情和封禁操作。

### 1.1 现状盘点结论

- `backend/app/core/ownership.py` 是当前统一的资源归属拒绝入口；不属于请求用户的资源统一返回 `None`，调用方继续按“不存在”处理。
- 当前 `ownership.denied` 只写结构化 WARNING，并通过 `opsmetrics.record_security()` 写入 Redis 日聚合计数；没有 PostgreSQL 安全事件事实表。
- `backend/app/models/__init__.py` 的用户状态目前只有 `is_active`；没有临时冻结截止时间、冻结原因或 Token 安全版本。
- `backend/app/api/v1/users_admin.py` 已有 `PATCH /{user_id}/ban`，但它是 toggle 语义，不能表达时长、原因和自动/人工来源。
- `frontend/src/views/Admin/Users/index.vue` 当前只有普通用户列表，没有风险用户 Tab；`frontend/src/views/Admin/AuditLog/index.vue` 只展示 `audit_logs` 管理员操作记录。
- `backend/app/core/security.py` 的普通 API 鉴权会检查 `is_active`，但 `get_current_user_id()` 等长连接身份解析路径仍是 JWT-only，尚无统一冻结版本检查。

### 1.2 策略冻结决策

- 安全事件事实来源为 PostgreSQL `security_events`；Redis 只保存短窗口计数、限流状态和通知，不作为审计事实来源。
- 资源、IP、客户端和 User-Agent 使用服务端密钥 HMAC-SHA-256 指纹；不保存资源明文 ID、IP 明文、Token、Cookie、正文、文件名或 API Key。
- 事件默认保留 90 天，超过保留期按安全事件清理任务删除；用户业务数据不受影响。
- 5 分钟内同用户 5 次 ownership 拒绝触发敏感接口限流；5 分钟内 10 次触发临时冻结 10 分钟。
- 自动冻结初版默认关闭，以 `logged-only` 灰度；人工 Admin 冻结能力不受该开关影响。
- 单次旧标签页、切换账号或过期缓存导致的 ownership 拒绝只记录，不冻结。
- `account_status`、`suspended_until`、`suspended_reason` 和 `security_version` 由统一账户状态服务维护；业务 API 不直接改字段。

本 PRD 的目标是把越权拒绝从单条告警扩展为可审计、可响应、可恢复的安全闭环，同时控制误报。单次由旧标签页、切换账号或过期缓存造成的越权请求不得直接冻结用户。

不改变现有多租户边界：资源仍必须通过 `get_owned()` 或等价的显式归属过滤；前端展示和安全事件记录都不能替代服务端授权。

### 1.3 当前实现结果

- 已建立 `SecurityEvent` 事实表、HMAC 指纹、白名单元数据和 90 天到期时间；`get_owned()` 拒绝路径已在独立事务中记录事件。
- 已建立 Redis 5 分钟短窗口计数和 5/10 次风险判定；普通 API、SSE、终端 WebSocket 的鉴权入口会在达到 5 次后真实限流，阈值、窗口和冻结时长来自 `security` 配置段，自动冻结可通过灰度开关启用且默认关闭。
- 已建立统一账户状态服务、Admin 风险用户 Tab、人工冻结/解封和安全事件详情接口。
- 普通 API、SSE、终端 WebSocket 已接入账户状态检查；长连接最多每 5 秒发现冻结并失效。
- 已接入安全事件到期清理和 `security_event.write_failed` 指标；清理只删除安全事件，不影响业务数据。
- 安全专项测试已通过，默认运行模式仍为 `logged-only`。

### 1.4 当前实施边界

- 当前已交付记录、计数、真实限流、判定、人工冻结和连接失效基础链路；自动冻结执行范围以 `SEC2-011` 为准。
- 请求来源已统一写入客户端、IP、User-Agent HMAC 指纹；事件字段不会保存来源明文。
- Admin 已提供风险用户详情和安全事件全局脱敏筛选。
- 外部邮箱告警和自动冻结默认关闭；邮箱在管理后台“系统配置 → 安全告警”配置，SMTP 在同页“邮件系统”配置；启用前仍需按统一灰度口径观察指标。

## 2. 功能需求

### FR-SEC-1：记录越权安全事件

每次 ownership 拒绝都创建一条脱敏安全事件，至少包含事件类型、请求用户、资源类型、资源指纹、客户端、IP 指纹、发生时间和处理动作。

- 资源 ID 不保存明文，使用带服务端盐的稳定指纹；
- IP、User-Agent 使用不可逆指纹或合规保留形式；
- 不记录 Token、Cookie、请求正文、会话正文、文件名和 API Key；
- 正常单次拒绝的动作是 `logged`；
- 对调用方继续返回统一的“不存在”，不得泄露资源存在性。

### FR-SEC-2：短窗口聚合与分级响应

系统按用户、客户端和 IP 在 Redis 中维护带过期时间的计数，不把 Redis 作为安全事件事实来源。

默认策略：

| 条件 | 动作 |
|---|---|
| 单次拒绝 | 持久记录，正常返回统一错误 |
| 5 分钟内同用户 5 次 | 对敏感资源接口限流，并记录 `throttled` |
| 5 分钟内同用户 10 次 | 临时冻结 10 分钟，并记录 `suspended` |
| 多用户、多资源指纹持续探测 | 提升风险等级，通知管理员，默认不自动永久封禁 |

阈值必须配置化，初始上线允许只记录不自动冻结，待误报率确认后再开启自动响应。

### FR-SEC-3：用户冻结状态

用户状态从简单的 `is_active` 扩展为可解释的冻结状态：

- `account_status`：`active`、`suspended`、`disabled`；
- `suspended_until`：临时冻结截止时间；
- `suspended_reason`：脱敏原因；
- `security_version`：安全状态版本，用于使既有 Token 立即失效。

冻结期间：

- 普通 API 和 SSE 建立连接必须拒绝；
- WebSocket 握手必须拒绝；
- 已建立的长连接通过安全版本或安全事件通知尽快关闭；
- 解封后不得自动恢复之前已关闭的连接；
- 用户看到统一的“账号暂时不可用”提示，不显示检测细节。

现有 `is_active` 继续作为兼容字段，迁移期间由统一账户状态服务计算，不允许各接口自行解释状态。

### FR-SEC-4：Admin 用户风险管理

在现有 **管理后台 → 用户管理** 内增加独立的“风险用户” Tab，普通用户列表不混入风险聚合字段，避免日常用户管理被安全事件干扰。

“风险用户” Tab 默认展示仍处于风险状态、限流状态或近期触发安全策略的用户，并支持按状态和时间筛选。该 Tab 增加：

- 风险状态；
- 当前冻结截止时间；
- 最近越权次数和最近发生时间；
- 立即冻结；
- 解封；
- 查看该用户安全事件。

普通用户 Tab 保持原有用户查询、用量和存储信息；用户详情中的安全信息仍可通过风险用户 Tab 或安全事件详情入口查看。

冻结必须使用明确动作接口和确认弹窗，不使用 toggle 语义作为唯一入口：

```text
POST /api/v1/admin/users/{user_id}/suspend
{
  "duration_seconds": 1800,
  "reason": "repeated_ownership_denied",
  "confirm": true
}
```

```text
POST /api/v1/admin/users/{user_id}/unsuspend
```

现有 `PATCH /api/v1/admin/users/{user_id}/ban` 在迁移期保留兼容，但内部必须调用统一冻结服务，并记录操作者、原因和结果。

### FR-SEC-5：Admin 安全事件视图

在现有 **管理后台 → 审计日志** 下增加“安全事件”视图，与管理员操作日志分开呈现。风险用户 Tab 的统计和列表只展示聚合结果，详细事件统一跳转到该视图。

支持按以下条件筛选：

- 事件类型；
- 用户；
- IP 或客户端指纹；
- 资源类型；
- 处理动作；
- 时间范围。

用户安全详情以时间线展示事件，并提供聚合信息。管理员只能看到脱敏资源指纹和必要的诊断字段，不能通过 Admin 页面读取其他用户的会话正文或资源内容。

### FR-SEC-6：误报与恢复

- 账号切换、旧标签页、过期 sessionStorage 产生的单次事件只记录，不冻结；
- 同一用户同一资源指纹的少量重复拒绝优先限流，不直接永久封禁；
- 自动冻结必须可由管理员解封；
- 解封和自动冻结都写入不可变审计记录；
- 自动策略关闭时仍保留事件记录和人工冻结能力。

## 3. 技术方案

### 3.1 数据存储

新增 PostgreSQL 表 `security_events`，作为安全事件事实来源：

```text
security_events
- id
- user_id
- event_type
- resource_type
- resource_fingerprint
- client_fingerprint
- ip_fingerprint
- action
- reason_code
- metadata_json
- occurred_at
- expires_at
```

`metadata_json` 只允许白名单字段，禁止把任意请求对象直接序列化写入。事件表按 `occurred_at` 保留和清理，保留期由配置决定，不能影响用户业务数据。

Redis 只保存短窗计数、限流状态和冻结通知，不保存唯一审计事实：

```text
security:ownership-denied:user:{user_fingerprint}
security:ownership-denied:client:{client_fingerprint}
security:suspended:user:{user_id}
```

### 3.2 所有权接入

`backend/app/core/ownership.py` 继续作为归属拒绝的统一入口，调用安全事件服务记录事件。为避免每个业务模块复制策略：

- ownership helper 负责产生标准拒绝事件；
- 安全策略服务负责计数、限流和冻结决策；
- 账户状态服务负责 API、SSE、WebSocket 的统一检查；
- Admin API 只调用冻结服务，不直接改写策略字段。

### 3.3 Token 与长连接失效

JWT 仍只承载身份和过期信息，不写入冻结原因或安全事件。验证时增加 `security_version` 或等价的 Redis/数据库撤销检查：

```text
请求 JWT
→ 验证签名和过期时间
→ 查询账户状态/安全版本
→ active 才允许继续
→ SSE/WebSocket 建立后监听冻结版本变化
```

禁止仅依赖 JWT 自然过期，因为现有 Token 有效期较长，封禁必须快速生效。

### 3.4 修改目标文件与目录

- `backend/app/core/ownership.py`：接入标准安全事件记录，不改变统一“不存在”语义。
- `backend/app/security/events.py`：安全事件模型、脱敏和写入服务。
- `backend/app/security/risk_policy.py`：Redis 短窗计数、阈值和分级响应。
- `backend/app/security/account_status.py`：冻结、解封、状态检查和安全版本。
- `backend/app/models/__init__.py`：`SecurityEvent` 与用户冻结字段。
- `backend/app/core/security.py`：统一账户状态和安全版本校验。
- `backend/app/api/v1/users_admin.py`：明确冻结/解封接口和 Admin 权限检查。
- `backend/app/api/v1/security_events_admin.py`：安全事件查询 API。
- `backend/app/api/v1/audit_log.py`：区分管理员操作日志和安全事件展示边界。
- `frontend/src/views/Admin/Users/`：普通用户 Tab 与风险用户 Tab、风险状态、冻结/解封和事件入口。
- `frontend/src/views/Admin/AuditLog/`：安全事件筛选和详情视图。
- `backend/alembic/versions/`：安全事件表和用户状态字段迁移。
- `backend/tests/test_ownership_security_events.py`：记录、脱敏、聚合和归属测试。
- `backend/tests/test_account_suspension.py`：冻结、解封、Token、SSE 和 WebSocket 测试。

不新增第二套 ownership helper，不在业务 API 中直接查询安全事件或直接修改用户冻结字段。

## 4. 统一验收与上线口径

先以 `logged-only` 模式上线，观察以下指标后再开启自动冻结：

- `ownership.denied` 每用户/每客户端/每 IP 计数；
- `security_event.action=throttled` 数量；
- 自动冻结数量和人工解封比例；
- 冻结后重复请求数量；
- 安全事件写入失败数量；
- API、SSE、WebSocket 因账户状态拒绝的数量。

事件写入失败不能阻塞正常 ownership 拒绝，也不能让请求从拒绝变成放行。策略异常时回退为记录和现有授权拒绝，不自动放宽权限。

安全事件按 `expires_at` 每小时清理一次。清理任务可独立停用；停用期间只会增加待清理事件，不影响业务数据，恢复任务后继续按到期时间删除。

上线前必须一次性验收：跨用户访问统一返回“不存在”、敏感字段不落明文、Redis 窗口和阈值边界、Admin 权限、人工冻结/解封、api/SSE/WebSocket 失效、单次误报不冻结、事件清理不影响业务数据，以及 `logged-only` 回滚开关。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 旧标签页或切换账号造成误报 | 正常用户被误冻结 | 单次只记录，先限流后短暂冻结，灰度观察解封比例 |
| 安全事件包含敏感字段 | 泄露用户资源或身份信息 | 字段白名单、指纹化、禁止任意 metadata 序列化 |
| Redis 丢失计数 | 自动响应延迟或不触发 | PostgreSQL 事件仍完整记录，策略丢失时保持拒绝不放行 |
| 冻结未影响已有 SSE/WebSocket | 被封账号仍能继续操作 | 安全版本检查和长连接关闭机制 |
| Admin 封禁接口被误用 | 错误冻结或无法追责 | 明确 suspend/unsuspend、确认门和不可变审计 |
| 事件量快速增长 | 数据库压力和查询变慢 | 索引、分区/保留策略、聚合查询和异步写入边界 |

待确认：

- ✅ SSE/WebSocket 的存续期检查采用定时账户状态检查，最大检查间隔为 5 秒。
- 🔲 是否启用外部告警渠道；默认关闭，管理员可配置目标邮箱后开启。

外部告警采用可选邮箱通知：

- 默认不发送外部邮件，不影响 Admin 页面、服务端指标和安全事件落库；
- 管理员显式开启后，发送到配置的目标邮箱，支持一个或多个经校验的邮箱地址；
- 邮件只包含事件类型、时间窗口、脱敏后的聚合计数、处理动作和 Admin 入口，不包含资源明文 ID、IP、User-Agent、Token、Cookie、正文、文件名或 API Key；
- 邮箱地址和开关属于运行配置，修改时必须校验格式并原子保存，不能把凭据写入 URL、日志或前端响应；
- 邮件发送失败只记录脱敏错误类型并保留失败指标，不阻塞安全事件记录、授权拒绝或账户冻结；
- 后续实现必须补充发送频率限制、重复告警合并、管理员权限校验和关闭后的回归测试。

## 6. 唯一实施 TODO

### Phase 0：策略与隐私基线
- [x] `SEC2-001` 冻结事件字段、指纹策略、90 天保留期、5/10 次阈值和默认灰度策略；验收：字段白名单、隐私边界和默认关闭策略在代码与测试中一致。

### Phase 1：安全事件持久化

- [x] `SEC2-002` 建立 `security_events` 表；验收：迁移通过，跨用户访问统一返回“不存在”，敏感字段不落明文。
- [x] `SEC2-003` 接入 `ownership.denied` 独立事务记录；验收：写入失败不改变授权拒绝语义，并有回归测试。

### Phase 2：风险计数与策略判定

- [x] `SEC2-004` 实现 Redis 5 分钟短窗计数和 5/10 次风险判定；验收：窗口、TTL、用户/客户端/IP 隔离和故障降级可测试。
- [x] `SEC2-005` 实现真实敏感接口限流，并将窗口、阈值和冻结时长接入 `security` 配置；验收：普通 api/SSE/终端 WebSocket 鉴权达到阈值后拒绝，HTTP 接口返回 429，策略结果携带配置化冻结时长，配置变更无需改代码。

### Phase 3：账户与 Admin 风险管理

- [x] `SEC2-006` 建立统一账户冻结/解封服务和安全版本；验收：人工冻结、解封、确认门和版本递增可用。
- [x] `SEC2-007` 接入 Admin 风险用户 Tab 和单用户安全事件详情；验收：管理员可查看风险聚合并执行冻结/解封。

### Phase 4：会话即时失效

- [x] `SEC2-008` 接入普通 API、SSE、终端 WebSocket 的账户状态检查；验收：冻结后新请求被拒绝，已有长连接最多 5 秒内失效，旧连接不因解封自动恢复。

### Phase 5：测试、灰度与回滚

- [x] `SEC2-009` 完成安全事件清理、失败指标、误报和回滚验证；验收：过期事件定时清理且不影响业务数据，专项测试通过，默认保持 `logged-only`。

### Phase 6：安全运营闭环

- [x] `SEC2-010` 从请求上下文补齐客户端、IP、User-Agent HMAC 指纹；验收：来源明文、凭据和正文均不落库或日志。
- [x] `SEC2-011` 将 `throttled` / `suspended` 接入真实执行链路并记录自动动作；验收：限流真实生效，自动冻结受配置开关控制，策略事件保留不可变脱敏记录，失败时保持拒绝不放行。
- [x] `SEC2-012` 增加 Admin 全局安全事件视图和筛选；验收：独立展示并支持事件类型、用户、指纹、资源类型、动作和时间筛选。
- [x] `SEC2-013` 增加可选外部邮箱告警；验收：默认关闭，目标邮箱校验通过，邮件只发送脱敏聚合摘要，发送失败不阻塞安全链路。
