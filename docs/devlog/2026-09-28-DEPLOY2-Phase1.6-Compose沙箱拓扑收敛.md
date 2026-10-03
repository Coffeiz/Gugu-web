# PRD-DEPLOY-2 Phase 1.6：Compose 沙箱拓扑收敛

## 问题

默认 Compose 仍单独编排 `sandboxd` 与 `egress-proxy`，离线覆盖层还要求额外挂载沙箱 bundle manifest；生产分体 Compose 也把 Rootless manager 和 egress helper 的生命周期绑在同一个文件中。这与“一体化 app 自带 manager、分体业务部署由 external manager 管理”的部署边界不一致。

## 修复

- 默认 app 显式设置 `GUGU_SANDBOX_MANAGER_MODE=embedded`，挂载宿主 Docker Socket；Compose 不再声明 `sandboxd`、`egress-proxy` 或沙箱专用网络。
- 离线 Compose 只保留 app 与可选 SearXNG 的 `pull_policy: never`，移除外置 manager、egress 和重复 manifest 挂载。
- 生产分体 Compose 保留业务服务；backend/worker 显式使用 external manager 且强制 Rootless，只挂载预先由外部管理器创建的 socket volume，不获得 Docker Socket。
- PRD 和自动化断言同步记录这三种拓扑。离线发布 tar 中重复镜像的清理仍由 Phase 1.7 处理。

## 验证

- release workflow 定向 Node 测试：15 项通过，覆盖默认/离线/生产拓扑、候选 app、bundle 和 Compose updater。
- Ruby YAML 解析通过三份 Compose 文件。
- 当前机器只有 Docker CLI，没有 Compose 插件（`docker compose` 返回 unknown command），因此未能执行插值后的 `docker compose config --quiet`。
- 未触发 GitHub CI；按仓库约定由用户决定何时授权触发。
