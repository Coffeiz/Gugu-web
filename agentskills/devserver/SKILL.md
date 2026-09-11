---
name: devserver
description: devserver 部署与运维。Mutagen 同步、SSH 连接、systemd 服务管理、前端 dev server、loopscope 启动。部署和同步操作前参考。
---

# Devserver 运维

## 基本信息

- 地址：`192.168.110.51`，用户 `coffeiz`
- 工作目录：`~/文档/Workspace/Gugu-web`（后端）、`~/gugu-wt`（旧路径别名）
- sudo 方式：`echo "password" | sudo -S`（无 TTY 环境）

## Mutagen 同步

本地编辑后通过 Mutagen session `gugu-web` 自动同步到 devserver，不在本地直接启动完整服务。

- 前端 UI 修改优先在 devserver 浏览器验证
- 类型或接口修改运行 typecheck
- 同步有冲突时检查 devserver 上是否有临时文件（`._` 资源文件、`.venv`、`__pycache__`）需清理

## Systemd 服务

生产环境使用 `make install` 后：
- `make start/stop/restart/status` 管理三个服务：`gugu-backend`、`gugu-worker`、`gugu-gateway`
- 启动/重启后需确认三个服务均为 `active`
- 修改网关适配器时只重启对应平台子进程，不重启整个 gateway

devserver 上共四个单元：`gugu-sandboxd`、`gugu-backend`、`gugu-worker`、`gugu-gateway`（sudo 精准重启白名单见 local skill）。改动代码后按涉及面重启：

- 普通 backend / agent 代码 → `gugu-backend`，涉及异步任务再加 `gugu-worker`
- **`agent/sandbox/**`（沙盒执行器、命令解析与校验）→ 必须 `gugu-backend` + `gugu-sandboxd` 一起重启**：shell 命令的 argv 解析、元字符/解释器校验发生在 sandboxd 进程内，只重启 backend 会出现「backend 已放行、sandboxd 仍按旧代码拦截」的半新半旧状态（2026-09-10 直跑运行时元字符放行首次踩中，症状是开关生效但 `python3 -c` 带 `;` 仍报「不支持管道」）

## 前端 Dev Server

启动 loopscope 前端：
```bash
cd ~/文档/Workspace/Gugu-web/loopscope/frontend
nohup npx vite --host 0.0.0.0 --port 4319 > /tmp/loopscope-dev.log 2>&1 &
```
访问：`http://192.168.110.51:4319/`

## Runtime 依赖

Gugu-web 通过 npm 依赖使用已发布的 `gugu-interaction-runtime`，版本由
`frontend/package.json` 和仓库锁文件共同锁定。升级 Runtime 后更新依赖并重新安装：
```bash
cd ~/文档/Workspace/Gugu-web
corepack pnpm --dir frontend update gugu-interaction-runtime
```

## 后端测试

在 devserver 上运行：
```bash
cd ~/文档/Workspace/Gugu-web/backend
PYTHONPATH=. .venv/bin/pytest
```
