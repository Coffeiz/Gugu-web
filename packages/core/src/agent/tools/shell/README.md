# Shell工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

执行范围取自可信宿主，依照沙盒、已授权工作区和系统范围分别校验。结果与错误由宿主端口按共享工具契约投影。

## 工具契约

### `shell`



实现与返回契约见 [createAgentShellTool](./index.ts#L24)。执行类型为 `write`。 执行前需要确认。

| 参数 | 必填 | 类型与约束 |
| --- | --- | --- |
| `command` | 是 | `type='string'`，`minLength=1`，`maxLength=16_384` |
| `cwd` | 否 | `type='string'`，`default='.'`，`maxLength=4096` |
| `timeout` | 否 | `type='number'`，`default=30`，`minimum=0.1`，`maximum=300` |
| `max_output_chars` | 否 | `type='integer'`，`default=12_000`，`minimum=1`，`maximum=120_000` |
