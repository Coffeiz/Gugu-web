# PRD-ARCH-2 pnpm 依赖管理迁移

## 1. 背景

迁移前仓库曾同时使用多个独立的 npm 依赖边界；本 PRD 的执行结果已统一为根 pnpm workspace：

- `frontend/`、`loopscope/frontend/`、`loopscope/apps/*`、`loopscope/packages/*`、`backend/ts`、`backend/ts/packages/*`、`backend/ts/workers/*` 均由根 workspace 管理。
- 迁移前的各目录 `package-lock.json` 及根部空锁文件已删除，当前仅保留根 `pnpm-lock.yaml`。
- 主前端通过 `file:../../gugu-interaction-runtime` 引用同级目录的 Interaction Runtime；该目录不在当前仓库根目录内。

依赖安装和构建入口目前还分散在：

- `frontend/Dockerfile`、`frontend/Dockerfile.prod`
- `loopscope/frontend/Dockerfile`
- `.github/workflows/runtime-integration.yml`
- `backend/Makefile`
- `backend/deploy.sh`
- `README.md`、`loopscope/README.md`

目标不是立即把整个 Python 后端改成 TypeScript，而是先统一 JavaScript/TypeScript 依赖管理，减少重复安装、锁文件漂移和环境差异，为后续 TypeScript API、Worker 和共享类型包提供稳定基础。

## 2. 目标

### 2.1 主要目标

1. 用 pnpm 作为仓库 JavaScript/TypeScript 项目的统一包管理器。
2. 通过 pnpm workspace 管理仓库内可共享的前端、LoopScope、TypeScript worker 和共享包。
3. 保持现有 Vue/Vite 构建产物、开发端口、运行时行为和 `gugu-interaction-runtime` 的版本边界不变。
4. 让本地开发、Docker 构建、devserver 部署和 CI 使用同一套安装与锁定规则。
5. 将依赖安装和构建失败变成明确错误，不用兼容脚本掩盖 workspace 或锁文件问题。

### 2.2 非目标

- 本阶段不迁移 Python/FastAPI、Alembic、PostgreSQL 或 Redis。
- 本阶段不把所有前端合并成一个应用，也不改变 Vite 多入口结构。
- 本阶段不把同级 `gugu-interaction-runtime` 强行复制进仓库。
- 本阶段不引入 Next.js；当前前端继续使用 Vue + Vite，后端 API 与 Worker 独立迁移。
- 不为了减少 lockfile 数量而把生产依赖打包进 Git 或提交 `node_modules`。

## 3. 当前复杂度评估

### 3.1 依赖边界

| 边界 | 当前方式 | 迁移难度 | 主要风险 |
|---|---|---:|---|
| `frontend/` | 独立 npm 项目 | 中 | `file:` Runtime、postinstall 修链、Vite 外部源码监听 |
| `loopscope/frontend/` | 独立 npm 项目 | 低 | 与主前端重复 Vue/Vite 依赖，构建路径需保持不变 |
| `backend/ts/workers/rag/` | 独立 npm 项目 | 中 | 输出路径、native `@node-rs/jieba`、生产安装省略 dev 依赖 |
| `backend/ts/packages/contracts/` | 已有包目录但尚未纳入 workspace | 低 | 需要补齐 package 元数据和引用关系 |
| `gugu-interaction-runtime` | 仓库外 `file:` 依赖 | 高 | pnpm workspace 无法直接把仓库外目录纳入当前 workspace |
| Docker/CI/deploy | 多处硬编码 npm | 中 | 漏改会造成不同锁文件和不同安装器并存 |

总体评估：**迁移已完成；根 workspace 当前纳入 10 个仓库内包。Runtime 外部依赖边界和 Docker/CI 一致性仍是后续维护重点。**

### 3.2 已确认的特殊约束

- 主前端 `postinstall` 会执行 `scripts/fix-runtime-link.mjs`，用于修复 `file:` 依赖产生的 Runtime 链接。
- 生产 Docker 构建需要同时提供 `frontend/` 和同级 `gugu-interaction-runtime/` 内容。
- 开发 Compose 使用源码挂载和匿名 `node_modules` 卷，不能简单把宿主机 `node_modules` 映射进容器。
- RAG worker 使用 `@node-rs/jieba`，必须验证 macOS arm64、Linux x64 和容器平台的可选 native 包解析。
- CI 使用 pnpm store cache，并在根 workspace 通过 filter 安装和构建；外部 Runtime 仍在其自身目录使用 npm ci。
- `backend/Makefile` 和 `backend/deploy.sh` 的仓库内构建入口已切换为 Corepack/pnpm。
- 根部空 `package-lock.json` 已删除，不再作为安装入口。

