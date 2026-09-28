# PRD-DEPLOY-2 Phase 1.8.1：部署模式矩阵

## 问题

集成回归原本把部署模式、入口进程故障和执行隔离都放进同一个验收点，不利于根据失败边界定位和回退。检查运行时策略时还发现：分体 `external` 模式只由 Compose 显式设置 `rootless_required=true`，模式本身并不强制 Rootless；如果部署配置漏传该字段，Rootful Docker 可能通过就绪检查。

## 修复

- 将 Phase 1.8 拆为三个可单独验证/提交的边界：部署模式矩阵、入口生命周期与故障隔离、执行隔离与资源清理。
- 统一用 `sandbox_requires_rootless()` 派生部署安全约束：external 恒要求 Rootless；embedded 仍可按配置要求 Rootless，默认允许个人单容器使用 Rootful。
- Docker 探测、执行就绪判断与 Admin 状态展示共用该约束，避免接口显示可用但运行时拒绝，或相反。
- 修正部署契约测试：默认/离线一体化不再要求独立 `sandboxd`/`egress-proxy`；生产分体检查 external Rootless 与外部 socket volume；保留开发 Compose 的独立 sandboxd 检查。

## 验证

- `tests/test_docker_runtime.py`、`tests/test_embedded_deps_contract.py`、`tests/test_unified_image_sandbox_boundary.py`：114 项通过。
- 覆盖 Rootful embedded、Rootless external、Rootful external 拒绝、disabled 不探测，以及 Admin/运行时模式判定一致。
- 未触发 GitHub CI；未执行真实 Docker Compose 部署验证。完整 `docker compose config` 仍待有 Compose 插件的环境复核。
