# PRD-ARCH-4：TypeScript Data Runtime 统一数据读取层

> 状态：Phase 0～6 已完成；Phase 5 的统一接入入口已完成，线上认证与 Agent 编排仍由 Python/FastAPI 负责（以文末唯一 TODO 为准）
> 创建：2026-08-28
> 最近更新：2026-08-28
> 关联模块：`backend/ts/packages/data-runtime/`、`backend/agent/rag/`、`backend/app/db/`
> 背景参考：`PRD-ARCH-1-TypeScript后端迁移.md`、`PRD-RAG-6-TypeScript词法检索与评分过滤直接替换.md`

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：边界与数据契约 | ✅ 已完成 | 确定 Data Runtime 只负责认证上下文之后的授权读取、标准化和生命周期，不负责登录、Agent 编排或写入。 |
| Phase 1：只读运行时第一版 | ✅ 已完成 | 新增 `@gugu/data-runtime`，支持 owner scope 校验、项目、文件元数据、对话消息读取和统一分页结果。 |
| Phase 2：连接池与错误生命周期 | ✅ 已完成 | 已统一查询错误、关闭幂等、关闭后拒绝读取和非法游标处理；连接池创建/关闭入口已具备。 |
| Phase 3：revision、缓存与失效 | ✅ 已完成 | 已支持 30 分钟 TTL、revision、来源分页缓存和 Python 业务事件驱动的 owner/scope/source 精确失效；真实账号 A/B 已完成。 |
| Phase 4：文档与 chunk 读取 | ✅ 已完成 | 已补齐 Knowledge、Canvas、Memory 和 StorageReader 契约，统一 document/chunk DTO、稳定 chunk key、文本 digest 和增量 upsert/delete。 |
| Phase 5：生产接入与迁移收口 | ✅ 已完成 | 已提供带 revision/TTL 的统一 batch 入口、逐来源缓存状态和回滚边界；Python 仍是认证与 Agent 编排 owner。 |
| Phase 6：基础验证与接入契约 | ✅ 已完成 | 完成 chunk/digest、TTL/revision、错误边界、来源适配器和 RAG batch 接入契约测试。 |

## 1. 背景与目标

当前 Python RAG、项目、文件、对话和其他业务读取逻辑分散在不同 adapter/service 中，容易产生重复的 owner 过滤、分页、文档转换、空结果判断和数据库连接管理。TypeScript RAG 已经承担高频索引和检索工作，但数据读取仍主要由 Python 完成，跨语言转换成本和生命周期边界不清晰。

本 PRD 建立一个可复用的 TypeScript 只读数据层，未来为 RAG、Memory、Knowledge、文件、项目、对话和后台查询提供统一读取能力。

本 PRD 不把 TypeScript 改造成 FastAPI，不负责用户登录、JWT 解析、Agent prompt、工具执行、写入接口或绕过 Python 业务权限。

## 2. 功能需求

### FR-DR-1：认证上下文与 owner/scope 授权

Data Runtime 必须接收调用方构造的 `DataAccessContext`，至少包含 `ownerId`。当前第一版只允许 `owner` scope，且 scope 身份必须与 `ownerId` 一致；空身份、跨用户 scope 和未实现的 group/project/folder scope 必须 fail-closed。

认证仍由 Python/FastAPI 入口完成。Data Runtime 不信任模型、工具参数或客户端直接传入的 owner 字段。

### FR-DR-2：统一只读来源接口

运行时通过统一入口读取 `project`、`file`、`conversation`、`knowledge` 和 `canvas` 来源，并返回稳定的 `RagSourceRecord` 兼容结构。Memory 与文件正文只能通过显式 `StorageReader` 读取，不暴露内部存储路径。

### FR-DR-3：分页与稳定游标

读取接口支持 `limit` 和 `afterId`，限制单次读取上限，使用稳定递增 ID 返回 `nextAfterId`，避免一次性加载全部数据。

### FR-DR-4：连接池生命周期

统一创建 PostgreSQL client/pool，明确连接超时、空闲回收、查询失败后的释放和应用关闭时 drain。Data Runtime 查询统一经过错误边界；关闭后拒绝新读取，任何请求都不得创建无法关闭的连接，也不得把连接对象泄漏给业务层。

### FR-DR-5：revision 与 30 分钟缓存

缓存键至少包含 `owner + scope + source + page`。当前已实现 revision 校验和最长 30 分钟 TTL；业务 revision 事件、权限变化失效和跨进程共享策略已经接入，不能跨 owner 或 scope 复用。

### FR-DR-6：文档与 chunk 标准化

Data Runtime 输出统一的 document/chunk DTO。chunk 使用稳定的 `source:parent:chunkIndex` 标识和 digest；来源没有变化时不重复序列化和传输，变化时只返回增量 upsert/delete。

### FR-DR-7：空结果与错误状态

区分“合法查询但没有记录”“权限拒绝”“来源暂时不可用”“数据库错误”和“游标无效”。空结果返回空数组和明确分页状态，不使用异常模拟空结果；错误结构不得包含凭据、SQL、内部路径或用户正文。

### FR-DR-8：生产调用与迁移

Python 保留 FastAPI 认证和 Agent 编排，只把认证后的上下文交给 Data Runtime。迁移完成前保留单一明确 owner，禁止 TS 与 Python 同时读取并各自拼装同一来源。

## 3. 技术方案

### 3.1 目录与职责

