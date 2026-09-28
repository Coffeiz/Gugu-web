# PRD-DEPLOY-2 Phase 1.8.2：内置管理器入口生命周期与故障隔离

## 问题

embedded manager 的 supervisor 配置原本内联在完整 Docker entrypoint 中。入口先执行数据库启动、数据目录守卫和迁移，直接运行会触碰 `/run`、`/data` 等真实路径，无法安全地在普通 pytest 中验证 manager 的启动/失败分支。Shell 的 socket 未配置和客户端断连需要始终 fail-closed，不能改走本机执行器。

## 修复

- 将现有 supervisor 配置与启动流程抽为 `start_embedded_sandbox_manager.sh`，由镜像入口调用；独立 supervisor 管理 sandboxd，入口只接收其 PID 用于关闭，不把它加入 Web/数据库关键 PID 集合。
- helper 校验 supervisor 返回有效 PID；supervisor 启动失败时由入口记录 Shell 不可用并继续启动 Web/数据库。
- 用 `tmp_path` 和 mock `supervisord` 执行 helper，验证目录隔离、sandboxd 配置、PID 返回和启动失败，不触及宿主运行目录。
- 补充 Shell 回归：sandboxd Socket 缺失、客户端不可用、Docker daemon 不可用或内置 bundle image ID 校验失败时，明确拒绝执行且不回退本机执行器。

## 验证

- `tests/test_docker_runtime.py`、`tests/test_embedded_deps_contract.py`、`tests/test_unified_image_sandbox_boundary.py`、`tests/test_shell_policy.py`：153 项通过。
- `bash -n backend/docker-entrypoint.sh backend/scripts/runtime/start_embedded_sandbox_manager.sh` 与 `git diff --check` 通过。
- 未运行完整容器入口、未触碰 `/run/gugu`/用户数据、未构建镜像或触发 GitHub CI。
