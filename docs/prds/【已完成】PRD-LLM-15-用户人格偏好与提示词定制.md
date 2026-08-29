# PRD-LLM-15：用户人格偏好与提示词定制

> 状态：Phase 0–Phase 3 已完成
> 创建：2026-08-29
> 最近更新：2026-08-29
> 关联模块：`backend/app/models/__init__.py`、`backend/app/api/v1/preferences.py`、`backend/app/schemas/__init__.py`、`backend/agent/context/loaders.py`、`backend/agent/context/builder.py`、`backend/agent/runner.py`、`backend/agent/gateway/web.py`、`backend/agent/im/context_loader.py`
> 背景参考：`PRD-LLM-8-Prompt-Caching优化`、`PRD-LLM-11-Canonical Context与Provider Adapter分层重构`

## 0. 实际状态

| 能力 | 结果 | 说明 |
|---|---|---|
| 现有用户回复风格 | ✅ 已完成 | `UserPreferences.data_json` 已承载 `reply_tone` 与 `reply_length`，由 `load_style_prefs()` 统一读取。 |
| 基础人格 Prompt | ✅ 已完成 | `backend/agent/prompts/persona.md` 是共享的基础人格来源，所有 profile 共用。 |
| 统一渠道注入入口 | ✅ 已完成 | Web、QQ、飞书、微信最终进入统一 Agent runner，并通过 `build_split()` 组装上下文。 |
| 用户人格文件 | ✅ 已完成 | 使用用户隐藏目录中的 `.agent/prompt/persona.md`，支持 Markdown 上传和原文编辑保存；不创建普通文件记录。 |
| Phase 0 盘点与回归基线 | ✅ 已完成 | 已完成文件方案、默认回退、长度边界和跨渠道组装回归基线。 |
| Phase 1 后端闭环 | ✅ 已完成 | 已完成文件读写、上传接口、启用状态、snapshot 失效和用户目录隔离。 |
| Phase 2 用户设置界面 | ✅ 已完成 | 已接入 Markdown 上传、编辑保存、启停、恢复默认、字数计数和保存状态。 |

## 1. 背景与目标

允许用户用一份 Markdown 文件定义咕咕的回答风格、称呼和互动偏好，同时保持系统安全规则、工具权限、确认门和上下文预算的权威性不变。

本功能属于“用户偏好层”，不是开放式系统提示词编辑器。用户输入只能影响表达和相处方式，不能授予工具权限、绕过确认、修改安全策略或改变渠道能力。

## 2. 功能需求

### FR-LLM15-1：用户人格偏好

用户可以上传或编辑一份有限长度的 Markdown 人格文件，描述称呼、表达风格和互动习惯；文件不存在表示使用默认人格。

### FR-LLM15-2：启用与恢复默认

用户可以独立启用、停用和恢复默认。停用或总开关关闭时保留已保存内容，但本轮及后续请求不得生效。

### FR-LLM15-3：安全边界

系统安全规则、工具注册与权限、确认门、上下文归属和平台能力始终高于用户偏好。偏好内容不能改变这些事实。

### FR-LLM15-4：统一渠道语义

同一用户在 Web、私聊和群聊中使用同一份偏好语义；渠道差异只影响消息适配，不产生独立人格拼接规则。

### FR-LLM15-5：缓存稳定性

用户偏好作为稳定 snapshot 的一部分注入，字段未变化时保持序列化和注入顺序稳定；偏好变更从下一轮请求生效，不回写历史消息。

## 3. 技术方案

### 3.1 Phase 0 盘点结论

- `reply_tone`、`reply_length` 等普通表达偏好仍由 `user_preferences.data_json` 承载；人格正文不再以该字段作为最终事实源。现有 API 仅作为过渡兼容层，正式文件 API 仍待实现。
- 现有 `reply_tone`、`reply_length` 是受控的表达风格枚举，继续保留；人格偏好使用独立字段，避免把长文本塞入枚举或覆盖已有设置。
- 用户人格不再以 `user_preferences.data_json` 作为最终事实源，也不创建普通 `File` 记录。目标文件为 `<用户数据根>/users/<user-id>/.agent/prompt/persona.md`；`.agent/prompt` 属于内部隐藏目录，不出现在文件库、搜索和 RAG 列表中。
- 用户可通过 `.md` 上传或内置文档编辑器保存人格文件；写入必须经过字符数/控制字符校验、用户目录归属校验和原子替换。文件不存在时回退到 `backend/agent/prompts/persona.md`。
- 当前阶段不执行历史 JSON 到文件的迁移，也不新增迁移脚本；业务服务器升级后，旧 JSON 字段按兼容读取周期再统一清理。
- `personality_preference_enabled` 仍作为用户级启用状态保留在偏好配置中；`revision` 和更新时间应由人格文件元数据或受控索引维护，不把完整人格正文重新写回数据库。
- 默认值为文件不存在、关闭状态；人格文件最大长度为 `10,000` 个 Unicode 字符，服务端和前端均校验。
- 基础人格来自 `agent/prompts/persona.md`；用户文件存在且启用时替代该文件；profile 静态规则来自 `agent/prompts/*.md`，动态项目/记忆上下文仍位于之后。
- `agent/context/builder.py` 是唯一提示词组装边界。`agent/gateway/web.py` 和 `agent/runner.py` 负责调用它；`agent/im/context_loader.py` 负责按 IM 角色筛选上下文，不应复制人格拼接逻辑。
- 现有缓存约束要求稳定内容进入 `static_text`。偏好内容不应写入动态尾部、历史包装或渠道专属 reminder。