```text
backend/ts/packages/data-runtime/
├── src/contracts.ts   # DataAccessContext、scope、分页和来源 DTO
├── src/postgres.ts    # PostgreSQL client 创建与关闭
├── src/runtime.ts     # DataRuntime 读取门面
└── test/              # 契约与边界测试
```

`DataRuntime` 是读取门面；具体来源读取器应在来源复杂到需要独立查询、缓存或转换时再拆分，避免重新出现“每张表一个重复门面”。

### 3.2 调用链

```text
Python/FastAPI 认证
    ↓ DataAccessContext
TS Data Runtime
    ├─ owner/scope 校验
    ├─ revision/cache
    ├─ PostgreSQL / storage reader
    ├─ document/chunk 标准化
    └─ 空结果 / 错误 DTO
    ↓
TS RAG 或 Python Agent 编排
```

数据库读取可以迁移到 TS，但身份认证、业务写入和对外 API 权限仍由 Python 负责。Memory/文件正文由调用方注入 `StorageReader`，不能让 Data Runtime 直接拼接本机路径。

### 3.3 安全与可观测性

- 所有查询必须带 owner/scope 条件，不能先全库读取后在上层过滤。
- 日志只记录 source、scope 类型、数量和耗时；不记录正文、文件名、凭据或完整查询参数。
- 诊断需要记录 `document_load_ms`、`index_lookup_ms`、`cache_hit`、`revision` 和错误类型，但不得记录原始 SQL 或用户数据。
- PostgreSQL client 关闭、超时和异常回收必须可测试；进程退出时执行统一 drain。

## 4. 验证与上线

### Phase 0～6：已完成

- 本地 `backend/ts` typecheck 通过。
- Data Runtime 契约测试通过，覆盖 owner 成功、空 owner 拒绝和跨 scope 拒绝。
- devserver Node 22 环境下 TS typecheck 通过。
- devserver TS 测试 24 项全部通过。
- Data Runtime chunk/digest、增量 patch、TTL/revision、Knowledge/Canvas/Memory/StorageReader 和 RAG batch 适配测试通过。
- 本地 TS 测试总数增至 31 项，全部通过。
- devserver Node 22 下 TS 类型检查和 31 项测试全部通过；修正 benchmark 后，真实账号 A/B 的 Python 来源读取中位数为 1,173.49ms，TS 常驻 sidecar 构建/索引按来源中位数为 1.82～337.93ms。
- 修正后的统计按“Python 已分块结果还原为父文档 → TS 单次构建分块”比较：文件为 Python 385 chunk、TS 385 chunk；对话为 Python 2,508 chunk、TS 2,508 chunk；其余来源 chunk 数量也全部一致。此前的差异来自 benchmark 将 Python canonical 文本再次交给来源专用 adapter，造成重复拼装和二次分块，已修正。
- 当前 TypeScript 测试为 34 项全部通过；新增来源读取、显式 StorageReader、带 revision 的批量缓存入口均有回归覆盖。

### 后续验证要求

- 使用真实 devserver 数据验证项目、文件元数据和对话读取数量、游标连续性及 owner 隔离。
- 对同一 revision 连续读取验证缓存命中和 30 分钟 TTL；修改一个 source 后验证只失效对应 source。
- 注入数据库断连、超时、空结果和非法 scope，确认错误分类及连接回收。
- 生产调用统一使用 `loadRagBatchCached()`；在尚未建立独立 TS 进程入口前，Python 继续负责认证和 Agent 编排，不能并行启动第二套业务 loader。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| TS 与 Python 使用不同的 owner 上下文 | 跨用户读取或结果不一致 | Python 只传认证后的上下文；TS fail-closed，并补跨用户测试 |
| revision 过粗 | 一个来源变化导致全量重建 | Phase 4 改为 source/chunk 级 revision 和增量 patch |
| 缓存未失效 | 读取过期或已删除数据 | TTL + revision 双重校验，删除和权限变化主动失效 |
| 文件正文读取越过存储权限 | 泄露内部路径或文件内容 | 通过独立 StorageReader，统一 ownership 和审计 |
| Python 与 TS 双重 loader 并存 | 重复数据库压力和行为分叉 | 当前只保留 Python/FastAPI 认证编排 owner；TS Data Runtime 作为统一读取实现和显式接入入口 |

## 6. 唯一实施 TODO

以下是本 PRD 唯一的可执行进度清单。顶部“实施状态”只作摘要，功能需求只作契约定义，不再维护第二套勾选状态。

- [x] Phase 2：补齐 PostgreSQL pool、查询超时、关闭 drain、异常回收和统一错误 DTO。
- [x] Phase 2：为真实项目、文件、对话读取增加 owner 隔离、分页游标和空结果测试。
- [x] Phase 3：实现 `owner + scope + source + page` 缓存，加入 30 分钟 TTL 和 revision 校验。
- [x] Phase 3：接入 Python 业务 revision 事件，按 owner/scope/source 精确失效，支持删除、权限变化操作类型和跨进程事件协议诊断。
- [x] Phase 4：实现 document/chunk DTO、稳定 chunk key、digest 比较和增量 upsert/delete。
- [x] Phase 4：补齐 Knowledge、Memory、Canvas、StorageReader 适配器，保持权限和字段语义一致。
- [x] Phase 5：用真实 devserver 数据完成 Python loader 与 TS Data Runtime 的 A/B 结果和性能对比。
- [x] Phase 5：提供统一 `loadRagBatchCached()` 生产入口、逐来源缓存状态和明确回滚边界；Python 保留认证与编排 owner。
- [x] Phase 5：完成来源读取回归、监控字段和文档收口。
