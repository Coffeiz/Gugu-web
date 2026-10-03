# PRD-ARCH-2 Phase 1–4 验证记录

## 已完成

- 根 `package.json` 固定 `pnpm@10.15.0`，并由 `pnpm-workspace.yaml` 纳入仓库内 JS/TS workspace 包。
- 根 `pnpm-lock.yaml` 已按当前 manifest 更新，`corepack pnpm install --frozen-lockfile --lockfile-only` 通过。
- 前端、LoopScope、TS api/Worker、contracts 的 Docker、部署和 CI 入口统一使用 Corepack/pnpm；外部 `gugu-interaction-runtime` 保留独立安装边界。
- Gugu-web 前端和仓库根 workspace 以根 `pnpm-lock.yaml` 为准；LoopScope 独立应用可继续使用自己的 `loopscope/pnpm-lock.yaml`，外部 `gugu-interaction-runtime` 自己仓库仍使用其 `package-lock.json`。
- README、LoopScope README、许可证文档已改为根 workspace 命令。

## 验证结果

| 检查 | 结果 |
|---|---|
| `corepack pnpm --version` | 通过，10.15.0 |
| `corepack pnpm install --frozen-lockfile --lockfile-only` | 通过 |
| workspace 清单 | 通过，10 个包 |
| 完整 frozen install | 通过；使用现有 pnpm store 执行 `--offline --ignore-scripts` 验证 |
| `gugu-web` typecheck | 通过 |
| `loopscope-web` typecheck/build | 通过 |
| `@gugu/backend-ts` typecheck | 通过 |
| `gugu-rag-ts-worker` build | 通过；产物输出到 `backend/bin/gugu-rag-ts-worker.mjs` |
| `gugu-web` build | 通过（仅有 Vite 已知警告） |
| `gugu-web` test | 通过，48 个文件 / 318 个测试 |
| `@gugu/backend-ts` test | 通过，18/18 |
| 根 `pnpm test` | 主前端与 TS workspace 通过；LoopScope DB 原生测试需 Node 22 对应的 `better-sqlite3` 绑定，当前机器 Node 24 无匹配二进制 |

## 边界说明

`gugu-interaction-runtime` 不在本仓库 workspace 内，CI 仍在其自身目录安装，这是 PRD 约定的外部 Runtime 边界，不会生成本仓库的第二份锁文件。生产/开发 Docker 通过显式构建上下文复制该目录。

迁移没有修改 `backend/config.override.json`、`.env`、数据库或用户运行数据。构建产生的 `backend/bin` 属于现有生成产物，未作为本次 pnpm 迁移提交内容。

本地无法独立构建包含同级 `gugu-interaction-runtime` 的 Docker 镜像时，应在提供该外部目录的 devserver/CI 环境执行；这属于已记录的外部 Runtime 边界，不是 workspace 锁文件缺失。

## 2026-09-28 收尾

- 前端安装、检查、单测、E2E 和测试分层脚本统一使用根 pnpm workspace；根 `package.json` 声明 `packageManager` 版本，避免 Corepack 选择不确定版本。
- 前端许可证清单从 pnpm 安装目录读取元数据，不再依赖第二份前端锁文件。
- CI 中对外部 Runtime 仓库的 `npm ci`、沙盒镜像内 `npm --version` 冒烟检查，以及 RAG 固定原生运行时包的 npm 安装不属于 Gugu-web workspace 依赖安装，继续保留。
