# 邮箱

`@gugu/email` 是 Gugu monorepo 内的独立工作区包。它定义邮箱账户和命令，编排多账户收件箱，并封装 IMAP、SMTP 与 MIME 操作。Web Host 和桌面主进程分别负责身份、凭据存储和错误映射。

咕咕对话中的邮件查询、草稿、发送确认与模板见[邮件工具说明](../core/src/agent/tools/email/README.md)。

## 目录与架构

| 模块 | 职责 |
| --- | --- |
| `src/contracts.ts` | 账户、消息、附件、命令的类型与 Zod 校验，服务商连接预设 |
| `src/service.ts` | 使用可信 owner 查找账号，验证后保存，聚合收件箱、处理分页及发送去重 |
| `src/transport.ts` | IMAP 文件夹和消息读写、SMTP 验证与投递、MIME 解析与组装 |
| `apps/web-host/src/modules/mail/` | 受认证的 HTTP 入口、按 owner 隔离并加密的账户文件、发送回执 |
| `apps/desktop/src/main/mail/` | 桌面 IPC、系统安全存储、串行账户写入及咕咕邮件发送适配 |
| `apps/ui/src/shared/views/Mail/` | Web 与桌面共用账户栏、添加弹窗、收件列表、阅读和写信 |

数据流为 UI → Web Host HTTP 或桌面 IPC → 邮箱服务 → 宿主存储与协议适配器。包本身无数据库、Electron、Fastify 或 Core 依赖。前端仅导入 `@gugu/email/contracts`，不加载 Node 邮件协议代码。

宿主传入的 `MailStore` 提供 `list`、`get`、`put`、`remove` 和 `claimSend`。所有存储操作都按可信 owner 和账号 UUID 限定范围。发送以账号和 `attemptId` 组合记录，SMTP 结果未知时用同一请求重试不会再次投递。桌面在领取发送回执时还会核对账号配置版本。连续的 IMAP 只读操作可以复用短时连接，空闲 12 秒后关闭。发送与其他写操作使用独立连接。

`MailTransportPolicy.resolveAddress(host, port)` 必须校验地址并返回用于连接的公开 IP；协议仍使用原域名进行 TLS 校验。Web 和桌面在装配邮箱服务时注入 Core 的通用网络地址校验与邮件 HTML 清理。富文本写入通过 `sanitizeHtml` 处理，阅读区在隔离 iframe 内显示清理后的 HTML，默认阻止远程资源，可按单封邮件手动加载 HTTPS 图片，宿主校验并固定目标地址后返回图片数据；纯文本邮件直接显示正文。附件字节经用户明确操作后保存到个人文件。

## 包 API

邮箱包提供以下公开导入路径。应用通过这些入口调用包，HTTP 和 IPC 的操作见下文「命令和字段」。

### `@gugu/email/cached-service` 与 `@gugu/email/read-cache`

`createCachedMailService` 提供 `execute(owner, command)` 和 `listForAgent(owner, query, signal)`。页面与工具共享正文和摘要，列表、分页、搜索与已读标记仍通过 IMAP。缓存按宿主传入的可信 owner 隔离，按账号配置、邮箱、UIDVALIDITY 和 UID 匹配。正文缓存最长七天，每个 owner 最多 32 封、约 20 MB；断开或重新连接邮箱时清理该账号的缓存。

`createMailReadCache` 接收按 owner 读写缓存条目的端口。Desktop 复用已有的加密存储，Web Host 按 owner 分开加密并原子写入。

### `@gugu/email/contracts`

此入口可供浏览器和 Node.js 使用。

