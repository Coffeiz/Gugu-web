# PRD-SEC-2：越权检测与快速封禁

> 状态：Phase 5 已完成
> 创建：2026-08-29
> 最近更新：2026-08-29
> 关联模块：`backend/app/core/ownership.py`、`backend/app/api/v1/users_admin.py`、`backend/app/api/v1/audit_log.py`、`backend/app/core/security.py`
> 背景参考：现有 `ownership.denied` 结构化告警、管理员用户封禁接口和安全审计报告 M1

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：现状盘点与策略冻结 | ✅ 已完成 | 已完成现状盘点，冻结事件字段、指纹、保留期、阈值和默认响应策略 |
| Phase 1：安全事件持久化 | ✅ 已完成 | 新增独立安全事件表、迁移、HMAC 指纹字段和 90 天到期时间；ownership 拒绝已接入独立事务写入 |
| Phase 2：快速计数与自动响应 | ✅ 已完成 | Redis 5 分钟短窗计数、5/10 次分级判定和 fail-open；自动响应保持关闭 |
| Phase 3：Admin 风险管理 | ✅ 已完成 | 风险用户 Tab、安全事件详情、明确冻结/解封接口和统一账户状态服务 |
| Phase 4：会话即时失效 | ✅ 已完成 | 普通 API、SSE、终端 WebSocket 的建立检查和存续期冻结检查 |
| Phase 5：测试、灰度与回滚 | ✅ 已完成 | 完成安全回归、误报验证和生产观测 |

## 1. 背景与目标

当前 `get_owned()` 在发现资源属于其他用户时，会记录 `ownership.denied` 并返回 `None`。这能阻断资源枚举，但目前事件主要停留在日志和指标层，缺少：

- 可供管理员检索的持久安全事件记录；
- 针对重复探测的短窗口计数和限流；
- 对已登录用户的快速冻结与现有连接失效；
- Admin 页面中的风险状态、事件详情和封禁操作。

### 1.1 Phase 0 现状盘点结论

- `backend/app/core/ownership.py` 是当前统一的资源归属拒绝入口；不属于请求用户的资源统一返回 `None`，调用方继续按“不存在”处理。
- 当前 `ownership.denied` 只写结构化 WARNING，并通过 `opsmetrics.record_security()` 写入 Redis 日聚合计数；没有 PostgreSQL 安全事件事实表。
- `backend/app/models/__init__.py` 的用户状态目前只有 `is_active`；没有临时冻结截止时间、冻结原因或 Token 安全版本。
- `backend/app/api/v1/users_admin.py` 已有 `PATCH /{user_id}/ban`，但它是 toggle 语义，不能表达时长、原因和自动/人工来源。
- `frontend/src/views/Admin/Users/index.vue` 当前只有普通用户列表，没有风险用户 Tab；`frontend/src/views/Admin/AuditLog/index.vue` 只展示 `audit_logs` 管理员操作记录。
- `backend/app/core/security.py` 的普通 API 鉴权会检查 `is_active`，但 `get_current_user_id()` 等长连接身份解析路径仍是 JWT-only，尚无统一冻结版本检查。

### 1.2 Phase 0 冻结决策

- 安全事件事实来源为 PostgreSQL `security_events`；Redis 只保存短窗口计数、限流状态和通知，不作为审计事实来源。
- 资源、IP、客户端和 User-Agent 使用服务端密钥 HMAC-SHA-256 指纹；不保存资源明文 ID、IP 明文、Token、Cookie、正文、文件名或 API Key。
- 事件默认保留 90 天，超过保留期按安全事件清理任务删除；用户业务数据不受影响。
- 5 分钟内同用户 5 次 ownership 拒绝触发敏感接口限流；5 分钟内 10 次触发临时冻结 10 分钟。
- 自动冻结初版默认关闭，以 `logged-only` 灰度；人工 Admin 冻结能力不受该开关影响。
- 单次旧标签页、切换账号或过期缓存导致的 ownership 拒绝只记录，不冻结。
- `account_status`、`suspended_until`、`suspended_reason` 和 `security_version` 由统一账户状态服务维护；业务 API 不直接改字段。

