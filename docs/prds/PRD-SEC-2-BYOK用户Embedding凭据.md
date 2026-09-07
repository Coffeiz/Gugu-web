# BYOK 用户 Embedding 凭据

> 状态：🚧 Phase 1～3 已完成（解析基建 + run 入口绑定 + Admin 重建逐用户化 + 测试连接与前端卡片），Phase 4 手工验收待生产/devserver 实测
> 创建：2026-09-08
> 最近更新：2026-09-08
> 关联模块：`backend/agent/memory/embedding.py`、`backend/app/byok/service.py`、`backend/app/byok/schemas.py`、`backend/app/api/v1/byok.py`、`backend/agent/llm/llm_select.py`、`backend/app/api/v1/config.py`、`frontend/src/components/common/profile/ProfileByokPane.vue`
> 背景参考：[`【已完成】PRD-SEC-1-用户BYOK凭据与模型路由.md`](./【已完成】PRD-SEC-1-用户BYOK凭据与模型路由.md)、`backend/agent/llm/modelctx.py`（run 级模型绑定先例）

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| BYOK 凭据管理（llm / deep_research / similar_image_search / speech_to_text） | ✅ 已完成 | 凭据加密落库、测试连接、Profile 卡片齐备（SEC-1） |
| 聊天/语音/深度研究走用户凭据 | ✅ 已完成 | run 级解析绑定，用量标记 `is_byok` 随 run 落库 |
| Embedding 走用户凭据 | 🚧 进行中 | 解析基建 + 全部用户链路绑定 + Admin 重建逐用户化 + 测试连接（/embeddings 试呼）+ 前端 Embedding 卡片（三语言）已完成；手工验收待实测 | `embed()`/`model_tag()` 只读平台 `settings.embedding`，BYOK 用户的记忆检索与 RAG 向量化仍消耗平台 key；平台未配 embedding 时 BYOK 用户无法使用向量检索 |
| BYOK 用量记账（embedding） | 🔲 待评估 | embedding 调用目前不进 usage 表，无记账载体，本 PRD 不做 |

## 1. 背景与目标

Embedding 是与聊天解耦、单独 pin 的共享基建（`backend/agent/memory/embedding.py`），服务于记忆 pattern 向量化、memory 压缩向量、RAG 混合检索和知识库向量缓存。它当前只读平台配置 `settings.embedding`：

- BYOK 用户聊天走自己的 key，但记忆/RAG 向量化仍烧平台的 embedding 配额。
- 平台没配 embedding 时，BYOK 用户即使自己有 dashscope/openai key 也用不上向量检索，只能退回词法相关性（bigram）。
- `embed()` / `embed_multimodal()` / `is_enabled()` / `model_tag()` 的函数签名没有 `db` / `user_id`，7 个调用点（memory store ×3、rag/service、rag/knowledge 两个 vector_cache、knowledge adapter）全部是无用户上下文的存储层代码。

目标：把 embedding 作为与 `llm`、`speech_to_text` 完全同构的 BYOK 能力接入——用户在 Profile BYOK 面板配置一整套自己的 embedding 配置（provider、base_url、model、dimensions、api_key），生效时记忆/RAG 向量化整体走用户配置，解析回退语义与其他能力一致。

明确不做：

- **百炼 multimodal embedding 不做 BYOK**：专用 endpoint + `enable_fusion` 特例，保持平台专用。
- **embedding 用量记账不做**：embedding 调用目前没有 usage 表载体，不混入本 PRD。
- **平台 `settings.embedding` 配置语义不变**：Admin 配置页、`enabled` 开关、词法回退行为照旧。

## 2. 功能需求

### FR-SEC2-1：Embedding 凭据 CRUD

- BYOK 凭据的 capability 枚举新增 `"embedding"`，与现有四种能力走同一套创建/编辑/启停/删除接口与加密存储。
- 字段：`provider`、`base_url`、`model`、`dimensions`（整数，`0`/空=用模型默认维度）、`api_key`。`api_format` 列保留存储但不参与 embedding 解析（只支持 OpenAI 兼容 `/embeddings`）。
- 同 capability 只保留一条启用凭据（与其他能力一致：新建启用凭据时旧凭据自动停用）。

### FR-SEC2-2：凭据生效语义

- 用户存在启用中的 embedding 凭据时，生效配置 = 用户凭据逐字段覆盖平台配置，回退语义与其他能力一致：`base_url`/`model` 用户留空时回落平台对应字段，`api_key`/`provider`/`dimensions` 以用户为准（`dimensions` 用户值为 `0` 表示明确使用其模型默认维度，不继承平台值）。
- 生效配置完整（`model` 与 `base_url` 均非空）即视为向量检索可用，**不受平台 `embedding.enabled` 开关限制**（BYOK key 不产生平台成本）；平台总闸 `byok.enabled` 关闭时全站照旧走平台配置。
- 无凭据或凭据解析不完整时回落平台配置，平台配置不完整则维持现状（`embed()` 返回 None，退回词法）。
- 混搭保护：不允许出现"用户的 api_key + 平台的 model"以外的隐式混配之外的新组合——逐字段回退结果在请求前整体可见，凭据生效时用户面板能看到实际生效的 provider/model。

