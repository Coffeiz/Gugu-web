# PRD-MAIL-1：个人邮箱接入与邮件操作

> 状态：Web 和 Desktop 已接入 IMAP/SMTP 邮箱界面与账户操作，待用真实提供商账号验收。OAuth 和咕咕邮箱工具尚未实施。
> 创建：2026-11-20  
> 最近更新：2026-11-20  
> 关联模块：`packages/core/src/agent/tools/email.ts`、`apps/web-host/src/adapters/email/smtp-email.ts`、`apps/web/src/components/common/layout/AppSidebar.vue`、`apps/desktop/src/ui/shell/components/DesktopSidebar.vue`  
> 背景参考：[Gmail 权限](https://developers.google.com/workspace/gmail/api/auth/scopes)、[Google 桌面 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[Microsoft OAuth](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)、[Microsoft Graph 权限](https://learn.microsoft.com/en-us/graph/permissions-reference)、[QQ 邮箱](https://hiflow.tencent.com/docs/applications/qq-mail/)、[网易客户端授权码](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089)、[iCloud 邮箱](https://support.apple.com/en-ie/102525)、[Yahoo 邮箱](https://help.yahoo.com/kb/imap-settings-sln4075.html)

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 既有邮件发送 | ✅ 已完成 | Core 有 `send_email` 工具，Web Host 有 SMTP 发送适配器。 |
| 双端邮箱入口与账户管理 | 🟡 部分完成 | 共用邮箱界面，Web 账户按 owner 隔离，Desktop 账户绑定本机凭据存储。 |
| IMAP 与 SMTP | 🟡 部分完成 | 已接入授权码验证、邮件查询、草稿、整理、附件保存与文本发信。已通过协议边界替身测试，真实账号收发尚待验收。 |
| Gmail 和 Outlook 授权 | 🔲 待评估 | 开发者注册、授权范围和发布方式待验证。 |

## 1. 背景与目标

用户在 Web 和 Desktop 的「联系 → 邮箱」连接自己的邮件账户，在同一页面读信、整理邮件和编写草稿。用户也可以让咕咕查询邮件、起草回复和发信。邮件服务商保存邮件与文件夹的权威状态，咕咕按需查询和分页。首版范围限定在个人邮箱与用户主动发起的操作，大批量发送、后台索引、定时自动处理和永久删除留待后续评估。

## 2. 功能需求

### FR-MAIL-01：邮箱入口与账户管理

「邮箱」与「联系人」「团队」同组。邮箱页面提供账户切换、收件箱、草稿、已发送和垃圾箱。添加账户时显示服务商和连接方式。用户可测试连接、重新授权和断开账户。断开后停止访问并清除本地凭据，服务商保留邮件和草稿。

### FR-MAIL-02：搜索、阅览与整理

支持在所选账户内分页浏览、搜索、查看正文、标记已读或未读，以及归档、移入垃圾箱和恢复。能力随账户实际支持情况展示。用户可显式打开或保存附件，保存时使用已有沙箱文件系统。正文默认关闭远程图片和其他外部资源，HTML 使用既有安全渲染边界。

### FR-MAIL-03：草稿与发送

支持创建、编辑、保存草稿，以及发送、回复和转发。已发送邮件正文保留原样。确认卡显示发件账户、收件人、抄送、主题和附件。确认绑定当前草稿版本及授权账户，内容变化后重新确认。发送结果不明时要求核对已发送记录，避免重复投递。

### FR-MAIL-04：咕咕工具

邮箱已连接且当前会话具备使用权限时，工具目录提供邮箱账户查询、搜索、读取、保存草稿、发送和整理操作。工具根据可信 owner 和账户 ID 定位账户，邮件引用带账户边界。首版默认在个人会话开放，群聊工具目录和后台任务排除个人邮箱能力。发送和移入垃圾箱均走现有确认机制。

## 3. 技术方案

### 3.1 统一操作与服务商适配

Core 共享账户、邮件、草稿、分页和操作回执契约，以及工具定义和确认策略。Web Host 与 Desktop 各自注入账户存储、凭据存储和网络适配。UI 与 Agent 使用同一份账户能力清单。

| 服务商 | 接入方案 | 建议发布顺序 |
|---|---|---|
| QQ 邮箱、网易邮箱（163、126、yeah.net）、iCloud | IMAP + SMTP，按域名预填，凭据使用服务商授权码或 App 专用密码 | 首批 |
| 其他邮箱与自建邮箱 | 手动填写 IMAP 和 SMTP 参数，并验证宿主是否允许连接 | 首批 |
| Gmail | Google OAuth + Gmail API | OAuth 批次 |
| Outlook、Hotmail | Microsoft OAuth + Graph，先验收个人账号 | OAuth 批次 |
| Yahoo Mail | IMAP + SMTP 预设，使用 App 密码 | 补充预设 |

### 3.2 IMAP 与 SMTP

IMAP 负责收件箱、搜索、标记、文件夹和草稿。消息定位使用账户、邮箱文件夹、`UIDVALIDITY` 和 `UID`。服务端重建 UID 或移动邮件后，旧引用按失效处理或根据可确认的新定位更新。自动识别特殊文件夹，无法识别垃圾箱时隐藏移入与恢复操作。移动实现不得使用会清掉其他已删除邮件的全邮箱 EXPUNGE。

SMTP 负责提交 MIME 邮件。可复用 Nodemailer 及现有 MIME 构造能力，个人邮箱的发送账户、授权、连接和投递回执从个人邮箱域获取。连接测试验证 IMAP 认证、列目录与 SMTP 认证，实际测试发信需要用户主动触发。保存到已发送文件夹按服务商行为处理，避免服务商已自动归档时再次追加。IMAP、SMTP 分别显式校验 TLS 和证书，Web Host 的自定义地址受宿主出站策略约束。超时、失效、限流返回结构化、脱敏的错误类别。

### 3.3 OAuth

- Web 使用服务端授权码流程和 PKCE，回调校验一次性 `state`、提供商、有效期及当前用户登录绑定。授权码在宿主内交换，回调完成后跳回邮箱账户页。
- Desktop 使用系统浏览器和各提供商支持的桌面注册类型。优先使用 PKCE 和绑定到回环地址的临时回调。若提供商注册限制导致该方式不可用，再评估服务端代理授权。Desktop 分发包使用公共客户端配置。
- Gmail 若仅搜索和读取，评估 `gmail.readonly`。完整读写使用 `gmail.modify`，发布前确认 Google 对受限范围的审核及安全评估要求。Microsoft 个人账号使用委托权限，按功能选择 `Mail.ReadWrite`、`Mail.Send` 与刷新授权所需的 `offline_access`。
- 宿主加密保存 refresh token 或邮箱授权码，以提供商主体及咕咕 owner 绑定账户。刷新按账户合并并发并处理凭据轮换。权限撤销或刷新失败后标记需重连。授权码、令牌、授权码交换请求及邮件正文排除在系统日志和普通工具遥测之外。

### 3.4 目录与边界

以下是提议的目录。已存在的文件按本仓库实际路径列出，新增目录的文件拆分在实施时确认。

```text
packages/
├── core/src/
│   ├── mail/                         【新增】操作契约、业务规则、IMAP/SMTP Node 适配
│   └── agent/tools/
│       ├── index.ts                   【修改】注册用户邮箱工具
│       ├── mailbox.ts                 【新增】邮箱工具与确认接入
│       └── email.ts                   【不改】保留原有 send_email
└── database/src/
    ├── postgres/migrations/           【条件】Web 账户元数据及回执迁移
    └── sqlite/migrations/             【条件】桌面需要关系型账户元数据时使用
apps/
├── web-host/src/
│   ├── modules/mail/                  【新增】账户 API 与 Web 加密存储，预留 OAuth 回调
│   └── adapters/
││       └── email/smtp-email.ts        【不改】现有认证与系统发信
├── desktop/src/
│   ├── main/mail/                     【新增】本机邮箱接入、原生 OAuth、IPC 处理
│   ├── main/auth/store.ts             【不改】复用现有加密存储接口
│   ├── main/index.ts                  【修改】注册邮箱 IPC
│   ├── preload/index.ts               【修改】暴露受限邮箱调用
│   └── ui/shell/components/
│       └── DesktopSidebar.vue         【修改】联系分组下增加邮箱
└── web/src/
    ├── components/common/layout/
    │   └── AppSidebar.vue              【修改】联系分组下增加邮箱
    ├── router/index.ts                【修改】Web 邮箱路由
    ├── desktop/main.ts                【修改】桌面邮箱路由
    ├── views/Mail/                    【新增】双端共用邮箱页面
    └── i18n/sections/mail.ts           【新增】邮箱文案
```

当前双端已共用 `packages/core/src/mail/transport.ts` 的 Node 协议适配。Web 使用凭据信封加密后的本地账户文件，按 owner 分目录。Desktop 使用系统安全存储加密本机账户。两端通过独占发送标记拒绝同一提交请求重复投递。

当前默认只连接可公开访问的邮件服务器，使用 IMAP TLS 993，以及 SMTP TLS 465 或 STARTTLS 587。附件可显式保存到个人文件，无覆盖行为。SMTP 发送支持文本正文，已发送列表读取服务商的文件夹，服务商未归档时暂未自动补副本。既有系统发信保有独立配置和权限。

## 4. 验证与上线

用本地协议替身覆盖 IMAP 搜索和移动、SMTP 成功及结果不明、OAuth 回调重放、过期和令牌刷新。使用隔离测试邮箱做读信、草稿、发送、回收站还原及撤销授权验收。测试正文与附件使用合成内容。发布按宿主和提供商启用，禁用时停止账户调用。观测使用提供商类别、耗时、阶段和脱敏错误码。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 服务商文件夹语义不同 | 归档、恢复或已发送副本行为不一致 | 按能力和已识别的特殊文件夹展示操作 |
| 邮件包含提示注入和外部资源 | 模型可能把邮件正文误当成操作指令 | 正文作为外部数据处理，敏感工具通过咕咕的确认机制 |
| 邮件投递超时 | 服务端已接受但咕咕收不到回执 | 保留发送回执，状态未知时阻止盲重试 |
| OAuth 审核或租户同意策略 | 特定账户无法连接 | 按服务商开放，显示重授权或租户限制原因 |

待确认事项包括自托管 OAuth 采用站点自注册还是统一授权服务、邮箱 UI 首版是否包含附件预览，以及 Outlook 工作或学校账号是否随个人账号开放。

## 6. 唯一实施 TODO

- [ ] `MAIL1-001` 🟡 双端入口与账户管理已接线，待真实账户验收。提供「联系 → 邮箱」及账户管理。验收：Web 和 Desktop 可添加、切换和断开测试账户，跨用户访问返回拒绝。
- [ ] `MAIL1-002` 🟡 IMAP 操作已接线，待真实账户验收。接通 IMAP 读取与整理。验收：测试邮箱可搜索、标记、归档、移入垃圾箱并恢复，UID 失效时返回可处理提示。
- [ ] `MAIL1-003` 🟡 草稿与文本发信已接线，待真实投递及已发送副本验收。接通草稿和 SMTP 发送。验收：接收账户收到测试邮件，已发送文件夹只有一份副本，模拟结果不明时不会自动重发。
- [ ] `MAIL1-004` 接入 Gmail OAuth 和操作映射。验收：Web 和 Desktop 完成测试账户授权、刷新、收发与撤销，发布范围符合 Google 权限要求。
- [ ] `MAIL1-005` 接入 Outlook 个人账号及 Graph 操作。验收：测试账号完成双端授权、刷新、草稿、发送与邮件整理。
- [ ] `MAIL1-006` 接通咕咕的邮箱工具。验收：个人会话可以查询和起草，发送和移入垃圾箱需确认，群聊目录不展示个人邮箱工具。
