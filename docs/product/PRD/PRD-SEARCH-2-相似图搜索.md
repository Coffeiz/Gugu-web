# PRD-SEARCH-2：相似图搜索与 Agent 工具

> 状态：P1-P3 已实现，P4 待验证
> 创建：2026-08-21
> 最近更新：2026-08-21
> 所属层：搜索 / Agent 工具 / Admin 配置
> 关联模块：`backend/agent/tools/search.py`、`backend/app/core/chat_attach.py`、`backend/agent/runner.py`、`backend/app/api/v1/agent_admin.py`、`frontend/src/views/Admin/Agent/`
> 背景参考：[百度千帆相似图搜索 API](https://cloud.baidu.com/doc/qianfan-api/s/cmjqt5c7z)、[百度图像搜索产品说明](https://cloud.baidu.com/product/image-search.html)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 需求与能力边界 | ✅ 已完成 | 第一阶段采用百度千帆互联网相似图搜索，不实现私有图库索引。 |
| 图片输入统一适配 | ✅ 已完成 | 支持暂存附件和安全下载的网络 JPG/PNG 图片。 |
| Agent 工具与百度 Provider | ✅ 已完成 | 已注册 `search_similar_images`，接入百度千帆响应归一化。 |
| Admin 配置 | ✅ 已完成 | 已接入 API Key 掩码、启停、数量、超时、每日限额和连通测试。 |
| 自动化测试与真实 API 验证 | 🔲 待评估 | Mock API 测试通过后再使用真实凭据做端到端验证。 |

### 实施 TODO

- [x] **P0：确认配置边界**
  - [x] 确认 Admin 现有密钥存储、权限校验和脱敏返回方式。
  - [x] 确认群聊成员是否允许调用，以及调用量统计归属用户还是会话。
  - [x] 确认百度 API Key、免费额度和计费开关的上线责任人。
- [x] **P1：统一图片输入**
  - [x] 复用附件归属校验、暂存读取和外部 URL 安全校验。
  - [x] 增加实际 MIME、文件签名、大小和下载超时校验。
  - [x] 支持当前/历史暂存附件和网络搜索图片；QQ/群聊/引用图片以网关成功入队为前提。
- [x] **P2：实现搜索服务与 Agent 工具**
  - [x] 在搜索工具层定义百度请求和统一结果结构。
  - [x] 实现百度千帆相似图调用。
  - [x] 注册 `search_similar_images`，并保持群成员默认不可用。
  - [x] 增加 401、429、5xx、超时、空结果和图片不合法处理。
- [x] **P3：Admin 配置与可观测性**
  - [x] 增加启用状态、API Key、默认数量、超时和用户限流配置。
  - [x] 增加百度固定探针图连通测试接口和 Admin 配置页面。
  - [x] 复用工具轨迹脱敏；不记录图片内容、完整 URL 或密钥。
- [ ] **P4：测试、灰度与文档收口**
  - [ ] 完成 Provider、输入解析、安全校验和 Admin API 单元测试。
  - [ ] 完成 Agent 工具调用和多渠道手测。
  - [ ] 使用测试 Key 完成一次真实百度 API 验证，确认额度和返回字段。
  - [ ] 默认关闭功能进行灰度，验证稳定后更新本 PRD 状态和 Changelog。

## 1. 背景与目标

当前咕咕已经能够接收用户图片，也能够从网络图片搜索结果中读取或发送图片，但还不能根据图片寻找互联网中的相似图片。用户希望直接对咕咕说“找相似图”“找同款”“这张图还有哪些类似图片”，由 Agent 调用搜索服务并整理结果。

本 PRD 的目标是：

1. 增加 `search_similar_images` Agent 工具。
2. 支持用户上传图片、引用图片、历史暂存附件和网络搜索图片作为输入。
3. 通过 Provider 抽象接入百度千帆相似图搜索 API。
4. 在 Admin 页面配置和启停百度服务，不把 API Key 暴露给前端或模型。
5. 将第三方结果归一化后交给咕咕总结，并保留来源链接供用户查看。

本期不实现用户私有图库的建库、向量索引、相册内相似检索，也不自动下载或保存第三方图片。

### P0 调查结论

1. **Admin 配置复用现有搜索配置链路**：`SearchSettings` 位于 `backend/app/core/config.py`，配置通过 `save_override()` 写入现有 override 配置文件；`/api/v1/admin/config` 路由已由应用层 `require_admin` 保护。`backend/app/api/v1/config.py` 的 `_mask()` 会对字段名包含 `key`、`secret`、`password` 的字段返回 `****`，因此百度 Key 可沿用该机制，不新增一套密钥回显逻辑。
2. **首期权限边界**：Web 和私聊的会话所有者可以调用；QQ/IM 群成员和未确认身份默认不能调用。群聊是否开放由 Bot 的 `group_allowed_tools` 显式控制，后续新增 `search_similar_images` 白名单项后才允许成员调用。这样不会因为一次图片消息为群主产生不可控的第三方费用。
3. **限额归属**：调用量按 Agent 请求所属用户统计，不能按图片 URL 或群成员统计。百度服务额度属于全局 API Key，Admin 负责配置和费用控制；应用侧另行执行用户/群聊限流。现有 `default_search_limit_daily` 仅代表通用联网搜索额度，不能直接假设覆盖相似图搜索，实施阶段应增加独立的相似图日限额或明确复用规则。
4. **费用责任**：启用百度 Key 和相似图工具开关视为 Admin 明确授权外部调用；默认关闭。真实 API 验证必须使用专用测试 Key 或确认本次测试会消耗百度额度。

### P0 现状映射

| P0 结论 | 当前代码依据 | 实施影响 |
|---|---|---|
| 密钥配置 | `SearchSettings`、`save_override()`、`config.py::_mask()` | Provider 从后端配置读取，Admin 只显示掩码 |
| Admin 权限 | `main.py::require_admin`、Admin 配置路由依赖 | 不新增特权体系 |
| 群聊工具权限 | `UserBot.group_allowed_tools`、`normalize_group_allowed_tools()` | 新工具默认不加入群成员白名单 |
| 用户限额 | `QuotaSettings.default_search_limit_daily`、用户 `search_limit_daily` | 实施 P3 时明确独立限额，避免和文本搜索混用 |

## 2. 功能需求

### FR-SEARCH-2-1：相似图搜索工具（🔲 待评估）

Agent 新增工具 `search_similar_images`。工具只接受图片引用和搜索参数，不接受 API Key。

建议输入：

```json
{
  "attach_id": "可选，用户上传或历史暂存图片附件",
  "image_url": "可选，经过安全校验的网络图片地址",
  "count": 10
}
```

约束：

- `attach_id` 与 `image_url` 至少提供一个，二者同时提供时优先使用 `attach_id`；
- `count` 默认使用 Admin 配置，范围为 1～50；
- 工具必须由 Agent 根据用户意图调用，不因普通图片上传自动触发；
- 工具结果只提供搜索结果，不代表结果中的事实已经被咕咕验证；
- 结果中的外部 URL 视为不可信数据，不能直接作为后续工具参数执行。

### FR-SEARCH-2-2：用户图片输入（🔲 待评估）

统一图片解析器支持以下来源：

| 来源 | 解析方式 | 首期要求 |
|---|---|---|
| 网页上传 | 当前消息附件 → `attach_id` → 读取暂存字节 | 支持 |
| QQ/群聊图片 | 网关入站图片 → 暂存附件 → `attach_id` | 网关成功解析时支持 |
| 引用图片 | 引用附件与普通附件统一入队 | 支持；解析失败时明确提示 |
| 历史图片 | `list_recent_attachments` 获取 `attach_id` | 支持 |
| 网络搜索图片 | `image_search` 返回 `img_src` → 安全下载 | 支持 |

百度接口需要图片内容而不是只读 URL，因此所有输入最终都必须转换为后端内存中的图片字节，再编码为 Base64。原图不写入普通日志。

### FR-SEARCH-2-3：图片校验与转换（🔲 待评估）

- 支持 `jpg`、`jpeg`、`png`；
- 请求前校验 MIME、扩展名和实际文件内容；
- 原图超过百度单图限制时，优先在后端压缩或缩放，无法处理时返回可理解的错误；
- 网络图片下载必须设置连接、读取、总大小和总耗时限制；
- 不允许自动跟随未经 URL 安全校验的重定向；
- 下载失败、格式不支持、图片为空、超限等情况分别返回稳定错误码。

### FR-SEARCH-2-4：百度 Provider（🔲 待评估）

第一 Provider 调用：

```text
POST https://qianfan.baidubce.com/v2/tools/image_similar_info
Authorization: Bearer <API Key>
Content-Type: application/json
```

请求体至少包含：

```json
{
  "image": "Base64 图片内容",
  "count": 10
}
```

可选发送 `X-Appbuilder-Request-Id`，用于请求追踪，但不得把图片内容或 API Key 写入日志。

Provider 将百度响应归一化为：

```json
{
  "provider": "baidu_qianfan",
  "request_id": "脱敏后的请求标识",
  "results": [
    {
      "title": "结果标题",
      "site_name": "来源网站",
      "source_url": "来源页",
      "image_url": "图片地址",
      "detail_url": "详情页",
      "similarity": 0.0,
      "width": 0,
      "height": 0
    }
  ]
}
```

Provider 不向 Agent 暴露百度原始字段差异；后续增加其他服务时复用同一工具契约。

### FR-SEARCH-2-5：Admin 配置（🔲 待评估）

Admin 增加“相似图搜索”配置区域：

- 启用/禁用百度相似图搜索；
- API Key 输入与保存；
- 默认结果数量；
- 单次请求超时；
- 用户级调用频率限制；
- “测试连接”按钮；
- 最近测试时间、服务状态和错误分类。

安全要求：

- API Key 只在后端保存和读取；
- 前端只显示掩码，不回显完整密钥；
- API Key 不写入 URL、日志、Trace、异常消息或 Agent 上下文；
- 未配置或已禁用时，工具返回“功能未配置”，不发起外部请求。

### FR-SEARCH-2-6：咕咕回复与展示（🔲 待评估）

Agent 应将搜索结果整理成适合当前渠道的回复：

- 网页端优先展示标题、缩略图、来源和详情链接；
- QQ/群聊按渠道能力发送文字和必要的图片链接；
- 没有结果时明确说明“没有找到相似结果”；
- 不把相似度当成确定性判断，不声称“这就是同一张图”；
- 结果数量较多时只展示前若干项，并保留可追问入口。

## 3. 技术方案

### 3.1 分层

```text
Agent tool: search_similar_images
        ↓
SimilarImageSearchService
        ↓
ImageInputResolver + ImageNormalizer
        ↓
SimilarImageProvider
        ↓
BaiduQianfanSimilarImageProvider
```

`ImageInputResolver` 复用 `app.core.chat_attach` 的附件归属校验、暂存读取和视觉图片转换能力；网络 URL 复用现有外部请求安全校验，不在各 Provider 内重复实现下载逻辑。

### 3.2 配置与密钥

优先复用现有 Agent/Admin provider 配置的密钥存储能力。若现有配置模型无法表达独立的搜索服务，则增加专用配置项，并保持数据库/API 响应脱敏。

建议配置结构：

```json
{
  "enabled": false,
  "provider": "baidu_qianfan",
  "api_key": "<secret>",
  "default_count": 10,
  "timeout_seconds": 20,
  "rate_limit_per_user": 10
}
```

### 3.3 错误与日志

错误统一为：`not_configured`、`invalid_image`、`image_too_large`、`download_failed`、`upstream_timeout`、`upstream_rate_limited`、`upstream_error`、`no_results`。

可见错误经过现有脱敏逻辑；诊断日志只记录 Provider、错误分类、耗时、结果数量和请求指纹，不记录用户输入、图片内容、完整 URL、API Key 或第三方响应原文。

### 3.4 配额

百度接口存在免费调用额度和按量计费规则。服务端必须在调用前执行用户级限流，调用失败时区分超额、鉴权失败和上游暂时不可用，不能无限重试。

## 4. 验证与上线

### 4.1 自动化测试

- `attach_id` 归属校验和图片字节读取；
- `image_url` 的 URL 安全校验、重定向、超时和大小限制；
- jpg/png 格式识别和压缩；
- 百度请求头、Base64 请求体和 `count` 范围；
- 百度响应字段归一化及空结果处理；
- API Key 不出现在日志、响应和异常文本；
- 未配置、上游 401、429、5xx、超时的稳定错误；
- Admin 配置保存、掩码返回和权限校验；
- Agent 工具从用户图片、历史附件和网络图片调用成功。

### 4.2 手测矩阵

| 场景 | 验收点 |
|---|---|
| 网页上传图片 | 咕咕能对当前图片执行相似图搜索 |
| QQ 私聊图片 | 图片成功入队时能搜索；入队失败时明确提示，不静默当文字 |
| QQ 引用图片 | 引用图片和引用文字都能被正确识别 |
| 网络搜索图片 | 从 `image_search` 结果选择图片后能再次搜索相似图 |
| 未配置 API Key | 不发起百度请求，给出配置提示 |
| 超大/错误格式图片 | 不触发上游请求，返回格式或大小错误 |
| 结果展示 | 网页、QQ、群聊均不泄露 API Key，并能查看来源链接 |

### 4.3 上线与回滚

先默认关闭功能，在 Admin 配置 API Key 后对指定用户灰度。出现上游费用、错误率或隐私风险时关闭功能开关即可回滚，不影响现有图片分析和图片搜索工具。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 百度免费额度有限 | 高频调用可能产生费用或被限流 | 用户限流、默认关闭、记录调用量和错误分类 |
| QQ/群聊引用图片未成功入队 | Agent 没有图片字节，无法搜索 | 网关先保证引用附件统一暂存；失败时明确提示重新发送图片 |
| 第三方图片 URL 不稳定 | 下载失败或返回 HTML | 校验 Content-Type、文件签名和大小，失败后提示换图 |
| 搜索结果含恶意或不适宜链接 | 用户点击后存在安全风险 | 只展示来源，不自动访问；沿用 URL 安全策略和渠道展示约束 |
| 相似度被误解为身份确认 | 产生错误结论 | Agent 工具描述和回复模板明确使用“相似结果”措辞 |
| 百度接口字段变化 | 结果解析失败 | Provider 单独做 schema 校验和兼容测试 |

待确认：

- 🔲 是否允许群成员调用相似图搜索，还是仅允许会话所有者调用；
- 🔲 是否需要为结果增加内容安全筛选；
- 🔲 Admin 是否沿用现有 Agent provider 密钥配置，还是建立独立的搜索服务配置页；
- 🔲 是否需要记录每个用户的调用量统计页面。