| 导出 | 用途 |
| --- | --- |
| `mailPresets` | QQ、163、126、Yeah 和 iCloud 的 IMAP 主机、SMTP 主机与端口预设 |
| `mailAccountInput` | 验证添加或重新连接时提交的账户字段 |
| `mailStoredAccount` | 验证存储记录，在账户输入字段上增加 UUID `id` |
| `mailCommand` | 按 `action` 校验命令和参数，可用 `.safeParse(input)` 进行非抛出式校验 |
| `summarizeMailAccount(account: MailAccount): MailAccountSummary` | 剔除 IMAP 和 SMTP 密码，生成可返回给前端的账户摘要 |
| `MailAccount`、`MailAccountSummary` | 含凭据的内部账户记录、对外账户摘要 |
| `MailCommand`、`MailDraft` | 命令联合类型、草稿与发送内容 |
| `MailFolder`、`MailMessage`、`MailPage` | 文件夹、邮件摘要和单文件夹分页结果 |
| `MailLocatedMessage`、`MailInbox` | 带账户和文件夹定位信息的邮件、聚合收件箱结果 |
| `MailRead`、`MailAttachment` | 正文及附件列表、下载附件时返回的文件名和 Base64 数据 |

### `@gugu/email/service`

`createMailService(store: MailStore, transport: MailTransport)` 返回异步命令处理函数 `execute(owner, input, canSend?)`。调用方提供认证后的 `owner` 和待校验的 `input`，按命令读取返回值。可选的 `canSend(account: MailAccount): boolean` 在领取发送回执前检查当前账户，适合核对发送确认时使用的账户配置。

| 宿主接口 | 签名与行为 |
| --- | --- |
| `MailStore.list` | `(owner: string) => Promise<MailAccountSummary[]>`，列出当前用户的账户摘要 |
| `MailStore.get` | `(owner: string, id: string) => Promise<MailAccount \| null>`，读取带内部凭据的账户 |
| `MailStore.put` | `(owner: string, account: MailAccount) => Promise<void>`，保存已验证的账户 |
| `MailStore.remove` | `(owner: string, id: string) => Promise<void>`，移除账户凭据 |
| `MailStore.claimSend` | `(owner: string, accountId: string, attemptId: string, expectedAccount?: MailAccount) => Promise<boolean>`，原子领取发送回执，重复领取返回 `false` |
| `MailTransport.verify` | `(account: MailAccount) => Promise<void>`，验证账户的连接配置 |
| `MailTransport.execute` | `(account: MailAccount, command: MailOperation) => Promise<unknown>`，执行协议命令 |

`MailOperation` 是传给协议层的命令类型，账户列表、聚合收件箱、连接和断开由服务层处理。`MailError.status` 用于宿主映射错误，支持 `400` 参数无效、`404` 资源缺失、`409` 状态冲突和 `502` 邮件服务操作失败或结果未确认。

### `@gugu/email/transport`

`createMailTransport(policy: MailTransportPolicy): MailTransport` 创建 Node.js IMAP/SMTP 协议适配器。宿主必须提供两项策略。

| 策略 | 签名与行为 |
| --- | --- |
| `resolveAddress` | `(host: string, port: number) => Promise<string>`，校验目标并返回用于连接的 IP |
| `requestImage` | 可选的宿主 HTTPS 图片请求，复用受校验的桌面代理和 DNS 策略 |
| `sanitizeHtml` | `(html: string, preserveRemoteImages?: boolean) => string`，清理 HTML；读取时可把远程图片保留为惰性属性 |

```ts
import { createMailService, type MailStore } from '@gugu/email/service'
import { createMailTransport, type MailTransportPolicy } from '@gugu/email/transport'

export function createMailCommandHandler(store: MailStore, policy: MailTransportPolicy) {
  return createMailService(store, createMailTransport(policy))
}
```

## 账户字段

