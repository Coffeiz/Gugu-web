# PRD-SEC-1：用户 BYOK 凭据与模型路由

状态：Phase 0 已完成，Phase 1 规划中

## 0. 发布与解锁策略

- 托管服务由后台总开关控制，BYOK 作为用户付费权益解锁。
- 本地部署版本默认开启，用户自主管理 provider 凭据。
- 总开关关闭时，前端隐藏入口，后端拒绝新增、测试和使用 BYOK 凭据。
- 关闭时保留加密凭据，重新开启并恢复权益后可继续使用。
- 权益判定必须在服务端完成，不能由前端字段或 JWT 自定义 claims 决定。

## 1. 背景与目标

允许用户使用自己的 provider API Key 或访问密钥调用模型及专项能力，同时保证凭据隔离、不可回显、可撤销，并统一接入现有 provider adapter、ContextBudget 与 ContextBranch。

BYOK 不改变工具权限和 Agent 安全边界，只改变指定能力的凭据和模型来源。

支持的能力范围：

- 通用模型 Provider：聊天、反思、压缩和工具调用所需模型。
- 深度研究：研究规划、检索或报告生成所需的模型/API。
- 相似图搜索：图像 embedding、视觉检索或相似度服务。
- 语音识别：音频转文字模型/API。

四类能力可以分别启用和测试，不要求使用同一个 provider 或同一把 Key。

## 2. 安全边界

- 登录 JWT 只负责请求身份鉴权和用户所有权校验。
- 用户 provider Key 不放入登录 JWT、上下文、工具结果或 URL。
- 数据库不保存明文凭据。
- 主密钥只保存在服务端运行环境或 KMS/Vault。
- 用户 Key 失败时不得静默切换平台 Key。

## 2.1 Phase 0 现状盘点（已完成）

### 身份与密钥边界

- 当前登录态使用服务端 `secret_key` 签发和校验 HS256 JWT；JWT 只包含用户身份、角色和过期时间，不承载 provider 凭据。
- SSE/普通 API 分别复用 JWT 校验入口，资源访问仍需走用户归属校验；BYOK 不能通过自定义 JWT claims 解锁。
- 现有 provider 凭据来自全局运行配置和管理员 LLM 预设，包含通用模型、深度研究、相似图搜索和语音识别配置；当前没有用户级凭据表，也没有用户级路由解析层。
- 配置读取接口和前端已有掩码逻辑，但这只是回显保护，不等于密文存储；新增 BYOK 不能直接复用全局配置写入路径。

### 已有密码学与日志能力

- `app.core.crypto` 已有基于 `secret_key` 经 HKDF 派生独立密钥的 AES-GCM 透明列类型，目前仅用于 UserBot `app_secret`。
- 该能力可复用 AEAD、随机 nonce 和密钥版本的基础实现，但 BYOK 仍需独立的主密钥/用途标签、轮换策略和凭据表，不能把 JWT 签名密钥直接当作数据密钥。
- `app.core.redaction.redact`、`diag_log` 和 `app.core.ownership.get_owned` 已提供错误脱敏、受限诊断和归属校验入口；新接口必须沿用，禁止把凭据写入可见日志、异常响应、URL、SSE 或上下文。

### 四类能力的现有入口

| capability | 当前配置/调用入口 | 当前凭据归属 | Phase 0 结论 |
|---|---|---|---|
| `llm` | `AISettings`、管理员 LLM preset、`agent.providers` | 全局/管理员 | 需在统一模型解析层增加用户级覆盖 |
| `deep_research` | `SearchSettings`、`agent.tools.deep_research` | 全局搜索配置 | 需按 provider 独立解析并保留配额/失败状态 |
| `similar_image_search` | `SearchSettings`、`agent.tools.search` 的百度千帆调用 | 全局搜索配置 | 需与普通网页搜索凭据隔离 |
| `speech_to_text` | `VoiceSettings`、`agent.voice.transcribe` | 全局语音配置 | 需独立于主模型，支持 OpenAI 兼容与 DashScope 格式 |

### 已确定的 Phase 0 设计决策

- 数据库只保存信封加密后的凭据；采用 AES-256-GCM/等价 AEAD，主密钥通过受保护运行环境注入，生产预留 KMS/Vault，开发环境不得提交密钥。
- 每条凭据独立 nonce、数据密钥和 `key_version`；轮换期间支持按版本解密并在成功写入时升级，禁止静默降级为平台 Key。
- `provider`、`api_format`、`capability`、`base_url`、`model` 是路由元数据；实际凭据只能在服务端短生命周期解密，绝不进入 prompt、history、tool result 或前端响应。
- 后续 Phase 1 先落用户级凭据表、总开关/权益判定和所有权约束；Phase 2 再接入四类能力的统一路由，避免在各工具中复制凭据判断。

