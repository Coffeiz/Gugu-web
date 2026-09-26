# 离线沙盒一体化分发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 生成可一次导入的沙盒镜像包，并让 Compose 在本地离线部署时优先使用已导入镜像而不访问 Docker Hub。

**Architecture:** 分发层使用一个 tar 包保存 Gugu 应用、sandbox 执行镜像和 egress 代理镜像；运行层保留 `sandboxd` 控制服务与按需创建的执行容器。sandbox 初始化根据离线标记读取 bundle manifest，验证本地镜像后跳过 registry 与 Cosign verifier 的网络访问；在线模式保留现有拉取和验签流程。

**Tech Stack:** Docker CLI/Compose、POSIX shell、Python、Node.js tests、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-22-offline-sandbox-bundle-design.md`

## Global Constraints

- 不关闭 Shell 沙盒的安全隔离；`sandboxd` 与执行容器运行时继续分离。
- 不把聊天正文、凭据或真实用户信息写入日志、manifest、测试或 Git。
- 默认在线部署行为继续可用；离线模式必须显式启用或由离线 Compose 覆盖文件启用。
- 不修改 `docker-compose.prod.yml` 的外部 PostgreSQL/Redis 拓扑。
- 不删除现有用户运行配置和未相关的工作区修改。

## Review Focus

- 镜像已存在：离线启动不访问 registry，且 sandboxd 能通过固定 digest 工作；由 `test_offline_bundle_uses_local_images` 覆盖。
- 镜像缺失：离线启动给出可操作错误，不启动不安全的回退执行器；由 `test_offline_bundle_rejects_missing_image` 覆盖。
- manifest 不匹配：拒绝启动并指出镜像校验失败；由 `test_offline_bundle_rejects_digest_mismatch` 覆盖。
- 在线模式：仍能拉取并解析 digest；由现有初始化测试和一个在线分支回归用例覆盖。
- tar 内容：构建脚本不会静默保存未声明或缺失的镜像；由 shell 测试覆盖。

---

### Task 1: 定义离线 bundle manifest 与镜像校验接口

**Files:**
- Create: `backend/agent/sandbox/offline_bundle.py`
- Test: `backend/tests/test_offline_bundle.py`

**Interfaces:**
- `load_bundle_manifest(path: Path) -> BundleManifest`
- `validate_local_image(image: str, expected_digest: str, inspect_json: str) -> None`
- `BundleManifest.images: tuple[BundleImage, ...]`

- [ ] **Step 1: 写失败测试**，覆盖 manifest 缺字段、镜像 digest 不一致和匹配成功。
- [ ] **Step 2: 运行 `PYTHONPATH=. pytest -q backend/tests/test_offline_bundle.py`，确认先失败。**
- [ ] **Step 3: 实现只解析结构化 JSON、只比较 digest，不输出镜像层或敏感环境变量。**
- [ ] **Step 4: 重新运行同一测试并通过。**

### Task 2: 修改 sandbox 初始化的在线/离线分流

**Files:**
- Modify: `backend/scripts/sandbox_rootless_init.sh`
- Test: `backend/tests/test_sandbox_image_signature.py`

**Interfaces:**
- `GUGU_SANDBOX_OFFLINE=1` 开启离线校验。
- `GUGU_SANDBOX_BUNDLE_MANIFEST` 指向共享 manifest。

- [ ] **Step 1: 增加测试，验证离线模式不调用 `pull`，缺镜像或 digest 不匹配时失败。**
- [ ] **Step 2: 运行相关测试确认失败。**
- [ ] **Step 3: 在脚本中先检查本地镜像和 manifest；仅在线模式允许 pull 与 Cosign verifier。**
- [ ] **Step 4: 运行 Shell 语法检查及相关 Python 测试。**

### Task 3: 添加单 tar bundle 构建脚本和离线 Compose 覆盖

**Files:**
- Create: `scripts/release/build-offline-sandbox-bundle.sh`
- Create: `docker-compose.offline.yml`
- Modify: `.github/workflows/docker-release.yml`
- Test: `scripts/release/offline-bundle.test.mjs`

**Interfaces:**
- `build-offline-sandbox-bundle.sh --output <tar> --manifest <json>`。
- 离线 Compose 使用 `pull_policy: never`，并设置 `GUGU_SANDBOX_OFFLINE=1`。

- [ ] **Step 1: 为脚本参数、镜像缺失和输出 manifest 写失败测试。**
- [ ] **Step 2: 实现镜像白名单校验、digest 记录和 `docker save` 单 tar 输出。**
- [ ] **Step 3: 添加离线 Compose 覆盖，确保 app/sandboxd/egress 使用本地镜像且不声明 registry 拉取。**
- [ ] **Step 4: 在发布 workflow 中生成并上传 bundle artifact，不改变现有镜像发布标签。**
- [ ] **Step 5: 运行 Node 测试和 `bash -n`。**

### Task 4: 更新部署文档与验收

**Files:**
- Modify: `docs/quick-deploy.md`
- Modify: `docs/ops/deploy.md`
- Modify: `README.md`
- Modify: `README_en.md`

- [ ] **Step 1: 删除“离线部署必须手动再拉 sandbox 镜像”的说明。**
- [ ] **Step 2: 增加一次 `docker load`、一次 Compose 启动和失败排查命令。**
- [ ] **Step 3: 全文检查旧的 `sandbox-bootstrap`、强制 Docker Hub 拉取和单独手动配置步骤。**
- [ ] **Step 4: 运行文档引用检查与 Compose 静态校验。**

### Task 5: 完成验证

- [ ] **Step 1:** 运行 `bash -n` 检查所有新增/修改脚本。
- [ ] **Step 2:** 运行 `python -m pytest` 的沙盒、Compose 和签名相关测试。
- [ ] **Step 3:** 运行 `node --test scripts/release/*offline* scripts/release/docker-release-tags.test.mjs`。
- [ ] **Step 4:** 运行 `git diff --check`，确认不包含 tar、密码或运行时配置。
