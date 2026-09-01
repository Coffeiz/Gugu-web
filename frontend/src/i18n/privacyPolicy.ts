/** Public privacy policy copy. Keep this aligned with docs/security/privacy.md. */
export const privacyPolicy = {
  'zh-CN': `# 隐私政策

> 生效日期：2026-09-01　|　版本：1.3
> 产品：咕咕（gugugu.site）

这份政策直接说明咕咕收集什么、如何使用、会发送给谁，以及你如何查看、修改或删除自己的数据。

**我们收集信息的目的，是提供和改进咕咕服务。** 我们不出售你的数据，不用你的数据投放广告，也不将其用于与咕咕服务无关的用途。

---

## 一、我们收集的信息

### 注册与账户
- **用户名、邮箱**：用于登录、身份识别和密码找回
- **密码**：仅保存 bcrypt 哈希，无法还原明文

### 使用过程中
- **工作区数据**：项目、阶段、待办、日历事件、提醒、客户信息、笔记和画布
- **文件**：上传文件及文件名、大小、类型等元数据
- **对话记录**：网页和已接入 IM 中的消息及工具调用记录
- **AI 记忆**：从对话中提炼的稳定事实、近期记忆、长期沉淀、当前状态和解读先验
- **头像、语言、时区、主题、回复偏好、模型和通知设置**

### IM 接入（飞书 / QQ / 微信，可选）
- **Bot 凭据**：App Secret 或微信 iLink bot token 使用 AES-256-GCM 加密存储；App ID 等公开标识符明文存储
- **消息与附件**：经咕咕服务器中转处理，和网页端共用对话记录；未保存到文件库的聊天附件（含语音）仅作临时暂存

### 运行与安全数据
- **基础操作事件**：例如打开聊天窗、发送消息，用于了解功能使用情况
- **脱敏感知遥测**：仅保存意图、歧义度、情绪类别与强度、纠正类型等结构化字段，不保存对话原文
- **审计日志**：管理员操作和安全事件，用于安全审计

## 二、我们不收集的信息

- 真实姓名、手机号、身份证号（除非你主动在内容中提供）
- 设备指纹、跨站追踪标识和其他网站行为
- 支付信息（咕咕目前不收费）

## 三、第三方服务

实际启用的服务以站点配置为准。

### AI 提供商

对话内容及完成任务所需的上下文（例如项目、文件摘要）会发送给当前配置的 AI 提供商处理。可能使用 Anthropic、OpenAI、阿里云通义千问、DeepSeek、MiniMax 或智谱 GLM。具体提供商的隐私政策同样适用；使用境外提供商时，数据可能传输至中国境外服务器。

### 文件存储

使用本地存储时，文件保存在咕咕服务器；配置阿里云 OSS 时，文件会存储在阿里云对象存储并适用其隐私政策。

### 联网搜索

启用联网搜索后，搜索关键词会发送给 Admin 选择的搜索 Provider（例如 SearXNG、Tavily、百度搜索或 You.com）。咕咕不会主动把搜索词与账户身份一并提供给上游服务。

### IM 与邮件

接入 IM Bot 后，消息会经过咕咕服务器并适用对应平台的隐私指引。SMTP 仅用于向管理员发送用户反馈通知，邮件不包含密码或 API Key。

## 四、AI 记忆

咕咕会在对话后异步提炼五类记忆：稳定事实、近期记忆、长期沉淀、当前状态和解读先验。它们存储在你的私有目录中，其他用户无法访问，不用于训练 AI 模型，也不对外共享。你可以使用 \`/memory\` 查看、使用 \`/forget <内容>\` 删除，或在个人设置中清空记忆。

## 五、数据保留与删除

| 数据类型 | 保留期限 | 删除方式 |
|---------|---------|---------|
| 聊天暂存附件（含语音，未存入文件库） | 7 天 | 自动过期清理 |
| 回收站文件 | 最长 30 天 | 自动删除或手动清空 |
| 对话、项目、文件、日历和记忆 | 账户存续期间 | 主动删除或注销账户 |
| IM Bot 凭据 | 账户存续期间 | 解除绑定或注销账户 |
| 行为与审计数据 | 按系统保留策略 | 注销账户时删除与账户相关数据 |

注销账户后，咕咕会清理数据库记录、存储文件、记忆文件、语音和暂存附件，数据不可恢复。

## 六、数据安全

- 密码使用 bcrypt 哈希；IM 密钥使用 AES-256-GCM 加密
- 通信通过 HTTPS / TLS 保护
- 文件和接口需要鉴权，不同用户的数据相互隔离
- 上传目录不直接对外暴露，文件访问经过后端鉴权

互联网传输和存储仍有固有风险，我们无法承诺绝对安全。

## 七、Token、Cookie 与本地存储

咕咕不使用 Cookie 做广告或跨站追踪。登录状态使用服务端配置有效期的 JWT；浏览器优先使用 HttpOnly、SameSite Cookie，同时保留 localStorage 兼容令牌。Token 只包含认证所需的用户 ID 和角色，不含密码或 API Key。

## 八、未成年人

未满 14 周岁的用户应在监护人陪同下使用并阅读本政策。我们不会主动收集未成年人的额外信息，也不会将其用于商业目的。

## 九、政策变更与联系我们

涉及新增数据类型或第三方服务的重大变更会更新本页面的生效日期，并通过网站公告或站内通知告知。

如需查阅、修改或删除数据，请通过左下角用户头像提交站内反馈，或发送邮件至 **coffeiz216@gmail.com**。我们会在 14 天内回复隐私相关请求。`,

  'en-US': `# Privacy Policy

> Effective date: 2026-09-01 | Version: 1.3
> Product: Gugu (gugugu.site)

This policy explains what Gugu collects, how it is used, who may receive it, and how you can view, change, or delete your data.

**We collect information to provide and improve Gugu.** We do not sell your data, use it for advertising, or use it for purposes unrelated to the service.

---

## 1. Information We Collect

### Account information
- **Username and email** for sign-in, identification, and password recovery
- **Password**, stored only as a bcrypt hash

### While you use Gugu
- **Workspace data**: projects, stages, todos, calendar events, reminders, customers, notes, and canvases
- **Files** and metadata such as names, sizes, and types
- **Conversation history**, including messages and tool-call records
- **AI memory**: stable facts, recent memories, long-term summaries, current state, and interpretation hints extracted from conversations
- **Avatar, language, timezone, theme, response preferences, model, and notification settings**

### Optional IM connections (Feishu / QQ / WeChat)
- **Bot credentials**: App Secrets and WeChat iLink bot tokens are encrypted with AES-256-GCM; public identifiers such as App IDs are stored in plaintext
- **Messages and attachments**: relayed through Gugu for processing and stored with web conversations; chat attachments not saved to the file library are temporary

### Operations and security
We collect basic product events, administrator audit events, and privacy-preserving perception telemetry. Telemetry stores only structured intent, ambiguity, emotion, and correction fields; it does not store conversation text.

## 2. Information We Do Not Collect

We do not intentionally collect your legal name, phone number, government ID, device fingerprint, cross-site tracking identifiers, activity on other websites, or payment information.

## 3. Third-Party Services

The services actually enabled depend on the site configuration.

- **AI providers**: conversation content and task context may be sent to the configured provider, such as Anthropic, OpenAI, Alibaba Cloud, DeepSeek, MiniMax, or Zhipu GLM. Provider privacy policies also apply, and overseas providers may process data outside China.
- **File storage**: files remain on the Gugu server with local storage, or are stored by Alibaba Cloud OSS when configured.
- **Web search**: search terms may be sent to the configured provider, such as SearXNG, Tavily, Baidu Search, or You.com. Gugu does not intentionally send your account identity with the query.
- **IM and email**: IM messages follow the relevant platform policy. SMTP is used only for administrator feedback notifications and does not include passwords or API keys.

## 4. AI Memory

After conversations, Gugu asynchronously extracts stable facts, recent memories, long-term summaries, current state, and interpretation hints. They are stored in your private account space, are not shared or used to train AI models, and can be viewed with \`/memory\`, removed with \`/forget <content>\`, or cleared in Personal Settings.

## 5. Retention and Deletion

Temporary chat attachments, including voice files, expire after 7 days. Recycle-bin files are retained for up to 30 days. Conversations, workspace data, memory, and IM credentials remain while the account exists unless you delete them. Account deletion removes database records, stored files, memory, voice files, and temporary attachments and cannot be undone.

## 6. Security

Passwords use bcrypt hashes, IM secrets use AES-256-GCM encryption, traffic uses HTTPS/TLS, and authenticated APIs isolate each user’s data. Uploaded files are not directly public. No internet system can guarantee absolute security.

## 7. Tokens, Cookies, and Local Storage

Gugu does not use cookies for advertising or cross-site tracking. Login uses a server-configured JWT lifetime, preferably in HttpOnly and SameSite cookies, with a local-storage compatibility token. Tokens contain only the user ID and role needed for authentication, never passwords or API keys.

## 8. Children

Users under 14 should use Gugu with a parent or guardian. We do not intentionally collect additional information from children or use it for commercial purposes.

## 9. Changes and Contact

Material changes will update the effective date and be announced on the site or in-product. For privacy questions or data requests, submit in-product feedback or email **coffeiz216@gmail.com**. We aim to respond within 14 days.`,

  'ja-JP': `# プライバシーポリシー

> 発効日：2026-09-01　|　バージョン：1.3
> サービス：Gugu（gugugu.site）

このポリシーでは、Gugu が収集する情報、その利用目的、第三者への提供、データの確認・変更・削除方法を説明します。

**情報は Gugu の提供と改善のために収集します。** データを販売したり、広告配信やサービスと無関係な目的に利用したりすることはありません。

---

## 1. 収集する情報

- **アカウント**：ユーザー名、メールアドレス、bcrypt ハッシュ化したパスワード
- **ワークスペース**：プロジェクト、ステージ、タスク、予定、リマインダー、顧客、ノート、キャンバス、ファイルとメタデータ
- **会話と記憶**：Web と接続した IM のメッセージ、ツール呼び出し、会話から非同期に抽出した安定した事実・最近の記憶・長期要約・現在の状態・解釈ヒント
- **設定**：アバター、言語、タイムゾーン、テーマ、返信設定、モデル、通知設定
- **IM 接続情報**：App Secret と WeChat iLink bot token は AES-256-GCM で暗号化し、App ID など公開識別子は平文で保存
- **運用・安全情報**：基本操作イベント、管理者監査イベント、会話本文を含まない構造化された感知テレメトリ

## 2. 収集しない情報

法的な氏名、電話番号、身分証番号、端末フィンガープリント、サイト横断トラッキング、他サイトの行動、支払い情報を意図的に収集しません。

## 3. 第三者サービス

実際に有効なサービスはサイト設定によります。会話と必要なタスク情報は設定された AI Provider（Anthropic、OpenAI、Alibaba Cloud、DeepSeek、MiniMax、Zhipu GLM など）へ送信される場合があります。OSS を設定した場合は Alibaba Cloud OSS にファイルを保存します。検索語は設定された検索 Provider（SearXNG、Tavily、Baidu Search、You.com など）へ送信される場合があります。IM は各プラットフォームのポリシーに従い、SMTP は管理者へのフィードバック通知だけに使用します。

## 4. AI メモリ

Gugu は会話後にメモリを非同期で整理します。メモリはアカウント専用領域に保存され、共有や AI モデルの学習には使いません。\`/memory\` で確認し、\`/forget <内容>\` または個人設定で削除できます。

## 5. 保持と削除

ファイル庫に保存していないチャット添付（音声を含む）は 7 日後に自動削除されます。ゴミ箱のファイルは最長 30 日です。会話、ワークスペース、メモリ、IM 認証情報はアカウント存続中保持されます。アカウント削除時は DB、保存ファイル、メモリ、音声、仮置き添付を削除し、復元できません。

## 6. 安全対策

パスワードは bcrypt、IM の秘密情報は AES-256-GCM で保護し、通信は HTTPS/TLS を使用します。認証済み API でユーザー間のデータを分離し、アップロードファイルを直接公開しません。

## 7. トークン、Cookie、ローカルストレージ

広告やサイト横断追跡のために Cookie を使いません。ログインにはサーバー設定の有効期限を持つ JWT を使用し、HttpOnly・SameSite Cookie を優先します。互換性のため localStorage のトークンも使用しますが、パスワードや API Key は含みません。

## 8. 未成年者

14 歳未満の方は保護者と一緒に利用してください。未成年者の追加情報を意図的に収集したり、商業目的で利用したりしません。

## 9. 変更と連絡先

重要な変更時は発効日を更新し、サイトまたはサービス内でお知らせします。お問い合わせやデータに関する依頼は、サービス内のフィードバックまたは **coffeiz216@gmail.com** までご連絡ください。14 日以内の返信を目指します。`,
} as const