| 字段 | 格式 | 行为 |
| --- | --- | --- |
| `id` | UUID | 宿主内业务 ID；新增时生成，重连沿用 |
| `email` | 邮箱地址，最多 254 字符 | 账户地址和发件地址 |
| `displayName` | 可选，最多 80 字符 | 账户栏和聚合列表名称，留空显示邮箱地址 |
| `senderName` | 可选，最多 80 字符 | 邮件 From 的显示名，留空使用裸地址 |
| `username` | 1–254 字符 | IMAP 登录名，表单默认使用邮箱地址 |
| `password` | 1–512 字符 | IMAP 授权码或应用专用密码，需要发送时也可复用于 SMTP |
| `imapHost` | 主机名，最多 253 字符 | IMAP 固定使用 TLS 993 |
| `smtpHost` | 主机名，最多 253 字符 | 可发送账户必填，仅收件账户保存为空字符串 |
| `smtpPort` | `465` 或 `587` | 分别对应 TLS 和强制 STARTTLS，仅收件账户忽略 |
| `smtpUsername` | 可选，1–254 字符 | 独立 SMTP 登录名，省略时复用 IMAP 登录名 |
| `smtpPassword` | 可选，1–512 字符 | 独立 SMTP 授权码，省略时复用 IMAP 授权码 |
| `receiveOnly` | 可选布尔值，旧账号等同于 false | 开启时只验证 IMAP，清除独立发件凭据，发送命令会拒绝 |

账号摘要排除两种密码。两种密码仅通过连接命令输入，并由宿主加密保存。邮箱服务商是表单预设，邮箱域名用于推荐；它填入服务器名和 SMTP 端口，账号记录只保存实际连接参数。当前预设包括 QQ、网易 163、126、Yeah 和 iCloud，其他服务商手动填写。此版本使用 IMAP/SMTP 凭据连接，OAuth 尚未接入。

## 命令和字段

Web 使用 `POST /api/v1/mail/command`，桌面通过受信任的邮箱 IPC。命令体含 `action`。

| action | 附加字段 | 返回值与行为 |
| --- | --- | --- |
| `accounts` | 无 | 当前用户的账号摘要数组 |
| `connect` | `account`、可选 `accountId` | 测试连接后保存，返回摘要；传 UUID 时为重连 |
| `disconnect` | `accountId` | 移除宿主内账户凭据，返回 `ok` |
| `folders` | `accountId` | 文件夹数组，字段为 `path`、`name`、可空 `specialUse` |
| `messages` | `accountId`、`mailbox`、可选 `query`、`before` | 默认每页 30 封。无搜索的第一页直接读取文件夹末尾，搜索与翻页按 UID 处理。返回 `validity`、`items` 和下页 UID `next` |
| `inbox` | 可选 `query`、`before` | 查询所有账号的 INBOX，每批最多 4 个账号并行；返回按时间排序的 `items`、`unavailableAccountIds` 和 `next` |
| `read` | `accountId`、邮件引用、可选 `remoteImages` | 邮件摘要加 `text`、可选的清理后 `html`、失败图片数 `unavailableImages` 和 `attachments` 文件名数组 |
| `attachment` | `accountId`、邮件引用、`index` | 返回安全文件名 `name` 和 Base64 `data`，索引为 0–49 |
| `seen` | `accountId`、邮件引用、`seen` | 更新已读状态，返回 `ok` |
| `move` | `accountId`、邮件引用、`target` | 移到 `archive`、`trash` 或 `inbox`，取决于服务商文件夹和协议支持 |
| `draft` | `accountId`、`draft`、可选邮件引用 `replace` | 写入对应账户的草稿文件夹，可替换原草稿 |
| `send` | `accountId`、`draft`、UUID `attemptId`、可选邮件引用 `replyTo` | 提交 SMTP，返回 `messageId` 和是否部分成功的 `partial` |

邮件引用是 `mailbox`（1–512 字符）、`uid`（IMAP 32 位正整数）、`validity`（最多 24 位数字）。聚合列表额外为每封邮件附上 `accountId`、`mailbox` 和 `validity`，保证两个账号有相同 UID 时仍能正确读取、标记、移动或回复。邮件摘要还包含 `subject`、`from`、可选 `fromName`、`replyTo`、`to`、可空 ISO 日期 `date`、`seen`。两个列表端点的 `query` 最多 120 字符。聚合分页的 `before` 和 `next` 是账户 UUID 到 UID 的映射，不传 `before` 会重新读取所有账号的新页。

