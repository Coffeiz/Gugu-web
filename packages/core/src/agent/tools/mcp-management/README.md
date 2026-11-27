# MCP 管理工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

返回脱敏的服务器配置和连接状态。启停、更新、创建和删除按各自操作分支校验；动态凭据通过宿主私密表单收集。成功结果及错误按操作分支投影。

## 工具契约

### `manage_mcp_servers`



实现与返回契约见 [createMcpManagementTool](./index.ts#L106)。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `action` | 是 | `type='string'`，`enum=actions` |
