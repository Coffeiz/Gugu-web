# Admin 沙盒状态误探测 backend Docker

## 背景

分体部署中，backend 与 sandboxd 可以挂载不同的 Docker daemon：backend 使用普通 Docker socket，sandboxd 使用 Rootless Docker socket。Shell readiness 通过 sandboxd 查询执行状态，但 Admin 状态页曾直接在 backend 进程中探测 Docker，导致后台显示“Rootless 未启用、执行器不可用”，而咕咕仍能执行 Shell。

## 调整

- sandboxd 的 `status` 响应增加其实际持有 daemon 的 Docker 安装、daemon 就绪、Rootless、版本和固定镜像状态。
- 配置了 sandboxd 时，Admin 状态页读取 sandboxd 的结构化状态；sandboxd 无响应或使用旧协议时显示状态不可用，不回退探测 backend 的另一套 Docker。
- 未配置 sandboxd 的独立部署仍使用本地 Docker 探测，保持原有行为。

## 验证

- `PYTHONPATH=. .venv/bin/pytest -q tests/test_docker_runtime.py`：68 passed。
- 后端全量 `PYTHONPATH=. .venv/bin/pytest -q`：3478 passed、2 failed；失败为日历提醒日期边界和记忆周期调度测试，单独复跑仍失败，与本次沙盒状态改动无关。
- `.venv/bin/python -m compileall -q app agent` 与 `git diff --check`：通过。

未部署；改动保留在本地工作区。
