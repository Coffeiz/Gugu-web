# N2 Embedding 端点连通诊断

## 范围与真实调用链

补齐 `POST /api/v1/admin/config/test-embedding`。实际调用方为 `apps/web/src/views/Admin/Agent/memory/components/MemoryRecallPanel.vue` 的向量模型测试流程。生产链路为 `main → createEmbeddingFileProbe → modules/admin/embedding-probe → Core preferences/embedding-probe → NodeProviderTransport → 目标端点`；管理员认证由已有 Host hook 建立。组合根和包导出由主会话增量接入。

Core 包含配置回退、百炼普通/多模态载荷、维度和结果规则；Host 负责请求 DTO、只读动态配置、认证及真实传输生命周期。没有复用计划删除的旧 domains 原型，没有迁移整个 RAG 或向量客户端。无队列、数据库写入、索引重建或 Provider 付费调用。

## Python 基线与 TDD

基线为 `backend/app/api/v1/config.py:test_embedding`、`EmbeddingTestRequest`、`backend/agent/memory/embedding.py:resolve_base_url/build_payload` 及 `app/core/config.py:normalize_dimensions`。现有 pytest `tests/agent/providers/test_byok_embedding.py` 作为相关回归，新建独立 fixture 直接调用原 handler。

1. 先编写真实临时 HTTP、临时配置和 Host 路由测试，在 devserver 执行 `node --import tsx --test tests/admin/search/probe.test.ts`：退出 1，`ERR_MODULE_NOT_FOUND` 指向尚未实现的目标 route。此时没有 Core/Host 实现。
2. 实现后，首次运行被共享 Core 构建失败后的缺失 dist 阻断；没有把该失败当作业务红灯，也没有手写 dist、修改其他会话的阻塞文件。
3. 主会话确认共享阻塞修复及无并发 build 后，本次相关源码和测试 5 项 SHA-256 完全一致；串行 Core build 退出 0。
4. Node 两文件共 3/3 通过，覆盖生产 `startServer`、认证优先、真实 DNS 固定 HTTP 传输、HTTP 重定向不跟随、云提供方本地目标拒绝、非 200 脱敏、空/错误响应、空 Key 无 Authorization、配置回退/热更新及文件不变。
5. Node 测试同时通过临时配置启动实际 Python handler，针对相同输入访问同一合成 HTTP 服务，逐字段比较结果。百炼 payload 与维度的独立测试在首次红灯后补充，未声称逐条完整 TDD。

全部测试与构建在 devserver 执行，Python 串行：

```sh
corepack pnpm --filter @gugu/core build
# apps/web-host；测试环境变量由会话提供，不记录实际连接地址
node --import tsx --test tests/admin/search/probe.test.ts tests/host/main/admin/embedding.integration.test.ts
# backend；使用任务临时 Python 环境，PYTHONPATH=.
pytest ../apps/web-host/tests/admin/fixtures/embedding_probe_baseline_python.py tests/agent/providers/test_byok_embedding.py -q
```

Host `typecheck` 退出 2；本次文件无类型错误，未修改其他会话文件。阻塞为尚在整理的 `@gugu/core/filesync-run-read` 未解析及其测试参数隐式 any，以及现有 Core context/Anthropic 的 ES2023 `findLast`/`findLastIndex` lib 错误。

Python 20/20 通过，包含新的原 handler 百炼普通/多模态 endpoint、payload、维度转换基线 1 项和已有 BYOK Embedding 回归 19 项。未修改 Python 参考后端或放宽既有断言。

## 配置与安全差异

动态读取顺序为默认值、`EMBEDDING` JSON、大小写不敏感嵌套环境变量、配置文件 `embedding` 段；每次请求重新读取配置，诊断不修改任何字段。损坏 JSON 或非法配置明确返回脱敏 503，不回写空对象。请求中空 provider/base_url/key/model 及零维度按 Python 回退到有效配置；多模态仅取请求值，不自动继承配置布尔值。

主动安全收紧：复用既有 `NodeProviderTransport`，固定 DNS 目标、不跟随重定向；仅显式 `local`/`ollama` 提供方允许本地目标，普通云提供方即使填写内网 URL 也被拒绝。Python 原 handler 允许管理员任意端点。原 handler 的异常和非 200 原始正文可能包含凭据；Node 返回固定诊断说明和 HTTP 状态，不回显正文、端点或密钥。响应体上限 1 MiB，超限视为协议错误。

没有访问真实运行配置、真实凭据或真实用户数据。合成 HTTP 测试和真实 Python 对照仅使用临时目录。未验收真实云 Provider、真实代理/CA/TLS、部署或大规模向量结果。本切片无业务数据库访问，PG 仅用于生产 Host 的既有基础设施初始化；不能据此声称 RAG、双库向量客户端或 Worker 完成。

## 保护与工具边界

仅新增本切片文件；未重构其他会话的配置/registry，也未修改共享清单、app/main、包导出。主会话负责对应接线。未提交、推送、fetch 或触发 CI。

ripwire `edit-check=probeEmbedding` 返回 `no-baseline`（当前新目标目录在 HEAD 无基线）；`quality-delta` 因缺少基线退出 1，未作为质量通过证据。对应局部 `git diff --check` 通过。
