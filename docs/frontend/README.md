# 前端文档

前端实现规则、设计约束和专项方案统一放在本目录，按主题分类维护。

## 分类

| 目录 | 内容 | 入口 |
| --- | --- | --- |
| `SYNC_RULES.md` | 本地交互、乐观更新、Live 事件和跨客户端对账 | [同步规则](./SYNC_RULES.md) |
| `SECURITY_RULES.md` | 前端输入、HTML、凭据、权限和敏感数据边界 | [安全规则](./SECURITY_RULES.md) |
| `DESIGN_RULES.md` | token 分层与新增流程、组件选型、主题动效、可访问性和 `/design` 查看边界 | [设计规则](./DESIGN_RULES.md) |
| `ARCHITECTURE_RULES.md` | 页面、组件、composable、store 和 service 的职责边界 | [架构规则](./ARCHITECTURE_RULES.md) |
| `TESTING_RULES.md` | 类型检查、单元测试、回归测试和浏览器验收 | [测试规则](./TESTING_RULES.md) |

## 维护规则

- 只影响一个主题的规则放入对应文档，不在本 README 重复展开。
- 跨主题的方案在这里提供入口，并在正文中链接相关规则文档。
- 已完成的实施记录放入 `docs/devlog/`；产品级需求放入 `docs/prds/`。
- 新增规则使用英文大写文件名，直接放在本目录根目录，并同步更新本 README。
