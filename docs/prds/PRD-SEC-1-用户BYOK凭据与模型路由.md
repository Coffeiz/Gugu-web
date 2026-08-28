# PRD-SEC-1：用户 BYOK 凭据与模型路由

状态：规划中

## 0. 发布与解锁策略

- 托管服务由后台总开关控制，BYOK 作为用户付费权益解锁。
- 本地部署版本默认开启，用户自主管理 provider 凭据。
- 总开关关闭时，前端隐藏入口，后端拒绝新增、测试和使用 BYOK 凭据。
- 关闭时保留加密凭据，重新开启并恢复权益后可继续使用。
- 权益判定必须在服务端完成，不能由前端字段或 JWT 自定义 claims 决定。

## 1. 背景与目标

允许用户使用自己的 provider API Key、JWT 或其他访问令牌调用模型，同时保证凭据隔离、不可回显、可撤销，并统一接入现有 provider adapter、ContextBudget 与 ContextBranch。

BYOK 不改变工具权限和 Agent 安全边界，只改变模型凭据来源。

## 2. 安全边界

- 登录 JWT 只负责请求身份鉴权和用户所有权校验。
- 用户 provider Key/JWT 不放入登录 JWT、上下文、工具结果或 URL。
- 数据库不保存明文凭据。
- 主密钥只保存在服务端运行环境或 KMS/Vault。
- 用户 Key 失败时不得静默切换平台 Key。

## 3. 加密设计

采用信封加密：

```text
随机 data key --AES-256-GCM--> API Key/JWT ciphertext
随机 data key --AES-256-GCM--> encrypted_data_key（使用主密钥）
```

每条凭据独立生成 nonce，并保存：

- `ciphertext`
- `nonce`
- `encrypted_data_key`
- `key_version`
- provider 与凭据类型

算法必须使用 AES-256-GCM 或等价的 AEAD；禁止使用无完整性校验的裸 AES-CBC。

开发阶段主密钥可通过权限为 `600` 的 `.env` 注入，例如 `CREDENTIALS_MASTER_KEY`。生产环境迁移到 KMS/Vault。主密钥不得提交 Git、写入配置响应或日志。

## 4. 数据模型

```text
user_provider_credentials
- id
- user_id
- provider
- api_format
- credential_type
- encrypted_value
- nonce
- encrypted_data_key
- key_version
- base_url
- model
- enabled
- last_verified_at
- expires_at
- created_at
- updated_at
```

所有查询必须通过用户所有权检查；管理员默认只能看到 provider、状态和脱敏值。

## 5. 调用流程

```text
登录 JWT
→ 后端校验用户身份
→ 读取用户凭据并解密
→ resolve model config
→ provider adapter
→ ContextBudget / ContextBranch / 主对话
→ 请求结束释放凭据引用
```

平台 Key 与用户 Key 必须在模型配置中显式标记，审计日志只记录来源类型、provider、结果和耗时。

## 6. 产品交互

- 设置页支持添加、测试、启用、停用和删除凭据。
- 只显示掩码，例如 `sk-••••••9x2a`。
- 测试成功只返回连接状态、模型和耗时，不返回响应中的凭据片段。
- 过期 JWT 显示过期状态，不自动重试或切换来源。
- 删除凭据后立即失效，并清理缓存中的 provider client。

后台管理增加“用户 BYOK”总开关，并显示托管服务付费解锁/本地部署默认开放的策略。

## 7. 实施 TODO

### Phase 0：威胁建模与盘点

- [ ] 盘点现有 JWT、中间件、provider 配置和日志脱敏入口。
- [ ] 确定主密钥来源、轮换方案和本地开发方案。
- [ ] 确认支持的 provider、API 格式和凭据类型。

### Phase 1：凭据存储

- [ ] 建立凭据表和迁移。
- [ ] 增加后台总开关与统一权益判定服务。
- [ ] 区分托管服务与本地部署默认开启策略。
- [ ] 实现 AES-256-GCM 信封加密/解密模块。
- [ ] 实现 key version 和主密钥轮换。
- [ ] 增加所有权、过期和删除校验。

### Phase 2：模型路由

- [ ] 在统一模型解析层选择用户 Key 或平台 Key。
- [ ] 在保存、测试、解密和实际调用入口统一检查 BYOK 解锁状态。
- [ ] 接入 provider adapter、ContextBudget、ContextBranch 和主对话。
- [ ] 清理渠道级、工具级重复凭据判断。

### Phase 3：前端与审计

- [ ] 增加凭据管理 UI、掩码展示和测试流程。
- [ ] 增加失败、过期和撤销状态。
- [ ] 审计所有日志、错误响应和异常堆栈，确保无密钥泄露。

### Phase 4：安全验收

- [ ] 验证数据库、备份、日志、URL、SSE 和工具结果均无明文凭据。
- [ ] 验证跨用户无法读取、测试或删除其他用户凭据。
- [ ] 验证解密失败不会静默回退平台 Key。
- [ ] 验证主密钥轮换和凭据撤销。
- [ ] 验证总开关关闭时任何入口均无法使用 BYOK，开启后可恢复且密文不丢失。

## 8. 验收标准

- 用户可以安全配置并撤销自己的 provider 凭据。
- 凭据全程不进入 prompt、history、tool result 或前端响应。
- JWT 仅承担身份认证，不承担凭据加密。
- 所有调用路径使用统一模型路由，不产生 Web/IM 分叉。
- 密钥轮换、过期和删除可验证、可审计。