## 4. 目标目录结构

第一阶段建议保持业务目录不动，只新增 workspace 元数据：

```text
Gugu-web/
├── package.json                 # workspace 根配置，仅放公共脚本/工具
├── pnpm-workspace.yaml          # workspace 包范围
├── pnpm-lock.yaml               # 唯一 JS/TS 依赖锁文件
├── .npmrc                       # engine-strict、lockfile 与脚本策略
├── frontend/
│   ├── package.json
│   └── src/
├── loopscope/
│   └── frontend/
│       ├── package.json
│       └── src/
├── backend/
│   └── ts/
│       ├── packages/
│       │   └── contracts/
│       │       ├── package.json
│       │       └── src/
│       └── workers/
│           └── rag/
│               ├── package.json
│               └── src/
└── scripts/
    └── node/                    # 可选：仓库级依赖检查/构建辅助脚本
```

推荐 workspace 包范围：

```yaml
packages:
  - frontend
  - loopscope/frontend
  - backend/ts/packages/*
  - backend/ts/workers/*
```

`gugu-interaction-runtime` 暂时不加入 workspace，继续作为明确版本边界的外部 `file:` 依赖；后续可选择：

1. 将 Runtime 迁入同一父级 monorepo，再使用 `workspace:` 依赖；或
2. 构建并发布内部 tarball/package，再由主前端固定版本引用。

在没有完成其中一种方案前，不应伪装成 workspace 包。

## 5. 包管理约定

### 5.1 版本与安装

- 根 `package.json` 固定 `packageManager: "pnpm@<经验证版本>"`。
- CI、Docker 和 devserver 使用 Corepack 或固定版本 pnpm，不允许自动使用系统全局版本。
- CI 和生产构建使用 `pnpm install --frozen-lockfile`。
- 本地开发使用 `pnpm install`，修改依赖后只由 pnpm 更新根 `pnpm-lock.yaml`。
- 迁移完成后删除各子项目的 `package-lock.json`，删除根部空 `package-lock.json`。
- 不提交任何 `node_modules`；现有生成目录只能通过 `.gitignore` 和清理检查保证不进入 Git。

### 5.2 脚本调用

根脚本只做编排，业务脚本仍保留在各包内：

```json
{
  "scripts": {
    "dev:web": "pnpm --dir frontend dev",
    "build:web": "pnpm --dir frontend build",
    "build:rag": "pnpm --dir backend/ts/workers/rag build",
    "build": "pnpm -r --if-present build",
    "typecheck": "pnpm -r --if-present typecheck"
  }
}
```

不使用模糊的 `pnpm run <script>` 跨目录调用，避免当前目录变化造成误执行。

### 5.3 依赖边界

- 只有真正被多个 workspace 包共享的依赖才提升到根部工具层；Vue、Vite、业务 UI 依赖继续由对应应用声明。
- `backend/ts/packages/contracts` 使用 `workspace:*` 被 API、Worker 或未来共享包引用。
- 不为了去重强制统一主前端和 LoopScope 的 Vue/Vite 版本；先以现有构建可复现为准。
- native optional dependency 必须保留 pnpm 的平台选择行为，不得用手工复制二进制替代包管理。

## 6. 分阶段实施 TODO

### Phase 0：基线与回滚点

- [ ] 记录当前各项目 Node、npm、锁文件版本和成功构建命令。
- [ ] 确认 devserver、CI、Docker 使用的 Node 主版本；统一到已验证版本。
- [ ] 备份现有 lock 文件和构建产物，不修改用户运行配置。
- [ ] 建立迁移分支和回滚说明；迁移期间不改业务逻辑。

验收：迁移前的主前端、LoopScope、RAG worker 构建结果可复现。

### Phase 1：建立 pnpm workspace

- [x] 新增根 `package.json`、`pnpm-workspace.yaml` 和 `.npmrc`。
- [x] 将仓库内前端、LoopScope、TS api/Worker 与 contracts 包纳入 workspace。
- [x] 补齐 `backend/ts/packages/contracts/package.json` 的入口、类型和脚本。
- [x] 迁移依赖并生成唯一 `pnpm-lock.yaml`。
- [x] 保留 `gugu-interaction-runtime` 的外部 `file:` 依赖和 postinstall 修链。
- [x] 固化 `pnpm --filter` 安装、构建与类型检查入口。

