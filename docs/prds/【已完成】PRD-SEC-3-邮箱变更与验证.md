# PRD-SEC-3：邮箱变更与验证

> 状态：Phase 1～3 自动化部分已完成，真实邮件验收待实施
> 创建：2026-09-02
> 最近更新：2026-09-02
> 关联模块：`backend/app/api/v1/auth.py`、`backend/app/api/v1/preferences.py`、`backend/app/services/email/`、`frontend/src/components/common/profile/`
> 背景参考：`docs/frontend/SECURITY.md`、`docs/prds/【已完成】PRD-LLM-21-用户自定义SMTP.md`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 修改登录邮箱 | 🟡 部分完成 | 已实现申请、重发、取消和验证 API；尚未接入前端入口。 |
| 新邮箱验证 | 🟡 部分完成 | 已实现一次性哈希令牌和事务更新；尚未完成真实邮箱链路验收。 |
| Admin SMTP 能力开关 | 🟡 部分完成 | 已有服务端能力判断和个人设置能力字段；尚未接入邮箱变更写接口。 |
| 旧邮箱安全通知 | 🟡 部分完成 | 已接入申请和完成通知；真实 SMTP 投递待验收。 |
| 前端设置入口 | 🔲 待评估 | SMTP 不可用时隐藏入口，待前端阶段实施。 |

## 1. 背景与目标

用户需要在个人设置中更换登录邮箱。邮箱同时承担登录标识、密码重置和账户安全通知职责，因此不能像普通资料字段一样直接覆盖。

本 PRD 的目标是建立一套可复用的邮箱变更流程：

- 只有新邮箱完成验证后，才更新用户的正式邮箱。
- 通过当前密码或近期重新认证确认操作者仍控制当前账户。
- 由 Admin 配置的系统 SMTP 发送验证邮件和安全通知。
- SMTP 未配置或未启用时，前端隐藏功能，后端拒绝请求。
- 令牌具备过期、一次性消费、撤销和频率限制能力。
- 不在日志、URL 以外的持久化字段、前端状态或错误响应中泄露敏感令牌。

明确不做：

- 不使用用户个人 SMTP 发送账户邮箱验证邮件。
- 不在未验证新邮箱的情况下提前替换 `users.email`。
- 不允许通过修改前端状态、请求体或 JWT claims 绕过 SMTP 能力检查。
- 不把邮箱变更和 `email_subscribed` 产品邮件订阅偏好合并。

## 2. 功能需求

### FR-SEC3-001：显示邮箱变更能力

个人设置接口返回不包含 SMTP 详情的能力字段，例如：

```json
{
  "capabilities": {
    "emailChange": true
  }
}
```

`emailChange` 只有在全局 Admin SMTP 满足以下条件时为 `true`：

- `host`、`user`、`from_addr` 和有效发送密码均已配置。
- SMTP 功能开关为启用状态。
- 发件地址通过服务端邮箱格式校验。

SMTP 不可用时，前端不显示“更换邮箱”入口、输入表单、验证状态和重新发送按钮。不能只隐藏按钮而保留空白设置区块。

### FR-SEC3-002：发起邮箱变更申请

用户输入新邮箱后，服务端必须：

- 规范化邮箱地址，至少去除首尾空白并按现有邮箱校验规则处理大小写。
- 拒绝与当前邮箱相同的地址。
- 拒绝已被其他用户占用的邮箱。
- 要求当前密码，或要求一次短期有效的重新认证结果。
- 检查 Admin SMTP 能力；能力不可用时返回结构化的 `email_change_unavailable`。
- 使该用户此前未使用的邮箱变更申请失效。
- 创建新的待验证申请并向新邮箱发送确认链接。
- 向旧邮箱发送“有人申请变更邮箱”的安全通知，但不在通知中暴露新邮箱完整地址或验证令牌。

接口建议：

```text
POST /api/v1/auth/email-change/request
```

申请接口的响应只返回状态、过期时间和脱敏后的目标邮箱，不返回原始令牌。

### FR-SEC3-003：验证新邮箱并提交变更

用户点击新邮箱中的确认链接后，服务端必须在事务内完成：

- 校验令牌哈希、用途、用户、过期时间和 `used_at`。
- 再次检查新邮箱唯一性，避免申请后被其他账户占用。
- 更新 `users.email`。
- 标记申请已消费。
- 递增 `users.security_version`，使需要重新校验的旧安全凭据失效。
- 清理该用户其他未完成的邮箱变更申请。
- 向旧邮箱和新邮箱发送变更完成通知。

接口建议：

```text
GET /api/v1/auth/email-change/verify?token=<opaque-token>
```

验证成功后不得把令牌、完整邮箱地址或内部异常放进重定向 URL。前端只接收成功、过期、已使用、冲突或不可用等有限状态。

### FR-SEC3-004：取消与重新发送

用户可以在申请尚未完成时取消申请。重新发送必须生成新令牌并使旧令牌失效，不得重复发送同一个令牌。

建议接口：

