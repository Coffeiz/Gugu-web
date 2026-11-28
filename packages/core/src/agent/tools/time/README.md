# 时间工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

结果使用可信时钟和时区。该工具不接受用来选择 owner 的参数。

## 工具契约

### `get_current_time`

获取当前日期、星期和时间。

实现与返回契约见 [createTimeTool](./index.ts#L28)。执行类型为 `read`。

无输入字段。
