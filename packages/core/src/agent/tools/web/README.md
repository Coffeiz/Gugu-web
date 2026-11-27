# 网页读取与下载工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

宿主在打开公网流之前校验网络目标、容量及文件落点。响应区分正文结果、单项失败与取消；下载写入使用当前可信文件范围。

## 工具契约

### `http_get`

读取公网 URL 正文；单次最多并行读取 5 个 URL，不跟随重定向。

实现与返回契约见 [createHttpGetTool](./tools.ts#L181)。执行类型为 `read`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `url` | 否 | `type='string'` |
| `urls` | 否 | `type='array'`，`minItems=1`，`maxItems=5`，`items={ type: 'string', minLength: 1 }` |
| `max_chars` | 否 | `type='integer'` |
| `headers` | 否 | `type='object'` |

### `web_download`



实现与返回契约见 [createWebDownloadTool](./tools.ts#L309)。执行类型为 `write`。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `url` | 是 | `type='string'`，`minLength=1` |
| `file_name` | 否 | `type=['string', 'null']` |
