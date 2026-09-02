# 前端文档

前端实现规则、设计约束和专项方案统一放在本目录，按主题分类维护。

## 分类

| 目录 | 内容 | 入口 |
| --- | --- | --- |
| `SYNC.md` | 本地交互、乐观更新、Live 事件和跨客户端对账 | [同步文档](./SYNC.md) |
| `en/SYNC.md` | English version of the interaction sync guidelines | [Interaction sync](./en/SYNC.md) |
| `SECURITY.md` | 前端输入、HTML、凭据、权限和敏感数据边界 | [安全文档](./SECURITY.md) |
| `en/SECURITY.md` | English version of the frontend security guidelines | [Security](./en/SECURITY.md) |
| `DESIGN.md` | token 分层与新增流程、组件选型、主题动效、可访问性和 `/design` 查看边界 | [设计文档](./DESIGN.md) |
| `en/DESIGN.md` | English version of the frontend design guidelines | [Design guidelines](./en/DESIGN.md) |
| `ARCHITECTURE.md` | 页面、组件、composable、store 和 service 的职责边界 | [架构文档](./ARCHITECTURE.md) |
| `en/ARCHITECTURE.md` | English version of the frontend architecture guidelines | [Architecture](./en/ARCHITECTURE.md) |
| `TESTING.md` | 类型检查、单元测试、回归测试和浏览器验收 | [测试文档](./TESTING.md) |
| `en/TESTING.md` | English version of the frontend testing guidelines | [Testing](./en/TESTING.md) |

## 维护规则

- 只影响一个主题的内容放入对应文档，不在本 README 重复展开。
- 跨主题的方案在这里提供入口，并在正文中链接相关规则文档。
- 已完成的实施记录放入 `docs/devlog/`；产品级需求放入 `docs/prds/`。
- 新增文档使用英文大写文件名，直接放在本目录根目录，并同步更新本 README。
- 英文翻译统一放在 `docs/frontend/en/`，文件名与中文主文档保持一致；修改中文文档后同步检查英文版。