验收：干净目录执行 frozen install 后，三个现有项目均可 typecheck/build。

### Phase 2：迁移 Docker 与 devserver

- [x] 更新 `frontend/Dockerfile`、`frontend/Dockerfile.prod`、`loopscope/frontend/Dockerfile`。
- [x] 在 Docker 中启用固定 pnpm 版本和 frozen install。
- [x] 保持开发 Compose 的源码挂载、匿名 `node_modules` 卷和端口不变。
- [x] 更新 `backend/Makefile`、`backend/deploy.sh` 中的 RAG 构建命令。
- [x] 保留 devserver 对运行配置和生成目录的保护边界。
- [x] 保持 RAG worker 的 `backend/bin` 输出路径和执行权限。

验收：Docker Compose 开发环境、生产构建和 devserver 部署结果一致。

### Phase 3：迁移 CI 与文档

- [x] 将仓库内 GitHub Actions 的 npm cache 改为 pnpm store cache。
- [x] 仓库内包安装改为 `pnpm install --frozen-lockfile`。
- [x] 保留主前端、LoopScope、Runtime 联调和 RAG worker 的独立检查入口。
- [x] 更新 README、LoopScope README 和许可证文档中的命令。
- [x] 删除仓库内子项目 lock 文件，避免重新引入双锁文件。

验收：CI、文档命令和本地命令使用同一包管理器，失败时能明确定位到具体 workspace 包。

### Phase 4：清理与后续演进

- [x] 删除仓库内旧 `package-lock.json` 和迁移入口中的 npm 专用分支。
- [x] 清点 workspace 重复依赖；未做无测试保障的激进去重。
- [x] 记录 `gugu-interaction-runtime` 仍为 workspace 外部边界，后续再评估 monorepo/内部包。
- [x] 固化 TypeScript API、Worker 和 contracts 的 package 命名规则。
- [x] 将 pnpm workspace 约定补充到开发文档。

验收：新开发者只需安装固定 Node/pnpm 版本，即可完成安装、开发、测试和构建。

## 7. 验证矩阵

| 场景 | 必须验证 |
|---|---|
| macOS arm64 | 主前端、LoopScope、RAG native jieba、Runtime 链接 |
| Linux x64 devserver | frozen install、RAG worker、Vite 构建、SSE/LoopScope 联调 |
| Docker 开发 | 源码挂载、匿名 node_modules 卷、后端代理、热更新 |
| Docker 生产 | Runtime 外部依赖、静态产物、Nginx 镜像、无源码泄漏 |
| CI 干净环境 | pnpm store cache、所有 typecheck/test/build job |
| 无 Runtime 同级目录 | 失败信息明确，不生成错误 symlink 或空依赖目录 |

## 8. 风险与处理

### 外部 Runtime 目录无法纳入当前 workspace

短期保留 `file:` 依赖，并在 Docker 构建上下文中显式复制 Runtime；中期迁入 monorepo 或发布内部包。不得依赖开发机绝对路径。

### pnpm 的链接布局与 npm 不同

重点验证 Vite alias、Vue dedupe、TypeScript 类型解析、`postinstall` 和 `file:` 链接。若某个工具依赖扁平 `node_modules`，优先修正其解析配置，不默认打开宽松的 hoist。

### native RAG 依赖平台差异

在 macOS arm64、Linux x64 和 Docker 目标平台分别执行安装和 worker smoke test；不能只在当前开发机验证。

### 迁移期间出现双锁文件

Phase 1 只允许生成根 `pnpm-lock.yaml`。发现新的 `package-lock.json` 时让 CI 直接失败，避免“本地 npm、服务器 pnpm”的隐性分叉。

## 9. 完成标准

满足以下条件后，才能将本 PRD 标记为完成：

1. 仓库内所有 JS/TS 包都由 pnpm workspace 管理。
2. 只保留根 `pnpm-lock.yaml`，没有业务目录 lock 文件。
3. 主前端、LoopScope、RAG worker 在本地、Docker、devserver 和 CI 的安装/构建均通过。
4. `gugu-interaction-runtime` 的边界和失败行为有明确文档与测试。
5. 没有修改或覆盖 `backend/config.override.json`、`.env`、数据库和用户运行数据。
6. 新开发者按 README 操作即可完成安装、测试和构建。
