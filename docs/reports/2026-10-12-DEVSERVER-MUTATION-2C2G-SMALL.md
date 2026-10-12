# devserver 受限资源变异测试小批报告

- 日期：2026-10-12
- 基线：Mutagen 同步后的工作文件快照；未使用 devserver Git 元数据作为版本依据。
- 测试范围：`scripts/quality/mutation_scope.json` 登记的 Python 7 个目标，共生成 60 个变异。
- 结果：60 killed、0 survived、0 timeout、0 compile error、0 runtime error、0 no coverage、0 equivalent、0 not checked；mutation score 100%（仅限本批）。
- 执行耗时：131.5 秒。
- 资源限制：cgroup v2 CPU 配额 200%（最多 2 核）、`MemoryHigh=1792 MiB`、`MemoryMax=2048 MiB`、`MemorySwapMax=0`；mutmut 子进程上限为 2。运行中采样的内存峰值约 0.86 GiB，任务成功退出，未触及硬上限。
- 隔离方式：在临时副本执行，只复制本批所需的 Python 源码、测试和质量脚本；运行配置、数据库、上传内容及用户数据未复制。

## 缓存与镜像清理

- 删除 4 个未被容器引用的旧 Gugu 测试镜像；Docker 镜像清理另移除 2 个同样未被容器引用的旧镜像。停止容器及其镜像仍保留。
- 清除了无活动构建使用的 BuildKit 缓存，回收 12.72 GiB。
- 清理了 npm、pip 缓存及 pnpm store 中未再被引用的旧包；pnpm store 保留仍被引用的内容。
- Docker volumes、运行容器、应用数据、数据库、上传文件和运行配置均未清理。
- 根分区使用率从 93% 降至 72%，可用空间从约 8.5 GiB 增至约 34 GiB。

## 结论与限制

本批证明 Python 登记范围可以在 2 核、2 GiB 硬限制下稳定运行。100% 仅表示本批 60 个有效变异均被关联测试杀死，不能外推到全仓。TypeScript 和未登记的其余源码没有在本次运行。

没有修改业务代码、测试配置或 CI；临时副本在报告核对后清理。