`draft` 包含 `to`（最多 20 个邮箱地址，发送时至少一个）、`subject`（最多 998 字符）、`text`（最多 100,000 字符）、可选 `html`（最多 40,000 字符）和 `attachments`。附件使用 `filename`、`content`（Uint8Array）、`mimeType`、可选 `cid`。最多 5 个普通附件和 2 个内嵌附件，每个最多 10 MiB，总量最多 25 MiB；内嵌 CID 必须唯一。阅读和下载当前有 4 MiB 原始邮件大小限制。

## 页面设计

- 顶栏放当前范围搜索、刷新和写邮件。左栏为全部收件箱、账户、当前账户文件夹和添加入口；中栏显示发件人、主题、时间、未读和收件账号；右栏为正文、附件、回复和转发。
- 窄窗口使用列表和阅读两页切换。账户与文件夹收进列表页上方。
- 添加邮箱使用居中弹窗，先显示邮箱地址、服务商、授权码、账户名称。服务器设置区可填写登录名、收发服务器、发件人名称和独立发件凭据，支持明确选「仅接收邮件」。
- 回复与编辑草稿锁定原账号。新写邮件可选发件账号，并可记为本浏览器或本桌面窗口的默认；记录仅存 UUID，使用前会核对当前账号列表。选中可发信的账号文件夹时，优先采用当前账号。
- 聚合视图按需访问邮件服务并提供刷新和分页，账号读取失败单独提示。列表优先显示当前会话的缓存，并后台刷新。桌面正文保存在加密缓存中，最多 32 封、有效期 7 天，按账户配置和 IMAP 的文件夹、UIDVALIDITY、UID 隔离。远程图片和背景图仅在主动点击后读取，成功结果随桌面正文加密缓存。桌面从已缓存的正文补齐缺失图片；单次最多处理 64 个地址、单张原图最多 5 MiB，编码后总量最多 12 MB；桌面会缩小大幅 JPEG 或 PNG，忽略 1×1 图片。当前没有后台同步、跨设备默认发件设置或精确的全账号未读计数。

## 数据兼容与定时任务

旧邮箱记录已支持多账户，原 UUID、凭据和服务商设置可以直接读取。新字段均可省略，本次无需搬迁或重新加密原账户文件。用户重新连接时，验证成功后才替换记录。

个人 SMTP 设置与邮箱账号存储是两个入口。当前定时邮件继续使用原有个人 SMTP 或宿主 SMTP，邮箱页面的默认发件账号不会改变既有任务发件配置。将来若允许任务选邮箱账号，应在任务上保存显式账号 ID，并在账号断开时显示需要重新绑定。

## 开发验证

```sh
corepack pnpm --filter @gugu/email build
corepack pnpm --filter @gugu/email test
```

## 桌面 OAuth 邮箱

桌面进程读取以下环境变量。新账号入口暂用 IMAP/SMTP 密码连接。以下配置供后续启用 OAuth 和已有 OAuth 账号重新授权使用。OAuth 使用系统浏览器和随机端口的回环回调。

- Outlook / Microsoft 365 设置 `GUGU_OUTLOOK_OAUTH_CLIENT_ID`。在 Microsoft Entra 注册移动和桌面应用，将 `http://localhost/mail/oauth` 配置为桌面重定向 URI。要支持 Outlook.com 和工作或学校账号，应用注册需同时允许个人 Microsoft 账号与组织账号。委托权限包括 `IMAP.AccessAsUser.All`、`SMTP.Send`，授权时请求 `offline_access`。组织可能要求管理员同意或启用邮箱的 SMTP AUTH。
- Gmail 设置 `GUGU_GMAIL_OAUTH_CLIENT_ID`，使用 Google Cloud 的桌面客户端凭据。需要客户端密钥时，在桌面进程环境提供 `GUGU_GMAIL_OAUTH_CLIENT_SECRET`。使用 `https://mail.google.com/` 权限，公开分发前须按 Google 要求完成审核。

访问令牌仅在主进程内存中使用，刷新令牌与其他邮箱凭据一起加密保存。邮箱工具沿用现有发送确认流程。Web 邮箱继续使用现有连接方式。
