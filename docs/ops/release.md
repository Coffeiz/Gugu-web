# 发版与 PR 规范

> 背景：v1.0.2 发布时 trivy 连续拦截四次（pip 内置 `bom.cdx.json` 被误解析为应用依赖），复盘见
> [devlog 2026-09-03](../devlog/2026-09-03-v1.0.2发布扫描误报与生产部署.md)。本规范把当时缺的
> 「发布前置检查」固化下来。

## 1. PR 规范（dev → main）

- 任何进入 main 的代码必须走 dev → main 的 PR，禁止直接 push main。
- PR 标题与描述按 §1.1 编写；仓库的 `.github/PULL_REQUEST_TEMPLATE.md` 是创建 PR 时的填写模板。
- **GitHub CI 不随 PR 自动运行**（省 Actions usage，两个 workflow 均已去掉 `pull_request` 触发）。
  PR 合并前必须**人工手动触发**并等全绿：
  - 触发方式：GitHub Actions 页对 `Runtime integration` 和 `Docker release` 各点一次
    “Run workflow”，分支选 PR 源分支；或命令行
    `gh workflow run runtime-integration.yml --ref <PR分支>` /
    `gh workflow run docker-release.yml --ref <PR分支>`（GitHub 操作走 `agentskills/local/SKILL.md` 的代理配置）。
  - docker-release 的 `docker-build` job **已包含 trivy 扫描**（HIGH/CRITICAL、ignore-unfixed、
    exit-code 1）——两个 workflow 全绿就代表测试、镜像构建和安全门都过了。
  - push 到 main 和版本 tag 仍然自动触发；PR 迭代过程中的中间 commit 不再消耗 Actions 时长。
- PR 合并前的手动 CI 与 main 合并后的自动 CI 是两个不同门禁：前者决定是否合并，后者是发版前置条件（见 §2）。

### 1.1 PR 标题与描述

每个 PR 都必须按 `.github/PULL_REQUEST_TEMPLATE.md` **完整填写**，不得只写摘要或省略章节。模板章节和检查项是 PR 描述的最低结构要求，不是可选示例。

正文的 PR 类型必须勾选本 PR **实际包含的全部类型**，允许多选；不能只选标题类型，也不能把混合改动都归到一个类型。标题仍使用“`主要类型：简短说明`”格式，只写一个最能代表 PR 主要目的的类型，并且该类型必须也在正文勾选。混合改动的各类范围在“主要变更”中分别说明。

类型如下：

- **功能**：新增用户能力。
- **修复**：修复错误或异常行为。
- **改进**：优化现有功能、性能或体验。
- **重构**：调整实现或架构，原则上不改变用户可见行为。
- **安全**：修复或强化安全边界。
- **文档**：仅文档变更。
- **测试**：仅测试或测试基础设施变更。
- **构建/CI**：构建、依赖、流水线或开发工具变更。
- **发布**：版本号、CHANGELOG 或发版流程变更。

标题应描述用户能理解的目的，不写实现流水账、内部代号或未经核实的效果。例如“`修复：复制失败时不再显示成功`”。

正文必须保留并填写以下章节，不得留空：

- **PR 类型**：勾选本 PR 实际包含的全部类型，可以多选；标题使用其中一个主要类型作为前缀。
- **变更目的**：说明现状、要解决的问题或用户需求及预期结果；有 issue、PRD 或设计文档时附链接。
- **主要变更**：列出用户可感知变化和重要实现范围；混合改动区分各部分，并明确写出 PR 不包含的相关范围。
- **验证**：列出实际执行的命令或操作及结果。未执行的测试、类型检查、构建或手动验证须逐项写明“未执行”和原因；不得把计划执行写成已通过。
- **风险与兼容性**：说明影响对象以及 API、数据、配置、权限、部署和回滚影响；无已知影响时明确写“未发现”，不能留空或只写“低风险”。
- **部署说明**：说明环境变量、Compose/镜像调整、数据库迁移、人工步骤和回滚方式；无需额外步骤时明确写“无”。
- **截图或录屏**：所有 UI 变化必须附能展示结果的截图或录屏；非 UI 改动可删除此章节。无法提供 UI 材料时写明原因和待补项，不得勾选完成。
- **合并前检查**：逐项核对目标分支、标题/类型、验证、风险/部署、密钥/运行配置和 UI 材料，并如实勾选；未满足项保持未勾选并说明原因。

