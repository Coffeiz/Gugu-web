# Monorepo 账号架构与 API

当前已接入 Auth 的登录、会话状态校验、撤销和远程登录客户端。找回密码和登录邮箱变更的验证规则已接入 Auth。Users 已实现公开资料投影、资料更新和头像上传服务，Web Host 已通过端口接入。资料和头像使用 Users 路由，凭据操作使用 Auth 路由。会话格式和数据库结构沿用现有实现。

## 目录与依赖

```text
packages/
├── auth/         登录、凭据验证、会话与密码的公开契约
├── users/        用户资料与头像的公开契约
├── core/         项目、会话、文件与 Agent 等业务能力
└── database/     表结构、迁移与事务持久化
apps/
├── web-host/     账号用例、服务装配、身份验证与 HTTP 接口
└── desktop/      远程登录客户端、本机凭据与本地业务身份
```

Web Host 通过包根入口导入 `@gugu/auth` 和 `@gugu/users`。两个包之间通过宿主注入所需能力，避免相互导入内部实现。Auth 获取可信账号状态，Users 接收已验证的用户身份。数据库适配器负责事务和存储约束。Core 继续以可信 `ownerId` 对业务数据做归属隔离。Desktop 的本地 owner 由本地宿主确定，远程账号会话用于访问对应服务器。

账号创建、管理员停用和注销由 Web Host 的账号用例协调。账号停用必须使后续认证失败，并使已有会话失效。改密成功后更新凭据并撤销旧会话，是否续发当前会话由产品规则与现有客户端兼容性决定。

## API 入口

包的职责、公开函数和 HTTP 接入状态分别维护在 [Auth README](../../packages/auth/README.md) 与 [Users README](../../packages/users/README.md)。

## 迁移与验收

1. 登录、验证与撤销流程已接入 Auth。远程协议及客户端已迁出 Core，BYOK 和远程搜索通过宿主注入已认证请求。资料更新已迁到 Web Host，改密规则已迁入 Auth。账号注销已迁到 Web Host。
2. 保持现有数据库结构，通过仓储接口分隔凭据写入、资料写入和账号状态检查。按现有路由逐个替换实现，联合验证登录、资料字段兼容和会话失效。
3. 将改密与资料更新拆成独立命令，接入新的资料路由后再迁移 Web 和 Desktop 调用方。Node Host 已移除旧资料和头像路由。

验收覆盖跨用户资料写入被拒绝、头像更新不会改变会话、改密或停用后旧会话不可用，以及 Desktop 离线时仍可访问自身本地业务数据。

桌面账号 IPC 的类型组合已迁入 [Desktop Contracts](../../packages/desktop-contracts/README.md)，Core 已移除 Auth 包依赖。
