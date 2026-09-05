# 发版与 PR 规范

> 背景：v1.0.2 发布时 trivy 连续拦截四次（pip 内置 `bom.cdx.json` 被误解析为应用依赖），复盘见
> [devlog 2026-09-03](../devlog/2026-09-03-v1.0.2发布扫描误报与生产部署.md)。本规范把当时缺的
> 「发布前置检查」固化下来。

## 1. PR 规范（dev → main）

- 任何进入 main 的代码必须走 dev → main 的 PR，禁止直接 push main。
- **GitHub CI 不随 PR 自动运行**（省 Actions usage，两个 workflow 均已去掉 `pull_request` 触发）。
  PR 合并前必须**人工手动触发**并等全绿：
  - 触发方式：GitHub Actions 页对 `Runtime integration` 和 `Docker release` 各点一次
    “Run workflow”，分支选 PR 源分支；或命令行
    `gh workflow run runtime-integration.yml --ref <PR分支>` /
    `gh workflow run docker-release.yml --ref <PR分支>`（GitHub 操作走 `agentskills/local/SKILL.md` 的代理配置）。
  - docker-release 的 `docker-build` job **已包含 trivy 扫描**（HIGH/CRITICAL、ignore-unfixed、
    exit-code 1）——两个 workflow 全绿就代表测试、镜像构建和安全门都过了。
  - push 到 main 和版本 tag 仍然自动触发；PR 迭代过程中的中间 commit 不再消耗 Actions 时长。
- CI 只跑了构建与扫描，业务回归脚本本地跑（见 §2）。不要为了赶发版跳过回归直接合。

## 2. 发版前本地预检（打 tag 之前必须全部通过）

```bash
# 1) 前端回归：确认弹窗/提醒组件契约与玻璃样式没被破坏
cd frontend && npm run typecheck && npm run test:css-glass && npm run test:ui-dialogs

# 2) 后端测试
cd backend && PYTHONPATH=. python -m pytest -q

# 3) 本地构建生产镜像并 trivy 预扫（防患于未然，别让 CI 当第一个发现问题的）
docker build -f backend/Dockerfile.prod  -t gugu-backend:release-check .
docker build -f frontend/Dockerfile.prod -t gugu-frontend:release-check .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
  image gugu-backend:release-check --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
  image gugu-frontend:release-check --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
```

注意：

- 本地没有 docker 时可用 devserver（amd64、与生产同架构）执行 §2 的第 3 步。
- trivy 报的 installed version 若与镜像 dist-info 不一致，是语言清单类文件误报（如 pip 的
  `pip/_vendor/bom.cdx.json`，workflow 里已 skip-files），不是真的漏洞——先核对再下结论。
- 新增依赖时先查一下是否引入新的 HIGH/CRITICAL（`pip install pip-audit` 或扫一次），避免发版当天返工。

## 3. 版本号与 CHANGELOG

- 版本号两处同步：根目录 `package.json` 与 `frontend/package.json`。
- **DevTools 控制台 ASCII 横幅的版本号别忘确认**：浏览器控制台打印的 GUGU 描边字横幅
  （`frontend/src/utils/consoleBanner.ts`）里 `gugu v<版本>` 取自 vite define 注入的
  `__APP_RELEASE__`，来源是 `frontend/package.json` 的 version——因此上面的两处版本号
  同步漏掉任何一个，横幅就会显示旧版本。发版提交后构建一次，在控制台确认横幅版本已更新。
- `CHANGELOG.md` 新增版本小节，只写用户可感知的变化；排查细节进 `docs/devlog/`（按日期一篇）。
- 以上内容随最后一个功能 PR 一起进 dev，不要发版时临时补。

## 4. 打 tag 与发布

- **前置条件**：版本 PR 已合并进 main，且合并前手动触发的 CI（含 trivy 门）全绿；
  合并提交进 main 后 push 自动触发的那轮 CI 也应为绿。
- **版本 tag 命名只允许 `v<主>.<次>.<补丁>`（如 `v1.0.4`）**：小写 `v` 前缀 + 三段数字，
  不加日期、后缀或其它前缀；禁止打裸数字（历史上有过 `1.0.0`，与 `v1.0.0` 重复易混）。
  备份/基线等非版本用途的 tag 用 `backup/…`、`baseline-…` 命名，不会触发发布流水线。
- tag 打在 **main 的合并提交**上，附注 tag，消息格式 `发布 Gugu <版本>`：

  ```bash
  git fetch origin && git tag -a v1.0.x -m "发布 Gugu 1.0.x" origin/main && git push origin v1.0.x
  ```