### 3.2 上下文层级

```text
系统安全规则
→ Agent 基础人格
→ 用户人格文件（启用时替代默认 persona.md）
→ 会话级临时偏好（如有）
→ 当前消息
```

后台托管版本由总开关和权益服务决定是否允许生效；本地部署默认开启。管理员入口统一位于“Agent 配置 → 权限开放”，与用户 BYOK 权限同一处管理。客户端不能伪造解锁状态，后端必须在写入和读取生效路径同时校验。

## 4. 验证与上线

旧版 Phase 0 通过 `backend/tests/test_llm15_phase0.py` 验证现有风格偏好在 Web、QQ、飞书和微信来源下经过同一组装入口。切换文件事实源后，需要补充文件归属、上传/编辑、默认回退和跨渠道静态前缀测试。

Phase 1 以后应继续验证 API 归属、长度边界、开关恢复、revision 变化、缓存前缀稳定性，以及安全规则和工具权限不受偏好影响。发布时先使用后台总开关灰度，回滚只关闭生效开关，不删除已保存偏好。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 用户把偏好写成系统指令 | 可能诱导模型越权或改变安全行为 | 以用户偏好层注入，并在静态安全规则中明确优先级；工具权限和确认门继续由代码决定。 |
| 长文本破坏 provider cache | 增加 token 成本并降低命中率 | 固定字段顺序、长度上限和 revision；变更时才重建 snapshot。 |
| 渠道自行拼接人格 | 三类渠道行为不一致 | 只允许 `builder.build_split()` 负责人格与偏好组装，增加跨渠道回归测试。 |
| JSON 偏好损坏 | 读取异常导致请求失败 | 沿用 `UserPreferences.data` 的空对象语义，读取失败按未设置处理，并保留诊断日志脱敏边界。 |
| 隐藏人格文件被文件库暴露 | 用户误以为人格属于普通文件，或被 RAG 检索 | 不创建 `File` 记录；文件库、搜索和 RAG 明确排除 `.agent/prompt`。 |

待确认：托管服务的权益判定是否复用现有配置总开关，还是由独立计费服务提供；这不阻塞本地默认开启策略和 Phase 1 的字段/API设计。

## 6. 唯一实施 TODO

### Phase 0：盘点

- [x] `LLM15-000` 盘点现有用户偏好、基础人格 Prompt 和各渠道注入入口；验收：文档记录 `UserPreferences`、`build_split()`、Web/QQ/飞书/微信调用链，并确认无独立渠道人格事实源。
- [x] `LLM15-001` 确定人格偏好的字段、默认值和字符上限；验收：完成旧版数据库字段方案记录。
- [x] `LLM15-003` 将人格正文事实源切换为用户隐藏目录 `.agent/prompt/persona.md`；验收：不产生普通 `File` 记录，不进入文件库、搜索和 RAG。
- [x] `LLM15-002` 增加跨渠道注入顺序回归样例；验收：`backend/tests/test_llm15_phase0.py` 验证四类来源使用相同静态前缀、风格块位置稳定且不进入动态尾部。

### Phase 1：后端

- [x] `LLM15-010` 将旧人格 JSON API 收敛为人格文件 API；验收：上传、编辑、读取、删除和所有权边界均有 API 测试。
- [x] `LLM15-011` 接入后台总开关与统一权益判定；验收：托管关闭时读写生效均被拒绝，本地部署默认开启，已有配置不被删除。
- [x] `LLM15-012` 将人格文件接入 canonical context snapshot；验收：稳定序列化、文件 revision/hash 变化条件和三类渠道输出一致。
- [x] `LLM15-013` 补齐人格上传接口集成测试；验收：`.md` 后缀、UTF-8、大小限制、控制字符、用户隔离和原子写入均有 API 测试。

### Phase 2：前端

- [x] `LLM15-020` 在用户设置页增加人格文件上传、Markdown 原文编辑器、启停和恢复默认；验收：显示剩余字数、保存状态和错误状态。
- [x] `LLM15-021` 接入总开关与权益状态；验收：关闭时入口和交互状态符合策略，客户端不能绕过后端限制。

### Phase 3：验证与清理

- [x] `LLM15-030` 完成 Web、私聊、群聊和缓存边界回归；验收：`backend/tests/test_llm15_phase3.py` 验证偏好不改变工具权限、确认门、历史包装和动态尾缀。
- [x] `LLM15-031` 清理 `data_json` 人格兼容字段、重复渠道级人格拼接逻辑并更新文档；验收：运行链路只剩隐藏文件读取和 `build_split()` 统一组装入口，旧 JSON 辅助函数已删除。