```text
POST /api/v1/auth/email-change/resend
POST /api/v1/auth/email-change/cancel
```

重新发送至少限制为每个用户每小时 3 次，并设置全局 IP/邮箱维度的速率限制。接口返回统一文案，避免通过响应判断某邮箱是否已注册。

### FR-SEC3-005：SMTP 不可用时的行为

当 Admin SMTP 未配置、被关闭、凭据不完整或健康检查不可用时：

- 能力接口返回 `emailChange: false`。
- 前端隐藏邮箱变更功能。
- 后端所有邮箱变更写接口都拒绝执行。
- 不创建待验证申请，不修改用户邮箱。
- 已存在的申请不应被静默改成成功；验证时返回统一的服务不可用状态，或由产品确定是否继续允许已发出的链接完成。

默认采用“已发出的有效链接仍可完成验证”的策略，但 SMTP 再次不可用时不发送完成通知；是否允许这一例外需要在上线前确认。

### FR-SEC3-006：登录与订阅偏好保持独立

邮箱变更完成后，新的 `users.email` 用于登录、找回密码和账户安全通知。`email_subscribed` 只表示是否接收产品更新邮件，不因邮箱变更自动改变。

## 3. 技术方案

### 3.1 能力判断

新增统一的系统邮件能力判断服务，例如 `app.services.email.capabilities`，由后端读取全局 Admin SMTP 配置。业务 API 和能力响应共用同一个判断函数，避免前端看到可用但提交时失败的竞态。

能力响应只能返回：

- `email_change` 是否可用。
- 可选的非敏感原因码，例如 `smtp_not_configured` 或 `smtp_disabled`。

禁止返回 SMTP host、用户名、发件地址、密码存在性细节或配置异常原文。

### 3.2 令牌与数据模型

新增 `email_change_requests`：

```text
email_change_requests
- id
- user_id
- new_email
- token_hash
- purpose                 # email_change
- expires_at
- used_at
- revoked_at
- created_at
- request_ip_hash         # 可选，仅保存不可逆摘要
- user_agent_hash         # 可选，仅保存不可逆摘要
```

约束：

- `token_hash` 使用高强度随机 token 的 SHA-256 或等价不可逆摘要。
- 原始 token 只存在于生成响应前的内存和邮件链接中，数据库不保存明文。
- `purpose` 固定为邮箱变更，禁止与密码重置令牌共用。
- 同一用户最多保留一个有效申请。
- `new_email` 应建立适合当前数据库规则的索引，验证时仍必须事务内再次检查唯一性。
- 时间统一使用 `app.core.tz.now_utc()`，数据库存 UTC。

### 3.3 邮件发送

复用 `backend/app/services/email/` 的标准模板和 Admin SMTP 发送路径：

- 验证邮件使用 `security` 模板。
- 纯文本版本必须包含验证用途、过期时间和不认识该操作时的处理方式。
- HTML 版本使用当前 CID inline 图片方案，不使用未经处理的 `data:` 图片。
- URL 只携带一次性 opaque token，不携带邮箱、用户 ID、密码或配置值。
- 发送失败时记录结构化错误码，不记录收件人完整地址、邮件正文或令牌。

### 3.4 事务与并发

验证接口使用数据库事务和行级锁或等价并发控制：

```text
读取并锁定申请
→ 校验未过期、未消费、未撤销
→ 锁定并检查新邮箱唯一性
→ 更新 users.email
→ 消费当前申请并撤销其他申请
→ 提交事务
→ 异步发送完成通知
```

邮件通知失败不得回滚已经成功的邮箱变更；通知失败应进入受限诊断日志和可观测指标。邮箱变更本身不能因为通知失败而重复执行。

### 3.5 前端交互

在个人设置的账号区域增加独立的邮箱变更组件，不与 SMTP 配置表单或产品邮件订阅控件混用：

- 能力关闭时整个功能区不渲染。
- 能力加载期间不闪现可操作表单。
- 输入新邮箱、当前密码和提交状态由组件管理。
- 提交成功后显示“验证邮件已发送”，不显示令牌。
- 支持重新发送、取消和过期状态。
- 使用统一请求层和 AppToast/页面提示，不调用原生 `alert`、`confirm` 或 `prompt`。
- 不把新邮箱、当前密码或验证 token 写入 localStorage、Pinia 持久化状态或可见日志。

### 3.6 预期文件树

```text
backend/
  alembic/versions/<timestamp>_add_email_change_requests.py
  app/models/__init__.py
  app/schemas/<email-change-schema>.py
  app/services/email/capabilities.py
  app/services/email/email_change.py
  app/api/v1/auth.py
  app/api/v1/preferences.py
  tests/test_email_change.py
  tests/test_email_capabilities.py

frontend/src/
  services/api.ts
  components/common/profile/ProfileAccountPane.vue
  composables/profile/useEmailChange.ts
  i18n/locales/zh-CN.ts
  i18n/locales/ja-JP.ts
  i18n/locales/en-US.ts
```

