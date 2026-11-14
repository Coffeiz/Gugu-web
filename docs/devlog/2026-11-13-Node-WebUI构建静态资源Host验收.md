# Node WebUI 构建静态资源 Host 验收

## 范围

验证 Node Host 可直接承载主站与 Admin 的真实 Vite 构建产物，并保留 SPA 历史路由和 API 404 边界。该路径复用 WebUI 共用的 Vue 构建结果；Python API 没有对应的静态文件路由，因此这里以 Vite 构建产物和 Node Host 行为作为基线。

## 验证

所有构建与运行检查均在 devserver 原生完成，未使用 Docker：

- Vite 生产构建生成主站和 Admin 两个入口。
- Node Host 对构建产物请求 `/`、`/admin`、`/projects/42` 均返回 HTML，并能读取页面引用的构建 JS。
- `/version.json` 返回 JSON；缺失 `/api/v1/*` 保持 404，不会被 SPA fallback 吞掉。
- `gugu-webui/tests/host/static-files.test.ts`：1/1 通过，覆盖主站/Admin 入口、历史路由、静态文件和 API/资源 404 边界。
- devserver 当前 Vite 入口 `/` 返回 200；`/api/v1/site-config` 经代理返回 200，未认证的 `/auth/me` 和工作区目录请求返回 401。

构建输出写入唯一临时目录并在 smoke 后删除；Vite 插件写入的既有 `frontend/dist/version.json` 已恢复。Vite 配置因同步工作树没有 Git 元数据而输出版本探测提示，不影响构建或 Host smoke。

## 边界

Node Host 对临时构建产物的 Fastify 注入路径已验证；本轮没有重启 devserver Node 服务，也没有验证 Docker 镜像装配。部署镜像通过 Dockerfile 复制 `frontend/dist` 的路径仍需在禁止 Docker 的前提下做构建上下文/产物布局核查，不能把本次 Host smoke 当成镜像验收。