- tag 触发 publish job：构建并推送 GHCR + Docker Hub（tag 形如 `v1.0.x`，带 v）、cosign 签名、
  生成 update manifest。Docker Hub 的公共 tag 是 `coffeiz/gugu-web-{backend,frontend}:v1.0.x`。

### 发布失败处理

- 只失败在 tag 上时，修复提交走正常 PR 合入 main，然后**删除远端 tag 重打**（发布未完成、无
  已发布产物，重打不算历史重写；已发布出去的版本号不允许复用，改用 patch +1）。
- 重打后盯 publish job 到全绿再继续部署。

## 5. 生产部署（root@<host>，/opt/Gugu-web-main）

```bash
docker pull docker.io/coffeiz/gugu-web-backend:v1.0.x
docker pull docker.io/coffeiz/gugu-web-frontend:v1.0.x
docker tag docker.io/coffeiz/gugu-web-backend:v1.0.x   gugu-web-backend:prod
docker tag docker.io/coffeiz/gugu-web-frontend:v1.0.x  gugu-web-frontend:prod
cd /opt/Gugu-web-main && docker compose -p gugu-web-main -f docker-compose.prod.yml up -d
docker compose -p gugu-web-main -f docker-compose.prod.yml up -d --force-recreate sandboxd
```

- compose 项目名必须 `-p gugu-web-main`；`backend/.env`、`config.override.json` 属用户数据，流程中只读。
- sandboxd 与 backend 共用镜像 tag，`up -d` 检测不到 tag 底层镜像变化，必须 `--force-recreate`。

### Shell 沙盒前置（首次部署或迁移时）

沙盒容器由 backend 通过 docker.sock 作为**兄弟容器**启动，`--mount src=.../users/<uid>/shell`
由**宿主机 daemon** 解析，所以宿主机必须存在与容器内一致的 `Gugu-data` 路径（compose 用
local driver 把 `GUGU_DATA_HOST_DIR` bind 成固定的 `gugu_data` 卷，未设置时按启动目录解析为上一级 `Gugu-data` 的绝对路径）：

```bash
mkdir -p ../Gugu-data && chown 1001:1001 ../Gugu-data   # 1001 = rootless docker 用户的 uid
docker -H unix:///run/user/1001/docker.sock pull debian@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
```

- 沙盒镜像 `--pull=never`，必须提前拉进 rootless daemon 的镜像库，否则报 image not found。
- rootless 下沙盒进程映射到部署用户 uid，backend（root）创建的 shell 根目录会由
  `ensure_sandbox_root` 放开为 0777，属主问题不需要手工处理。
- 从旧 named volume 升级：Compose 的 `data-migrate` 会在业务服务启动前，把
  `GUGU_LEGACY_DATA_VOLUME` 指定的旧卷（默认 `gugu-web-compose_gugu_data`）复制到
  `GUGU_DATA_HOST_DIR`；升级前先停掉旧业务容器，源卷只读挂载并保留，不需要 `down -v`
  或手工删卷。正式更新脚本会自动完成停服务、迁移和重启。

### 部署后验证清单

- `docker ps`：backend healthy；worker/gateway 显示 unhealthy 是已知 healthcheck 配错（容器内无
  `/health` 路由），实际健康看日志——worker 出现 `started · consumer=…`、gateway 的 QQ/飞书
  WebSocket `READY` 才算通过。
- 新增镜像依赖验证：进入 backend 容器实际调用一次（如 LibreOffice 用 `--convert-to pdf` 转一个
  真实文件，`.md` 不在支持格式内会报错，属正常）。
- 前端打开一次核心页面（项目、聊天、弹窗），确认版本号与 CHANGELOG 对应的变化生效。

### 入口反代（1Panel OpenResty）缓存陷阱

公网入口 vhost（`playground.gugugu.site.conf`）的 `location /` 若开启 `proxy_cache`，
会把 `/api` 的 GET 响应一并缓存（默认 `proxy_cache_valid 200 ... 10m`，key 只有
host+uri+args）。后果：用户操作成功后前端重新拉数据拿到缓存的旧 200，表现为
「操作不生效、刷新后归位」；且缓存 key 不含 Authorization/Cookie，**不同用户命中
同一 URL 会共享缓存响应，存在跨用户泄露风险**。

规则：

- 入口反代对 `/api` 一律 `proxy_cache off`（或 vhost 整体不开 proxy_cache）；
  静态资源可以缓存，但 `index.html` 不能长缓存（否则发版后引用旧 hash 资源）。
- 1Panel 修改 vhost 后，改动可能被面板覆写，reload 前后各 `cat` 一次确认内容，
  并把变更记进该站点的备份目录。
- 排障口诀：写入类接口日志正常、库里数据正确、但客户端读到旧值 → 先查入口链路
  （1Panel OpenResty）有没有缓存，再看应用层。