本 PRD 的目标是把越权拒绝从单条告警扩展为可审计、可响应、可恢复的安全闭环，同时控制误报。单次由旧标签页、切换账号或过期缓存造成的越权请求不得直接冻结用户。

不改变现有多租户边界：资源仍必须通过 `get_owned()` 或等价的显式归属过滤；前端展示和安全事件记录都不能替代服务端授权。

### 1.3 Phase 1 实际完成项

- 新增 `SecurityEvent` 模型和用户反向关系，安全事件独立于管理员操作日志。
- 新增 `backend/app/security/events.py`：使用服务端密钥 HMAC-SHA-256 生成稳定指纹，只保留固定白名单元数据。
- `get_owned()` 的拒绝路径在独立数据库事务中持久化 `ownership.denied`，写入失败不改变原有 `None` 返回语义。
- 新增 `20260829000002_add_security_events` 迁移，并顺接现有 `20260829000001`，避免重复 revision 和多 head。
- 新增测试覆盖事件落库、稳定指纹、明文排除和默认动作。
- 90 天通过 `expires_at` 固化在事件记录中；定期清理任务属于 Phase 5，Phase 1 不主动删除数据。

### 1.4 Phase 2 实际完成项

- 新增 `backend/app/security/risk_policy.py`，按用户、客户端和 IP 使用独立 HMAC 指纹 Redis key 计数。
- 计数窗口固定为 5 分钟，首次写入设置 TTL，后续递增不延长窗口。
- 达到 5 次返回 `throttled`，达到 10 次返回 `suspended`；判定结果不直接修改账户状态。
- `ownership.denied` 已调用短窗口策略；Redis 故障时 fail-open，不改变原有拒绝语义。
- `AUTO_RESPONSE_ENABLED` 默认关闭，冻结执行保留给后续统一账户状态服务。
- 新增测试覆盖阈值、用户/客户端/IP 隔离、TTL 语义和 Redis 故障降级。

### 1.5 Phase 3 实际完成项

- `User` 增加 `account_status`、`suspended_until`、`suspended_reason` 和 `security_version`，并新增对应迁移。
- 新增 `backend/app/security/account_status.py`，统一执行临时冻结和解封；兼容 `is_active` 并递增安全版本。
- Admin 用户 API 新增风险用户聚合、安全事件详情、明确的 `suspend` / `unsuspend` 接口。
- 原有 `PATCH /admin/users/{user_id}/ban` 改为复用统一账户状态服务，保留兼容入口。
- 用户管理新增独立“风险用户”Tab、事件详情展开、冻结确认弹窗和解封操作。
- Admin 查询只展示脱敏指纹和聚合字段，不展示资源明文、请求正文或凭据。
- 新增测试覆盖冻结/解封状态、版本递增和风险用户查询；前端类型检查通过。
- Phase 4 仍负责把账户状态接入普通 API、SSE、WebSocket 的即时失效链路。

### 1.6 Phase 4 实际完成项

- `backend/app/core/security.py` 新增统一账户状态判断；普通 API 鉴权同时检查 `is_active` 和 `account_status`。
- 长连接身份解析在建立 SSE 前通过独立短生命周期数据库会话检查账户，不占用流式请求的数据库连接。
- 用户事件 SSE 每 5 秒检查一次账户状态；冻结后发送统一 `account_suspended` 事件并结束连接。
- 交互式终端 WebSocket 建立前检查账户，连接建立后通过状态任务轮询；冻结后关闭 WebSocket，解封不会恢复旧连接。
- 新增 Phase 4 账户状态和 SSE 冻结回归测试；PTY 连接清理同时取消状态检查任务。
- 安全版本已由 Phase 3 冻结/解封服务递增，后续可用于更细粒度的 Token 版本校验和跨进程通知。

