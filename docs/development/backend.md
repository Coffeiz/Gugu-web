# 后端开发约定

- Python 导入按标准库/第三方/本地模块分组；`from` 导入在前，普通 `import` 在后，并保持可读的字母顺序。
- 复杂逻辑保留或补充注释和类型注解；参数化泛型使用 `typing` 模块。
- 已确定类型的变量直接访问属性，少用不必要的 `getattr`、`setattr` 和 `or` 兜底。
- 业务时间统一使用 `app.core.tz.now_utc()`；存储 UTC，展示时按用户时区转换。
- 前后端 API 请求体遵循模型实际声明：`CamelModel` 使用驼峰字段，普通 `BaseModel` 使用下划线字段。
- API、业务服务、Agent、数据库模型和任务按现有目录分层，不跨层复制逻辑。
- API 请求/响应沿用现有 Pydantic 命名规则、归属校验和确认门。
- 用户输入、异常和上游响应不得进入可见日志；错误使用脱敏出口，原始诊断使用受限诊断日志。
- 时间统一使用 UTC 工具；跨用户数据查询使用统一 ownership helper。
- 外部请求设置超时、重试边界和 URL 安全校验，不盲目重试非幂等操作。
- 后端修改后在 devserver 运行对应 pytest；涉及权限、删除或工具确认时运行额外静态检查。

## 本地验证

- 本地编辑后通过 Mutagen session `gugu-web` 同步到 devserver。
- Web 使用 `cd backend && make dev-web`；Worker 使用 `make dev-worker`，启动前确保没有重复 Worker。
- 生产环境执行 `make install` 后，`make start`、`make stop`、`make restart`、`make status` 会自动管理并检查 `gugu-backend`、`gugu-worker` 和 `gugu-supervisor` 三个 systemd 服务；启动/重启后需连续多次确认三个服务均为 `active`，任一服务不稳定都会返回失败。需要强制使用本地 PID 模式时设置 `GUGU_SERVICE_MODE=local`。
- 改动网关适配器时只重启对应平台子进程，不重启整个 supervisor。