## 3. 加密设计

采用信封加密：

```text
随机 data key --AES-256-GCM--> API Key ciphertext
随机 data key --AES-256-GCM--> encrypted_data_key（使用主密钥）
```

每条凭据独立生成 nonce，并保存：

- `ciphertext`
- `nonce`
- `encrypted_data_key`
- `key_version`
- provider 与凭据类型
- `capability`（`llm` / `deep_research` / `similar_image_search` / `speech_to_text`）

算法必须使用 AES-256-GCM 或等价的 AEAD；禁止使用无完整性校验的裸 AES-CBC。

开发阶段主密钥可通过权限为 `600` 的 `.env` 注入，例如 `CREDENTIALS_MASTER_KEY`。生产环境迁移到 KMS/Vault。主密钥不得提交 Git、写入配置响应或日志。

## 4. 数据模型

```text
user_provider_credentials
- id
- user_id
- provider
- api_format
- capability
- encrypted_value
- nonce
- encrypted_data_key
- key_version
- base_url
- model
- enabled
- last_verified_at
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
- 删除凭据后立即失效，并清理缓存中的 provider client。

后台管理增加“用户 BYOK”总开关，并显示托管服务付费解锁/本地部署默认开放的策略。

## 7. 实施 TODO

## 7.1 修改目标文件与目录

### Phase 1 已涉及

- `backend/app/core/config.py`：BYOK 总开关与运行环境主密钥配置。
- `backend/app/byok/crypto.py`：AES-GCM 信封加密、解密与主密钥版本轮换。
- `backend/app/byok/policy.py`：总开关与本地部署默认开放策略。
- `backend/app/byok/service.py`：用户凭据查询、加解密和元数据输出。
- `backend/app/byok/schemas.py`：BYOK CRUD 请求模型。
- `backend/app/models/__init__.py`：`UserProviderCredential` 用户凭据模型及归属关系。
- `backend/app/api/v1/byok.py`：用户凭据 CRUD API。
- `backend/app/main.py`：注册 `/api/v1/byok` 路由。
- `backend/alembic/versions/20260828000001_add_user_provider_credentials.py`：凭据表迁移。

### 后续 Phase 目标目录

- `backend/agent/providers/`：统一 LLM 用户凭据路由与 Provider adapter 接入。
- `backend/agent/tools/deep_research.py`、`backend/agent/tools/search.py`：深度研究与相似图搜索凭据解析。
- `backend/agent/voice.py`：语音识别凭据解析。
- `backend/app/api/v1/agent_admin.py`、`backend/app/api/v1/config.py`：平台配置与 BYOK 管理边界，不复用用户凭据写入路径。
- `frontend/src/views/`、`frontend/src/components/`、`frontend/src/stores/`：按能力分组的凭据管理 UI、掩码状态和总开关状态展示。
- `backend/tests/`：加密、轮换、所有权、删除和跨能力隔离测试。

### Phase 0：威胁建模与盘点

- [x] 盘点现有 JWT、中间件、provider 配置和日志脱敏入口。
- [x] 确定主密钥来源、轮换方案和本地开发方案。
- [x] 确认支持的 provider、API 格式和凭据类型。
- [x] 为通用模型、深度研究、相似图搜索和语音识别分别定义能力路由契约。

### Phase 1：凭据存储（已完成）

- [x] 建立凭据表和迁移。
- [x] 增加后台总开关与统一权益判定服务。
- [x] 区分托管服务与本地部署默认开启策略。
- [x] 实现 AES-256-GCM 信封加密/解密模块。
- [x] 实现 `CREDENTIALS_MASTER_KEY_VERSION` / `CREDENTIALS_MASTER_KEY_PREVIOUS` 版本轮换支持。
- [x] 增加所有权和删除校验。

### Phase 2：模型路由（已完成）

- [x] 在统一模型解析层选择用户 Key 或平台 Key。
- [x] 按 capability 解析对应的用户凭据、模型和 endpoint，不允许跨能力误用。
- [x] 在保存、测试、解密和实际调用入口统一检查 BYOK 解锁状态。
- [x] 接入 provider adapter、ContextBudget、ContextBranch 和主对话。
- [x] 清理渠道级、工具级重复凭据判断。

### Phase 3：前端与审计（已完成）

- [x] 增加凭据管理 UI、掩码展示和测试流程。
- [x] 按能力分组展示配置：通用模型、深度研究、相似图搜索、语音识别。
- [x] 增加失败、停用和撤销状态。
- [x] 审计所有日志、错误响应和异常堆栈，确保无密钥泄露。

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
- 四类能力均可独立配置、测试、启用和撤销。
- 密钥轮换和删除可验证、可审计。
