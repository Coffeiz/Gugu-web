# 联网搜索工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

原生搜索的 Schema 取自可信模型绑定，深度研究和相似图需要宿主配置、用量及资源读取端口。统一遵循 [执行边界](../README.md#执行边界)。

## 工具契约

### `web_search`

使用当前模型 Provider 的原生联网搜索核对资料，调用可能产生费用。引用结果时原样复制其完整 URL，保留查询参数；链接标题可以简写。

实现与返回契约见 [createWebSearchTool](./index.ts#L61)。执行类型为 `read`。

输入和结果随能力装配，见上面的工具定义。

### `deep_research`

阅读和研究外部资料，返回总结或引用。

实现与返回契约见 [createDeepResearchTool](./index.ts#L109)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `query` | 是 | `type='string'` |
| `max_results` | 否 | `type='integer'`，`minimum=1`，`maximum=20` |
| `depth` | 否 | `type='string'`，`enum=['basic', 'advanced']` |

### `similar_image_search`



实现与返回契约见 [createSimilarImageSearchTool](./index.ts#L247)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `image_url` | 否 | `type='string'` |
| `max_results` | 否 | `type='integer'`，`minimum=1`，`maximum=20` |
