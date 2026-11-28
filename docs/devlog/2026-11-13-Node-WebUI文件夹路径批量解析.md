# Node WebUI 文件夹路径批量解析

## 范围

接入认证后的 `POST /api/v1/folders/resolve-paths`，供上传批次按需查找已有目录前缀。Node route 保持 Python 请求预算和路径规则；PostgreSQL adapter 在 owner、项目/Workspace 和可选父目录范围内逐层查找，不枚举完整目录树，并只返回实际匹配的节点。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- Node 文件域 `tests/files/*.test.ts`：**67/67 通过，0 跳过**；包含隔离 PostgreSQL 的嵌套路径、缺失前缀和越权父目录回归，以及认证 route 的危险路径拒绝。
- Python 文件夹 API 基线：**14 项通过**，串行运行。
- 所有测试在 devserver 原生环境执行；未使用 Docker。

## 边界

尚未做真实用户 Vite 上传登录态验收；未触发 CI，未提交代码。
