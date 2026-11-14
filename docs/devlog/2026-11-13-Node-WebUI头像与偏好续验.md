# Node WebUI 头像和偏好续验

## 范围

复验用户头像读写和通用偏好 API 的 Host 接线、owner 约束与 PostgreSQL 存储。devserver 已运行 Node `v26.13.1`；本轮不需要再次升级运行时。

## 验收

- Node 26 串行运行头像与偏好路由、Host 和 PostgreSQL 测试：**10/10 通过，0 跳过**。其中真实随机 PostgreSQL schema 覆盖头像上传/读取及偏好持久化/owner 隔离；测试完成后清理隔离 schema。
- Vite 代理 smoke：未认证偏好读取 **401**、未认证头像上传 **401**、合成不存在头像读取 **404**。这验证路由代理、认证门与公开头像读取路径，不代表认证后经当前 Vite 完成真实写请求。
- gugu2.0 Python 头像与偏好路由基线在 devserver 专用 pytest 环境串行 **6/6 通过**；Python 参考实现的偏好 API/cache/context 合约回归另有 **17/17 通过**。
- Mutagen `gugu2-0` 本轮同步完成；未使用 Docker，未修改运行配置，未触发 CI，未提交。

## 结论与剩余边界

头像与通用偏好已接入 Node Host 和 PostgreSQL；偏好详细契约及已知不支持的设置范围见[用户偏好路径闭环](./2026-11-13-Node-WebUI用户偏好路径闭环.md)。本轮只做 Vite 未认证 smoke，没有认证态浏览器写入验收。Node WebUI 其他尚未迁移的 API、Agent 运行时和 Python Worker 不在本切片范围内。
