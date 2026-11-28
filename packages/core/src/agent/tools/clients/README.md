# 联系人工具

组入口见 [index.ts](./index.ts)。[工具开发规范](../README.md) 定义共同的参数校验、能力装配、授权和错误处理。

## 返回与权限

查询和更新限定当前 owner。名称歧义返回候选；删除前冻结精确目标及版本，多项一起校验。提交未知时通过调用收据恢复。

## 工具契约

### `list_contacts`

列出当前用户的所有联系人。

[字段契约](./index.ts#L23) · 见定义。

参数及返回值见上述契约和工具实现。

### `create_contact`

新建联系人，记录名称、邮箱、电话、备注。

[字段契约](./index.ts#L24) · 见定义。

| 参数 | 校验规则 |
| --- | --- |
| `name` | `z.string()` |
| `email` | `z.string().optional()` |
| `phone` | `z.string().optional()` |
| `notes` | `z.string().optional()` |

### `update_contact`

按联系人的 ID 或现有名称定位记录，修改名称、邮箱、电话或备注。

[字段契约](./index.ts#L25) · 见定义。

| 参数 | 校验规则 |
| --- | --- |
| `contact_id` | `z.number().int().safe().optional()` |
| `contact_query` | `z.string().optional()` |
| `name` | `z.string().optional()` |
| `email` | `z.string().optional()` |
| `phone` | `z.string().optional()` |
| `notes` | `z.string().optional()` |

### `delete_contact`

删除一个或多个联系人（不可恢复）。单项传 contact_id 或联系人名称 contact_query，批量传 contact_ids；执行前必须确认。

实现与返回契约见 [createClientDeleteTool](./index.ts#L269)。执行类型为 `write`。

| 参数 | 校验规则 |
| --- | --- |
| `contact_id` | `clientDeleteId.optional()` |
| `contact_query` | `z.string().optional()` |
| `contact_ids` | `z.array(clientDeleteId).max(50).refine(ids => new Set(ids).size === ids.length).optional()` |
