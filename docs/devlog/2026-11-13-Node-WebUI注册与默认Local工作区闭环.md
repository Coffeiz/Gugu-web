# Node WebUI 注册与默认 Local 工作区闭环

## 范围

补充注册路径的跨层回归：Vite 将 WebUI 注册请求代理至 Node Host，注册成功后设置 cookie 会话，并通过 `/auth/me` 与工作区目录 API 读取权威状态。注册事务同时创建用户 locale 偏好、默认工作区目录和 Local workspace 绑定。

Node 尚未迁移 Python 的可选 onboarding seed。本切片将该 best-effort 回调设为空操作，因此不覆盖欢迎项目、日历事件、引导文件或音频资源的创建；注册成功不依赖这些可选种子数据。

## 验证

所有行为测试均在 devserver 原生运行，未使用 Docker：

- Node 注册 Vite/Host 集成、PostgreSQL 注册事务和 `/auth/me` 路由：7 项通过，0 跳过。
- Node TypeScript 类型检查：通过。
- Python 工作区目录、规范挂载和注册安全回归：26 项通过，13 项按本次筛选未执行。

测试使用隔离 PostgreSQL schema 与临时 Local 根目录；不会访问用户业务表或部署存储。Vite 配置在没有 Git 元数据的同步工作树中输出版本探测错误，但 HTTP 集成路径仍完整通过。

## 后续边界

Python 没有单独覆盖完整注册成功 HTTP 路径的现成回归用例；本次以 Node Vite/Host 集成验证目标路径，并以 Python 工作区与注册安全回归作为兼容基线。Node SMTP 验证码和可选 onboarding seed 的等价迁移仍需单独补齐。