破坏性变化不作为 PR 类型单独勾选，必须在“风险与兼容性”中明确标注受影响对象、迁移方式和回滚限制。安全修复也应在该项说明安全边界或风险变化，避免只写“安全已修复”。

不适用的必填章节仍须保留，并填写“无”或“不适用”及简短原因；只有非 UI PR 可以删除“截图或录屏”章节。不得保留模板提示文字、空列表、空白章节或未经核对的勾选状态。类型清单中的每一项都必须判断是否适用：适用的全部勾选，不适用的不勾选。

PR 模板是必须完整填写的描述结构，不替代 §1 的合并门槛、§2 的发布前预检或对应领域的测试要求。PR 作者应将模板提示替换为具体事实，并为不适用项说明原因。

## 2. 发版前 CI 门禁与补充验证

打版本 tag 前，以 GitHub 上 **main 合并提交的自动 CI** 为准，不在 devserver 重复跑相同测试、镜像构建或 Trivy 扫描。

1. 确认待发布版本 PR 已合并，并记录 main 当前合并提交的完整 SHA；确认根目录与 `frontend/package.json` 版本号一致，CHANGELOG 已包含该版本小节，目标版本 tag 尚不存在。
2. 在 GitHub Actions 中按该 SHA 核对 `Runtime integration` 与 `Docker release` 两个由 push 到 main 自动触发的 workflow：必须均为 `completed / success`。若仍在运行就等待；若失败则停止发版，按常规 PR 修复后等待修复提交合入 main 并通过自动 CI。不得拿 PR 分支旧 run、较早的 main run 或仅有部分 job 成功代替。
3. `Runtime integration` 已覆盖前端 typecheck/unit tests/build、后端全量 pytest、关键 E2E 与相关集成检查；`Docker release` 已覆盖 Compose 校验、Sandbox/app/backend/frontend 镜像构建及对应安全扫描。以上范围不要求在本机或 devserver 再跑一遍。
4. 只有自动 CI 未覆盖、且与本次发布风险直接相关的验证，才做有针对性的补充检查。优先在本机执行；确实依赖 devserver、目标架构或真实部署环境时，只在 devserver 执行该项，并记录原因和结果，不重复全套 CI。

CI 状态可使用 GitHub Actions 页面或 `gh run list --branch main --commit <main完整SHA>` 核对，避免把同 SHA 的 tag 发布 run 当作 main 合并 CI。不得为了“刷新绿灯”而重复触发 workflow；需要重跑时按仓库授权规则先取得用户授权。

## 3. 版本号与 CHANGELOG

- 版本号两处同步：根目录 `package.json` 与 `frontend/package.json`。
- **DevTools 控制台 ASCII 横幅的版本号别忘确认**：浏览器控制台打印的 GUGU 描边字横幅
  （`frontend/src/utils/consoleBanner.ts`）里 `gugu v<版本>` 取自 vite define 注入的
  `__APP_RELEASE__`，来源是 `frontend/package.json` 的 version——因此上面的两处版本号
  同步漏掉任何一个，横幅就会显示旧版本。发版提交后构建一次，在控制台确认横幅版本已更新。
- `CHANGELOG.md` 新增版本小节，只写用户可感知的变化；排查细节进 `docs/devlog/`（按日期一篇）。
- 以上内容随最后一个功能 PR 一起进 dev，不要发版时临时补。

### 3.1 发布说明固定结构

每个版本的 `CHANGELOG.md` 小节和 GitHub Release 正文必须使用同一套结构。Release 正文按
“English 在前、中文在后”排列；中文版本不要求逐句直译，但功能、修复、贡献者和反馈者必须一一对应。

```markdown
## What's New

### New Features
- 面向用户的新能力。

### Improvements
- 面向用户的改进。

### Fixes
- 用户可感知的修复。

### Contributors
- Thank you to [@login](https://github.com/login) for PR #123 / the related contribution.

### Feedback & Issue Reporters
- Thank you to [@login](https://github.com/login) for reporting [#60](https://github.com/Coffeiz/Gugu-web/issues/60).

## 更新内容

### 新功能
- 面向用户的新能力。

### 改进
- 面向用户的改进。

### 修复
- 用户可感知的修复。

### 贡献者
- 感谢 [@login](https://github.com/login) 提交 PR #123 或参与相关贡献。

### 反馈与问题报告
- 感谢 [@login](https://github.com/login) 通过 [#60](https://github.com/Coffeiz/Gugu-web/issues/60) 提供反馈。
```