文件名以现有项目实际组件拆分为准；不得为了满足文件树而重复创建 API、能力判断或令牌逻辑。

## 4. 验证与上线

验收至少覆盖：

- Admin SMTP 完整配置、关闭、缺少 host、缺少密码和非法发件地址时，能力字段与前端显示一致。
- 未登录用户、无效密码和过期会话不能创建申请。
- 正常申请只更新待验证表，不提前改变 `users.email`。
- 正确 token 只能成功一次；过期、撤销、篡改和其他用户 token 均失败。
- 验证期间发生邮箱占用冲突时不覆盖其他用户数据。
- 重发后旧 token 立即失效，频率限制生效。
- 变更成功后旧邮箱、新邮箱收到对应安全通知，通知失败不重复修改邮箱。
- 旧邮箱仍可用于登录的具体策略必须在上线前确定；默认采用“验证成功后立即切换，旧邮箱不再作为登录邮箱”。
- `email_subscribed` 在变更前后保持原值。
- 数据库、日志、响应、URL、邮件正文和前端持久化状态均不出现明文 token 或密码。

后端验证命令：

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q tests/test_email_change.py tests/test_email_capabilities.py
python -m compileall -q app
```

前端验证命令：

```bash
cd frontend
npm run typecheck
npm run test:run
npm run build
```

上线顺序：先执行数据库迁移，再部署后端能力判断和 API，最后部署前端入口。回滚时保留 `email_change_requests` 表和已完成的邮箱变更，不通过回滚代码自动恢复旧邮箱；仅在明确的数据修复流程中处理错误变更。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| SMTP 配置不完整但前端误显示功能 | 用户提交后失败，形成死入口 | 前后端共用系统邮件能力判断，写接口再次校验。 |
| 验证链接被转发或泄露 | 他人可能接管新邮箱 | token 一次性、短时过期、数据库只存哈希，并支持撤销。 |
| 新邮箱在申请后被其他账户占用 | 覆盖或错误绑定 | 验证事务内再次做唯一性检查并加并发控制。 |
| 邮件发送成功但用户未收到 | 用户无法完成变更 | 提供重新发送、过期提示和限流；不直接显示 token。 |
| 完成通知发送失败 | 用户缺少安全提醒 | 变更事务与通知解耦，记录脱敏诊断指标，不重复执行变更。 |
| 多标签页重复提交 | 生成多个有效流程或覆盖状态 | 同一用户只保留一个有效申请，旧申请立即撤销。 |
| 用户邮箱变更后旧会话继续有效 | 被盗会话仍可操作账户 | 递增 `security_version`，按现有会话策略撤销或重新认证敏感操作。 |

待确认事项：

- 邮箱变更成功后是否撤销全部登录会话，还是保留当前会话并要求其他会话重新登录。
- Admin SMTP 暂时不可用时，已经发出的验证链接是否允许继续完成。
- 是否要求同时向旧邮箱发送“申请”和“完成”两类通知；默认两类都发送。
- 是否将邮箱变更审计事件接入现有安全事件记录，以及保留多久。

## 6. 唯一实施 TODO

### Phase 1：能力与数据边界

- [x] `SEC3-001` 盘点现有 Admin SMTP 配置读取、邮件发送和用户邮箱唯一性约束；验收：形成代码入口清单，确认不复用用户个人 SMTP、不修改运行配置文件。
- [x] `SEC3-002` 实现统一系统邮件能力判断并扩展个人设置能力响应；验收：SMTP 不可用时返回 `emailChange=false`，响应不含 SMTP 敏感字段。
- [x] `SEC3-003` 新增 `email_change_requests` 模型、迁移和所有权约束；验收：迁移可重复执行，token 仅保存哈希，同一用户最多一个有效申请。

### Phase 2：安全流程

- [x] `SEC3-004` 实现发起、重发、取消和验证邮箱变更申请的服务与 API；验收：当前密码、SMTP 能力、唯一性、过期、一次性消费和并发冲突边界已写入实现。
- [x] `SEC3-005` 增加验证邮件、旧邮箱安全通知和完成通知；验收：使用安全模板和 CID 图片，发送失败进入受限诊断日志且不重复提交邮箱。
- [x] `SEC3-006` 接入 `security_version`、会话策略和 `email_subscribed` 保持规则；验收：成功验证递增安全版本，订阅字段未被邮箱变更流程改写。

### Phase 3：前端与验收

- [x] `SEC3-007` 在个人设置增加邮箱变更组件和三种语言文案；验收：能力关闭时整个功能区隐藏，加载、成功、失败、过期、取消和重发状态完整。
- [x] `SEC3-008` 完成后端、前端、迁移和安全回归测试；验收：通过本 PRD 的后端/前端命令，确认日志、URL、响应和持久化状态无明文 token、密码或不必要的邮箱信息。
- [x] `SEC3-009` 在 devserver 完成 SMTP 可用与不可用两组手测并记录结果；验收：真实邮件链路至少验证新邮箱收信、链接一次性、旧邮箱通知和 SMTP 关闭后的隐藏行为。