### FR-SEC2-3：用户链路 embed 走用户凭据

- 所有用户链路（主对话 run、Web/IM 网关 run、定时任务执行、反思、IM 反思、问候语、记忆压缩与向量同步）内的 `embed()` 调用自动使用该用户的 embedding 凭据，无需调用方传参。
- 非用户链路（平台后台任务、无凭据用户）维持平台配置行为。
- 绑定入口与 LLM BYOK 一致（`resolve_run_config_for_user` 的全部调用点），解析失败不影响 run：凭据解密失败按"无凭据"回落平台并记日志（脱敏）。

### FR-SEC2-4：向量缓存与 model_tag 隔离

- `model_tag()` 跟随生效配置计算（`provider:model:dimensions`），用户凭据生效时 tag 用用户的 provider/model/dimensions。
- 向量缓存已按 user 隔离；用户切换凭据（含换模型/换维度/清空凭据回平台）后 tag 失配，向量在下次增量同步时自动重建，不需要迁移脚本。
- 同一用户在"平台配置与用户凭据解析结果相同"时 tag 相同，已有向量继续复用。

### FR-SEC2-5：测试连接

- BYOK 测试连接（`POST /byok/{id}/test` 与 `test-preview`）支持 embedding：向 `{base_url}/embeddings` 发送最小请求（短文本），HTTP 200 且返回向量即通过；失败返回脱敏错误信息。
- 不支持/不配置 multimodal 百炼端点的探测。

### FR-SEC2-6：前端 BYOK 卡片

- Profile BYOK 面板新增 Embedding 能力卡片，与其他能力卡片同构：provider 选择、base_url、model、dimensions（可选数字）、api_key；不显示 vision/思考/上下文预算等 LLM 专属字段。
- i18n 三语言（zh/en/日）同步补齐，通过 `npm run i18n:scan` 门禁。

### FR-SEC2-7：Admin 重建走各自用户凭据

- Admin「重建向量」（`POST /config/embedding-rebuild`）逐用户绑定该用户的生效配置：有凭据的用户用自己的 key 重建，无凭据用户用平台配置。
- 重建入口前置检查"向量检索可用"改为按用户判定（平台未配但存在 BYOK 用户的场景不再被整单拒绝）。

## 3. 技术方案

复用 SEC-1 已验证的 **run 级 ContextVar 绑定**模式（`modelctx.py` 先例）：`embed()` 保持无用户上下文的共享基建形态，run 开始时解析一次用户 embedding 配置并绑定到 ContextVar，`embed()`/`is_enabled()`/`model_tag()`/`embed_multimodal()` 优先读绑定值，无绑定时回落平台配置。不采用给 7 个调用点穿 `(db, user_id)` 参数的方案（中间层全是无 db 的存储层代码，侵入大且每次 embed 多一次凭据查询）。

```
backend/
├── alembic/versions/
│   └── <顺延编号>_add_credential_dimensions.py        【新增】 user_provider_credentials 加 nullable dimensions 列
├── app/
│   ├── byok/
│   │   ├── schemas.py                                 【修改】 capability Literal 加 "embedding"；创建/编辑 schema 加 dimensions
│   │   └── service.py                                 【新增】 resolve_embedding_settings(db, user_id, base)；
│   │                                                           bind_user_embedding()/reset 上下文管理器
│   ├── models/__init__.py                             【修改】 UserProviderCredential 加 dimensions 列
│   └── api/v1/
│       ├── byok.py                                    【修改】 测试连接分支加 embedding（/embeddings 试呼）
│       └── config.py                                  【修改】 embedding-rebuild 前置检查改按用户判定；重建 worker 逐用户绑定
├── agent/
│   ├── memory/embedding.py                            【修改】 effective_settings() = ContextVar 覆盖 or 平台；
│   │                                                           embed/embed_multimodal/is_enabled/model_tag 改读生效配置
│   ├── memory/periodic.py                             【不改】 压缩链路经反思上下文自动携带绑定
│   ├── llm/llm_select.py                              【不改】
│   ├── runner.py                                      【修改】 run 开始处（两处）绑定用户 embedding
│   ├── gateway/web.py                                 【修改】 两个 run 入口绑定
│   ├── scheduled_execution.py                         【修改】 定时任务入口绑定
│   ├── memory/reflection.py                           【修改】 反思入口绑定
│   ├── memory/im_reflection.py                        【修改】 IM 反思入口绑定
│   ├── greeting.py                                    【修改】 问候语入口绑定
│   └── memory/store.py                                【不改】 rebuild_all_vecs 增加 per-user 配置参数（签名内改，调用方只有 config.py）
└── tests/
    └── test_byok_embedding.py                         【新增】 解析/绑定/回退/tag/并发隔离用例

frontend/src/components/common/profile/ProfileByokPane.vue  【修改】 embedding 卡片字段组
frontend/src/i18n/sections/common.ts                        【修改】 profileByokUi 三语言 key
```