填写规则：

- `Contributors` / `贡献者` 写实际贡献代码、测试、文档或设计的 GitHub 用户；优先引用合并 PR，必要时补充直接贡献者。
- `Feedback & Issue Reporters` / `反馈与问题报告` 写本版本正文中引用的 issue 提交者；必须同时链接 issue 编号和报告者账号。
- issue 提交者与代码贡献者是同一人时，两节仍按事实分别记录，不用把 issue 贡献混写成 PR 贡献。
- 只感谢确实进入该版本的贡献；未合并 PR、重复 issue、机器人账号和自动生成内容不列入人工致谢，除非发布负责人明确说明其贡献。
- 修复条目引用 issue 时，使用 `(#N)`；对应的致谢条目再提供完整 issue 链接和报告者账号。
- 不在发布说明中写邮箱、内部用户名、私有链接、访问令牌或未公开的用户信息。
- 如果版本没有外部贡献或 issue 反馈，也要保留章节并写“暂无”；不要为了填充而猜测贡献者。

发版前必须从 GitHub PR/issue 元数据核对登录名和编号，不能根据 commit message、昵称或聊天记录猜测归属。

## 4. 打 tag 与发布

- **前置条件**：版本 PR 已合并进 main；合并前要求的手动 PR CI 全绿；并且 §2 所述两个 main 自动 workflow 针对**同一个待打 tag 的 main 合并 SHA**均已完成且成功。不得仅凭本地测试、devserver 测试或旧 run 打 tag。
- **版本 tag 命名只允许 `v<主>.<次>.<补丁>`（如 `v1.0.4`）**：小写 `v` 前缀 + 三段数字，
  不加日期、后缀或其它前缀；禁止打裸数字（历史上有过 `1.0.0`，与 `v1.0.0` 重复易混）。
  备份/基线等非版本用途的 tag 用 `backup/…`、`baseline-…` 命名，不会触发发布流水线。
- tag 打在 **main 的合并提交**上，附注 tag。**发布命名口径**：
  - **tag 附注**：单行简式 `vx.y.z：一句话摘要`（v1.1.1 样式），不写完整更新内容；
  - **GitHub Release**：标题纯 `vx.y.z`，正文放 CHANGELOG 对应版本小节全文（v1.1.0 范式），
    **未来发布正文双语：English 在前、中文在后**（v1.1.1～v1.2.3 的历史正文不追溯）；正文必须包含
    `Contributors` / `贡献者` 和 `Feedback & Issue Reporters` / `反馈与问题报告` 两节。
    流水线默认 `--generate-notes`，发布绿后用
    `gh release edit vx.y.z --title vx.y.z --notes-file <对应 CHANGELOG 小节>` 覆写。

  ```bash
  git fetch origin && git tag -a v1.0.x -m "v1.0.x：一句话摘要" origin/main && git push origin v1.0.x
  ```