### 1.7 Phase 5 实际完成项

- `_auto_cleanup_loop()` 每小时清理 `expires_at` 已到期的安全事件；清理失败只记录运维错误，不影响业务请求。
- 清理只作用于 `security_events`，不会删除用户、文件或其他业务数据；保留期仍由事件写入时固化为 90 天。
- 新增安全事件写入失败指标 `security_event.write_failed`，事件落库故障保持 fail-open 的原有授权拒绝语义，不会把拒绝变成放行。
- 保持 `logged-only` 默认灰度策略；Redis 故障、事件落库故障和策略异常均不自动冻结、不放宽权限。
- 新增保留期清理回归测试，并复核跨用户、脱敏、策略阈值、指标和账户状态测试；Phase 5 专项测试全部通过。
- 回滚边界固定为：可停用自动响应或安全清理任务，不回滚安全事件表和账户状态字段迁移；业务数据不参与安全事件清理。

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

## 4. 验证与上线

### Phase 0：盘点与策略冻结

- 确认所有 `get_owned()` 调用路径都能产生统一事件；
- 盘点现有 `audit_logs`、`opsmetrics`、`is_active` 和 Admin 封禁接口；
- 固定事件字段白名单、资源指纹算法和保留期限；
- 用旧标签页/切换账号场景验证单次误报不会冻结。

### Phase 1-2：事件和策略

- 单元测试验证跨用户访问只返回统一“不存在”；
- 验证事件不包含正文、Token、Cookie、文件名和密钥；
- 验证 Redis 计数过期、并发递增和策略幂等；
- 验证阈值边界和自动冻结/解封。

### Phase 3-4：Admin 和即时失效

- Admin 只能由管理员查看和操作；
- 冻结后新 API、SSE、WebSocket 均被拒绝；
- 已建立长连接在版本变化后关闭；
- 解封不会恢复旧连接；
- 所有人工和自动操作都有审计记录。

### Phase 5：灰度与观测

先以 `logged-only` 模式上线，观察以下指标后再开启自动冻结：

- `ownership.denied` 每用户/每客户端/每 IP 计数；
- `security_event.action=throttled` 数量；
- 自动冻结数量和人工解封比例；
- 冻结后重复请求数量；
- 安全事件写入失败数量；
- API、SSE、WebSocket 因账户状态拒绝的数量。

事件写入失败不能阻塞正常 ownership 拒绝，也不能让请求从拒绝变成放行。策略异常时回退为记录和现有授权拒绝，不自动放宽权限。

安全事件按 `expires_at` 每小时清理一次。清理任务可独立停用；停用期间只会增加待清理事件，不影响业务数据，恢复任务后继续按到期时间删除。

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

- [x] 已建立 SSE/WebSocket 的存续期检查采用定时账户状态检查；最大检查间隔为 5 秒。
- [ ] 是否需要接入外部告警渠道；初版只保留 Admin 页面和服务端指标。

## 6. 唯一实施 TODO

- [x] 完成 Phase 0 现状盘点，冻结事件字段白名单、指纹策略、90 天保留期限、5/10 次阈值和自动冻结默认关闭策略。
- [x] 建立 `security_events` 表及迁移，接入 `ownership.denied`，补充敏感字段排除测试。
- [x] 实现 Redis 短窗计数、限流和可配置的临时冻结策略。
- [x] 建立统一账户冻结/解封服务，补充 `security_version` 并接入 API、SSE、WebSocket。
- [x] 将 Admin 用户管理扩展为风险状态、明确冻结/解封和用户安全详情。
- [ ] 将 Admin 审计日志扩展为独立安全事件视图和筛选能力。
- [x] 完成误报、并发、跨用户、长连接失效、权限和脱敏测试。
- [x] 以 `logged-only` 灰度，上线指标稳定后再评估开启自动冻结。
- [x] 增加安全事件过期清理、写入失败指标和可停用的回滚边界。
