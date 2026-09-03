# 发版与 PR 规范

> 背景：v1.0.2 发布时 trivy 连续拦截四次（pip 内置 `bom.cdx.json` 被误解析为应用依赖），复盘见
> [devlog 2026-09-03](../devlog/2026-09-03-v1.0.2发布扫描误报与生产部署.md)。本规范把当时缺的
> 「发布前置检查」固化下来。

## 1. PR 规范（dev → main）

- 任何进入 main 的代码必须走 dev → main 的 PR，禁止直接 push main。
- PR 合并前 CI 必须全绿。docker-release workflow 的 `docker-build` job 对所有 PR 运行，
  **已包含 trivy 扫描**（HIGH/CRITICAL、ignore-unfixed、exit-code 1）——PR 绿就代表镜像构建和安全门都过了。
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
- `CHANGELOG.md` 新增版本小节，只写用户可感知的变化；排查细节进 `docs/devlog/`（按日期一篇）。
- 以上内容随最后一个功能 PR 一起进 dev，不要发版时临时补。

## 4. 打 tag 与发布

- **前置条件**：版本 PR 已合并进 main，且该 PR 的 CI（含 trivy 门）全绿。
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

### 部署后验证清单

- `docker ps`：backend healthy；worker/gateway 显示 unhealthy 是已知 healthcheck 配错（容器内无
  `/health` 路由），实际健康看日志——worker 出现 `started · consumer=…`、gateway 的 QQ/飞书
  WebSocket `READY` 才算通过。
- 新增镜像依赖验证：进入 backend 容器实际调用一次（如 LibreOffice 用 `--convert-to pdf` 转一个
  真实文件，`.md` 不在支持格式内会报错，属正常）。
- 前端打开一次核心页面（项目、聊天、弹窗），确认版本号与 CHANGELOG 对应的变化生效。