- 推送 tag 后必须继续监控该 tag 对应的 `Docker release` workflow。只有 Compose 校验、镜像构建/扫描、候选镜像校验、发布推送及所需离线 bundle job 均按 workflow 条件成功完成，才可报告“发布完成”；tag 创建成功不等于镜像已发布。此阶段使用 GitHub 自动执行，不在 devserver 重复构建或扫描。
- tag 触发 publish job：构建公开的一体化 `gugu-web`、updater、sandbox 和拆分 backend/frontend 镜像，并同步推送 Docker Hub 与 GHCR；业务镜像只发布语义版本号标签，不发布 Git SHA 镜像标签。稳定版的一体化 `gugu-web`、updater、sandbox 仍维护 `latest` 别名；镜像均以 Cosign OCI 1.1 referrer 方式签名，签名不会创建 `sha256-<digest>.sig` 普通镜像 tag。此前已发布的旧式 `.sig` tag 保留，不做清理。update manifest 使用 `docker.io/coffeiz/gugu-web@sha256:...`，不引用拆分镜像。
- 一体化 `gugu-web` 发布必须先把同次构建的沙盒与 egress-proxy bundle 追加到 app 基础镜像，再通过 `verify_embedded_app_image.py` 完成完整性和离线 Shell smoke test；publish 只允许复制 `bundled-ci-<run_id>` 候选镜像，禁止把 `ci-<run_id>` 基础 app 镜像作为单容器正式镜像。只有明确需要本地离线验收包时，才用 `scripts/release/build-bundled-app-image.sh` 组装验证并可选通过 `--archive` 导出 `.tar`；这不是常规发版 CI 的替代或重复步骤，也不得直接 `docker save` 基础 app 镜像。
- 稳定版发布完成后，CI 会在 GHCR 与 Docker Hub 的四个镜像仓库中保留最新 10 个 `v主.次.补丁` 正式版本 tag；预发布、`latest`、`dev` 和其他非版本 tag 不清理。GHCR 仅删除不含别名或保留版本 tag 的旧 package version；`GITHUB_TOKEN` 必须对 GHCR package 有 admin 权限，`DOCKERHUB_TOKEN` 必须具备删除 tag 的权限。若 registry 权限或平台限制导致清理失败，只记录告警，不回滚或阻断已完成的发布。
- Docker Hub 首次推送会按 `coffeiz` 命名空间的默认可见性创建 backend/frontend 仓库；首次发布前确认这两个仓库为 Public，确保业务服务器可匿名拉取。

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
docker restart gugu-web-main-nginx-1
```

- compose 项目名必须 `-p gugu-web-main`；`backend/.env`、`config.override.json` 属用户数据，流程中只读。
- backend/frontend 镜像在 Docker Hub 与 GHCR 均公开，可匿名拉取；业务服务器优先使用 Docker Hub，也可改用 GHCR 同版本标签。
- sandboxd 与 backend 共用镜像 tag，`up -d` 检测不到 tag 底层镜像变化，必须 `--force-recreate`。
- **`docker restart nginx-1` 保留为收尾保险动作**。`nginx/nginx.conf` 已带 Docker 内置 DNS
  resolver（127.0.0.11，10s 重解析）+ 变量式 `proxy_pass`，上游 IP 变化会自动跟随；
  但 `up -d` 后立即重启 nginx 时 backend/frontend 往往还没监听，会看到瞬时 502
  （v1.3.1 教训）。正确收尾：等 `docker ps` 里 backend 显示 healthy 再 restart nginx，
  然后 curl 公网域名确认 200；若仍 502，先分层定位——`curl 127.0.0.1:9595/health`
  通了而公网 502，说明问题在外层 1Panel OpenResty（502 页脚的 nginx 版本可区分层级），
  不要在容器层反复重启。

### Shell 沙盒前置（首次部署或迁移时）

沙盒容器由 backend 通过 docker.sock 作为**兄弟容器**启动，`--mount src=.../users/<uid>/shell`
由**宿主机 daemon** 解析，所以宿主机需要看到与容器内一致的 `Gugu-data` 路径。Compose
会把 `GUGU_DATA_HOST_DIR` 直接 bind 到容器的 `/data`，未设置时按 Compose 文件目录解析为
`Gugu-data`，首次启动会自动创建。启用 `sandbox` profile 时，`sandboxd` 会在启动前自动为每个用户的
`shell`、`个人文件`、`项目文件` 根目录及已有子目录
设置 Rootless UID/GID ACL，并用真实沙盒 UID 做写入探针；不需要手工 chmod/chown：

```bash
mkdir -p Gugu-data && chown 1001:1001 Gugu-data   # 1001 = rootless docker 用户的 uid
docker -H unix:///run/user/1001/docker.sock pull debian@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
```

- 沙盒镜像 `--pull=never`，必须提前拉进 rootless daemon 的镜像库，否则报 image not found。
- rootless 下沙盒进程使用目标 daemon 的 subordinate UID/GID 映射；sandboxd 启动前会从宿主机的
  `/etc/passwd`、`/etc/subuid`、`/etc/subgid` 读取映射并写入 ACL。若探针失败，bootstrap
  会失败并在日志中给出权限错误，不能等到用户第一次执行 Shell 才发现。
- 从旧单容器升级：必须先执行 `scripts/migrate-single-container-to-compose.sh` 完成一次数据库、
  用户文件和配置迁移；已经迁移到 Compose 持久化卷后，正式更新脚本不再执行旧的 named volume
  文件迁移。

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
