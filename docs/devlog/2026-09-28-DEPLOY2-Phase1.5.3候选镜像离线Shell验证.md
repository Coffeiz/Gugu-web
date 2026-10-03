# PRD-DEPLOY-2 Phase 1.5.3：候选镜像离线 Shell 验证

## 变更

- 保留候选 app 的平台、完整 Config 和“只追加一个 bundle 层”校验。
- 候选 app 在 `network=none`、只读容器中调用 `EmbeddedBundleRuntime` 校验 manifest 与归档摘要。
- 验证脚本从候选镜像提取同一归档，在宿主 Docker daemon 导入并核对 manifest 中的 image ID；随后对内置 sandbox 镜像执行受限的离线 Shell 命令。
- 候选 app 容器本身不挂载 Docker Socket，避免将宿主 Docker 控制权交给被测应用代码。
- 将 Docker 操作设为有界超时，并始终清理本次创建的临时候选容器。

## 验证

- `backend/.venv/bin/python -m pytest -q scripts/release/test_verify_embedded_app_image.py scripts/release/test_build_embedded_sandbox_bundle.py`：11 项通过。
- release workflow 相关 Node 测试：22 项通过；workflow YAML 解析、`py_compile`、`git diff --check` 通过。
- devserver Rootless daemon 上，以 `network=none`、只读、drop capabilities 等限制直接运行已存在的 sandbox runtime 镜像，命令输出 `shell-smoke-ok`。
- 前一轮候选镜像验证记录：base/candidate 的 Docker `Size` 分别为 744,190,513 / 1,421,878,881 bytes，差值 677,688,368 bytes；bundle tar 为 682,954,752 bytes。上述 `Size` 是本地未压缩镜像存储量，不是 registry 压缩下载增量；workflow 中的 crane manifest 压缩增量步骤负责记录后者。

## 未完成的端到端复跑

本轮尝试使用 devserver Rootless Buildx 重建候选时，Docker Hub 的 Dockerfile frontend 与 `node:22-trixie` 元数据请求均超时，基础镜像构建尚未开始。没有切换到 Rootful daemon、修改代理或服务配置，也没有触发 GitHub CI。此次创建的 `/tmp/gugu-phase1-validation.*` 临时源码目录已删除；未创建候选镜像标签，既有 runtime 镜像未删除，磁盘可用空间回到构建前的 11 GB。

因此，候选验证器的新宿主侧导入及 Shell smoke 已由单测覆盖，隔离 Shell 命令已在现存 Rootless runtime 镜像上实测；这轮没有用新验证器完整重跑 app 候选镜像。后续经授权触发候选 workflow 时会在候选 job 中执行该集成 smoke，并记录实际 registry 压缩增量。
