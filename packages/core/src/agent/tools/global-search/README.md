# 站内搜索工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

搜索结果按业务来源分组，来源可用性由宿主提供。调用只检索当前 owner 可见资源。

## 工具契约

### `global_search`

跨项目、文件、日程、联系人、对话、便签和当前用户 Skill 按关键词搜索。需要找任意文件或文件夹时，仅指定 types 为 file 和/或 folder 即可浏览有限样本。Skill 结果只返回 ID、名称和描述，不返回正文或关联权限。

实现与返回契约见 [createGlobalSearchTool](./index.ts#L15)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `query` | 否 | `type='string'` |
| `q` | 否 | `type='string'` |
| `queries` | 否 | `type='array'`，`items={ type: 'string' }` |
| `mode` | 否 | `type='string'`，`enum=['OR', 'AND']` |
| `types` | 否 | `type='array'`，`items={ type: 'string', enum: [...GLOBAL_SEARCH_TYPES] }` |
