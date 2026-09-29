# PRD-DEPLOY-2 Phase 1.8.3：执行隔离与资源清理回归

## 范围

复核一体化 Sandbox 执行器的隔离、镜像固定与临时容器回收边界；生产执行逻辑此前已实现，本阶段补齐“普通执行超时后清理当前容器”的直接回归测试。

## 已验证边界

- 普通执行使用 `network=none`；egress 只能加入配置的隔离网络并注入受控代理。
- 内置 bundle 校验归档 SHA-256、镜像 digest 与 image ID；embedded 执行使用 manifest 中验证过的镜像 ID。
- 执行容器有唯一名称和 `--rm`；超时路径额外按该名称执行 `docker rm --force`，sandboxd 启动清理遗留 PTY 容器。
- 执行容器只挂载授权 workspace/personal/project 路径，不挂载 Docker Socket；固定安全 argv 同时限制特权、Linux capabilities、只读根目录和资源上限。

## 验证

- 新增超时回归：mock Docker CLI 进程超时，确认执行进程组被终止，并对同一个唯一临时容器执行强制移除。
- 定向测试：`tests/test_docker_runtime.py`、`tests/test_embedded_deps_contract.py`、`tests/test_unified_image_sandbox_boundary.py`、`tests/test_shell_policy.py`、`tests/test_bundle_runtime.py`、`tests/test_offline_bundle.py`、`tests/test_mcp_stdio.py`、`tests/test_mcp_stdio_quota.py`、`tests/test_sandbox_compound_shell.py`：189 项通过。
- `git diff --check` 与质量门通过；本地未连接 Docker daemon，因此没有声称真实容器集成已验证，留待 fnOS 验收。
