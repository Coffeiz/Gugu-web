# PRD-ARCH-2 Phase 1–4 验证记录

## 已完成

- 根 `package.json` 固定 `pnpm@10.15.0`，并由 `pnpm-workspace.yaml` 纳入 10 个仓库内 JS/TS workspace 包。
- 根 `pnpm-lock.yaml` 已按当前 manifest 更新，`pnpm install --frozen-lockfile --lockfile-only` 通过。
- 前端、LoopScope、TS API/Worker、contracts 的 Docker、部署和 CI 入口统一使用 Corepack/pnpm；外部 `gugu-interaction-runtime` 保留独立安装边界。
- 已删除仓库内 4 个子项目 `package-lock.json`，避免 npm/pnpm 双锁文件漂移。
- README、LoopScope README、许可证文档已改为根 workspace 命令。

## 验证结果

| 检查 | 结果 |
|---|---|
| `corepack pnpm --version` | 通过，10.15.0 |
| `pnpm install --frozen-lockfile --lockfile-only` | 通过 |
| workspace 清单 | 通过，10 个包 |
| 完整 frozen install | 当前机器未完成；registry 下载存在超时/缺少离线 tarball |
| typecheck/build | 需在依赖完整安装的干净环境执行；未把不完整 node_modules 结果当作通过 |

## 边界说明

`gugu-interaction-runtime` 不在本仓库 workspace 内，CI 仍在其自身目录安装，这是 PRD 约定的外部 Runtime 边界，不会生成本仓库的第二份锁文件。生产/开发 Docker 通过显式构建上下文复制该目录。

迁移没有修改 `backend/config.override.json`、`.env`、数据库或用户运行数据。