关键边界：

- `resolve_embedding_settings` 只覆盖 `api_key / provider / base_url / model / dimensions` 五个字段，不使用通用 `resolve_capability_settings`（其会无条件注入 vision 等 LLM 字段）。
- 解密失败或凭据不完整按"无凭据"处理并记脱敏日志，**不打 modelctx 式兜底哨兵**——"未绑定回落平台"在 embedding 语境是合法状态（无凭据用户），哨兵只会制造噪音。
- `dimensions` 语义：用户值 > 0 时请求带 `dimensions`；`0`/None 时不带（用模型默认），与平台 `dimensions=0` 行为一致。
- 百炼多模态分支（`embed_multimodal` 的 bailian 专用端点）只读平台配置，不做用户覆盖。
- 凭据内容不写日志；错误信息经 `redact()`。

## 4. 验证与上线

- 后端：`.venv/bin/python -m pytest tests/test_byok_embedding.py tests/test_byok*.py -q`；全量 `pytest tests -q`。
- 前端：`npm run i18n:scan`（新增 key 三语言齐备）；`npm run typecheck:strict`。
- 手工验收：平台未配 embedding 的部署下，BYOK 用户配置凭据后记忆检索出现向量召回（`cache_read`/召回日志可见 embedding 命中）；删除凭据后回退词法；换 model 后向量自动重建（`model_tag` 变化）。
- 发布范围：一条加列迁移（向后兼容，可随常规发版）；无独立灰度开关，`byok.enabled` 即功能总闸。
- 回滚：迁移列保留无害；代码回滚后凭据行静默不生效（`capability` 多出的枚举值无消费者）。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| ContextVar 绑定泄漏（run 间串味） | A 用户的向量用 B 用户的 key 生成 | 复用 modelctx 的 `reset()` 纪律；gather 多用户场景在各自 task 内绑定；测试覆盖并发隔离 |
| 用户凭据不完整导致静默退回词法 | 用户以为配好了但检索质量下降 | 测试连接入口拦截明显错误；生效卡片显示实际 provider/model |
| 换凭据触发向量批量重建 | 一次 embed 调用量上涨（用户自己的 key） | 增量同步本来就是按 tag 失配逐条补，无整批风暴；Admin 重建入口供主动全量 |
| BYOK key 出现在错误日志 | 凭据泄漏 | 复用 `normalize_ascii_api_key(label=…)` 与 `redact()`，测试断言日志无 key |

待确认问题：无——dimensions 新列、multimodal 不做 BYOK、用量记账不进本 PRD 均已定案。

## 6. 唯一实施 TODO

### Phase 1：数据模型与解析基础

- [x] `SEC2-001` 迁移 + 模型列：`user_provider_credentials.dimensions` nullable 整数列；验收：迁移上下行通过，现有行不受影响。
- [x] `SEC2-002` schema 与解析器：capability Literal 加 `"embedding"`、创建/编辑 schema 加 dimensions；`resolve_embedding_settings` 按逐字段回退返回生效配置（不完整返回 None）；验收：单测覆盖完整/不完整/无凭据/`dimensions=0` 不继承平台值。
- [x] `SEC2-003` embedding.py 生效配置改造：`effective_settings()` + ContextVar 覆盖 + `bind_user_embedding` 上下文管理器；`embed/embed_multimodal/is_enabled/model_tag` 改读生效配置，multimodal bailian 分支保持平台配置；验收：单测覆盖绑定生效、未绑定回落、tag 跟随。

### Phase 2：用户链路绑定

- [x] `SEC2-004` 七个 run 入口绑定（runner ×2、gateway/web ×2、scheduled_execution、reflection、im_reflection、greeting）：run 开始绑定、结束 reset，解密失败回落平台并记脱敏日志；验收：各有用户凭据/无凭据两种链路测试。
- [x] `SEC2-005` Admin 重建 per-user：`embedding-rebuild` 前置检查与 `rebuild_all_vecs` 改为逐用户解析配置（gather 各 task 内绑定）；验收：平台未配 embedding + 存在 BYOK 用户时可重建且只用用户 key。

### Phase 3：测试连接与前端

- [x] `SEC2-006` 测试连接支持 embedding：`/embeddings` 最小试呼，200 且有向量即通过；验收：单测 mock 上游通过/失败两路，错误信息经 redact。
- [x] `SEC2-007` 前端 Embedding 卡片：provider/base_url/model/dimensions/api_key 字段组、无 LLM 专属字段，i18n 三语言；验收：`npm run i18n:scan` 与 `typecheck:strict` 通过，卡片保存/测试/启停走通。

### Phase 4：验收

- [ ] `SEC2-008` 全量回归 + 手工验收：后端全量 pytest 通过；手工验证 FR-SEC2-2/3/4 三条主路径（凭据生效、回退、换模型重建）；验收记录回填本文档 §0 状态行。
