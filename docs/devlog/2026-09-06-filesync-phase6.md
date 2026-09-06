# 文件同步 Phase 6

## 结果

Phase 6 的统一自动同步已完成基础闭环。worker 监听启用的本地文件同步绑定，外部复制、Shell 写入和文件库目录变化会自动进入文件/文件夹投影，不需要再执行 Admin 对账。

## 方案调整

本阶段完成了从 Python 目录轮询到 TypeScript sidecar 操作系统文件系统事件监听的迁移。针对 1k、10k、50k 文件规模的压力测试显示，大目录空闲轮询会持续消耗 CPU，因此生产路径改用 TS watcher：

- TS watcher 只负责文件/文件夹事件检测、去抖和 watcher 生命周期，不访问 DB、不做权限判断、不发布 UI 事件。
- Python worker 保留 supervisor、路径/ownership/配额校验、稳定读取、`reconcile_local_directory()`、journal/outbox 和 60 秒全量补偿职责。
- 两者通过版本化本地 NDJSON 通道传递绑定控制和候选事件；sidecar 断线、事件溢出或重启时立即触发对应绑定 reconcile。
- Python 轮询实现已从生产路径和相关测试中删除，禁止 TS watcher 与旧轮询或 Shell 专用刷新策略并行。

本机临时目录基准（TypeScript + chokidar，空闲 5 秒）为：1k 文件 CPU 约 0%、10k 约 1.6%、50k 约 10.3%；新文件事件延迟约 87–113ms。该基准仅证明事件检测层，不能替代 DB reconcile、批量写入和 devserver smoke 验证。

## 实施范围

- 当前 `FileSyncWatcherManager` 运行在单实例 worker，由 TS sidecar 监听绑定目录，60 秒执行一次全量补偿；Python 只负责 supervisor、权限复核、reconcile 和 DB 投影。
- `FileSyncJournal.object_type` 区分 `file` 与 `folder`，目录创建、更新、移动/重命名后的旧路径失效和删除都会记录 journal。
- 文件读取在写入前后校验大小和 mtime，临时同步文件不会进入投影；文件夹树按 canonical 存储路径逐级创建和清理。
- 移除了 Shell 命令前基线、命令后 reconcile 和 Shell 专用事件发布；Shell 只保留执行、权限和审计职责。
- 旧的 Shell 来源绑定在 watcher 刷新时归一为本地目录绑定；已有本地 workspace 绑定会自动补登记。

## 回滚边界

关闭 `filesync.enabled` 即可停止新的 watcher 投影；保留 journal、outbox、冲突和物理文件，不通过删除表或清空卷回滚。旧 `sandbox.file_sync_enabled` 不再读取，运行配置需显式使用 `filesync.enabled`。

## 验证

- `tests/test_filesync_phase1.py`、`tests/test_filesync_phase4_oss.py`、`tests/test_filesync_phase5_admin.py`：既有同步、OSS 隔离和 Admin 回归通过。
- `tests/test_filesync_phase6.py`：目录候选、文件夹树创建、移动后旧路径失效、文件归属更新和目录删除通过。
