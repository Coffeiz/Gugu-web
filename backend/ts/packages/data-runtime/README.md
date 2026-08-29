# @gugu/data-runtime

Gugu 的通用只读数据访问层。它负责从 PostgreSQL 读取已授权的业务数据，并
投影为稳定的业务记录或 `RagSourceRecord`；不负责写入、Agent 推理、工具权限
判定或 prompt 组装。

## 使用约定

```ts
import { createPostgresClient, DataRuntime } from "@gugu/data-runtime";

const sql = createPostgresClient(process.env.GUGU_DATABASE_URL ?? "");
const data = new DataRuntime(sql);
const result = await data.loadProjects({ ownerId: userId }, { limit: 100 });
await data.close();
```

所有查询必须提供 `ownerId`。当前版本只接受与 `ownerId` 相同的 owner scope；
未实现的 group/project/folder scope 会 fail-closed。调用方应在进入 Data Runtime
前完成身份确认，不能把客户端传入的 owner 或 scope 当成授权依据。

Memory 和文件正文只能通过调用方提供的 `StorageReader` 接入，不能在业务代码中拼接
本地路径，也不能把数据库连接串或对象存储凭据写入日志。

## RAG 接入

`loadRagBatch()` 可将同一套已授权读取结果转换为 TS RAG 的 `RagSourceBatch`；默认包含
项目、文件元数据、对话、Knowledge 和 Canvas。`loadRagBatchCached()` 是生产批量入口，
按同一 revision 对各来源分别读取和缓存，并返回每个来源的命中状态。
它只负责数据读取和 DTO 转换，不负责 revision 决策、检索排序或 Agent 上下文组装；
生产切换前，Python 入口仍是认证和业务编排的 owner。

分页读取可通过 `loadRagSourcesCached()` 复用同一 `owner + scope + source + page`
的数据。调用方必须提供稳定 `revision`；缓存最长保留 30 分钟，revision 或权限边界
变化时应由业务事件调用 `invalidateCache()`。跨进程事件使用
`DataRuntimeInvalidationBridge` 接收 `data-runtime-invalidation-v1` 事件；Python
业务事件会按 `owner_id + scope_id + resource` 发布，TS 侧只失效对应边界，不能清空
其他用户或来源的缓存。

业务接入方应将 Redis/消息总线适配为 `DataRuntimeEventSubscription`，并在进程关闭时
调用 bridge 的 `detach()`；Data Runtime 不自行创建无法回收的订阅连接。
