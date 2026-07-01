<template>
  <div class="privacy-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="privacy-card">
      <div class="privacy-header">
        <router-link to="/login" class="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          返回
        </router-link>
        <div class="header-brand">咕咕 · 隐私政策</div>
      </div>
      <div class="privacy-body md-content" v-html="html" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'


const md = `# 隐私政策

> 生效日期：2026-06-24　|　版本：1.0
> 产品：咕咕（gugugu.site）

我们知道你不喜欢读长篇法律文件。这份政策会直接告诉你：我们收集了什么、怎么用、发给谁、你怎么删。有任何问题都可以通过站内反馈联系我们。

**我们收集信息的唯一目的是为你提供更好的服务。** 我们不出售你的数据，不用你的数据投放广告，也不将其用于与咕咕服务无关的任何用途。我们收集的每一项信息，都只服务于让咕咕更好地帮你管理项目、记住你的偏好、在正确的时间提醒你。

---

## 一、我们收集的信息

### 注册时
- **用户名**、**邮箱**：用于登录和身份识别
- **密码**：仅存储 bcrypt 哈希值，我们无法还原你的明文密码
- **邀请码**：验证后标记失效，不再保留用途以外的信息

### 使用过程中
- **项目数据**：你创建的项目、阶段、待办事项、截止日期
- **日历事件**：你添加的日程和提醒
- **文件**：你上传的所有文件及其元数据（文件名、大小、类型）
- **客户信息**：你填写的客户名称、联系方式、备注
- **对话记录**：你与咕咕的聊天内容（含工具调用记录）
- **AI 记忆**：咕咕从对话中提炼的关于你的稳定事实、近期记忆和长期沉淀（存储在你账户下的私有文件中，见第四节）
- **头像**：你上传的个人头像图片

### IM 接入时（飞书 / QQ，可选）
- **Bot 凭据**：你填写的 App ID 和 App Secret，用 AES-256-GCM 加密后存储，仅用于维持机器人连接
- **消息内容**：你通过飞书 / QQ 发给咕咕 Bot 的消息和文件，经服务器中转后处理，**处理完成后不会额外留存副本**（对话记录与网页端共用同一份存储）

### 行为数据
- **操作事件**：如「打开咕咕聊天窗」「发送消息」等基础行为，用于了解功能使用情况，数据不对外共享
- **审计日志**：管理员操作日志，仅用于系统安全审计

---

## 二、我们不收集的信息

- 你的真实姓名、手机号、身份证号
- 设备指纹或跨站追踪标识符
- 你在其他网站上的行为
- 任何支付信息（咕咕目前不收费）

---

## 三、第三方服务

使用咕咕时，部分数据会发送给以下第三方。具体启用了哪些服务以站点实际配置为准，我们会在下方注明各服务的用途和数据流向。

### AI 提供商（核心功能）

你与咕咕的对话内容、相关上下文（项目 / 文件摘要等）会发送给咕咕当前使用的 AI 提供商进行处理。AI 提供商由我们统一配置，可能为以下之一：

| 提供商 | 服务协议 |
|--------|---------|
| Anthropic（Claude） | anthropic.com/legal/privacy |
| OpenAI | openai.com/policies/privacy-policy |
| 阿里云通义千问 | aliyun.com/product/bailian |
| DeepSeek | deepseek.com/privacy |
| MiniMax | minimaxi.com/protocol/privacy |

> **重要**：你的对话内容由实际使用的提供商的隐私政策约束。若当前使用境外提供商（Anthropic / OpenAI / DeepSeek），数据将传输至中国境外服务器处理。我们会尽量在切换提供商时更新本政策。

### 文件存储（可选）

若管理员配置了**阿里云 OSS**，你上传的文件会存储在阿里云的对象存储服务中，适用阿里云隐私政策。使用本地存储时，文件仅存在于咕咕服务器上。

### 联网搜索（可选功能）

启用联网搜索时，你的搜索关键词（最多 500 字符）会发送至 **Tavily Search API**（tavily.com），适用其隐私政策。咕咕不会将搜索词与你的身份信息一同提供给 Tavily。

### 飞书 / QQ 平台（IM 接入，可选）

接入 IM Bot 后，你通过飞书 / QQ 发给 Bot 的消息会经过咕咕服务器，分别适用飞书隐私政策和 QQ 隐私保护指引。

### 邮件服务

我们使用 SMTP 向管理员发送用户反馈通知，邮件内容仅包含反馈分类和正文，不包含你的密码或任何敏感信息。

---

## 四、AI 记忆系统说明

咕咕会在对话后自动提炼你的信息，存入五层记忆文件：

- **稳定事实**（facts）：你的身份、职业、长期偏好（结构化存储，区分「你亲口说的」与「咕咕推断的」，推断会随时间淡出）
- **近期记忆**（daily）：最近 30 条对话提炼，攒够触发压缩
- **长期沉淀**（memory）：压缩后的长期记忆
- **当前状态**（summary）：你近期在忙什么的一句话快照，会随时间衰减
- **解读先验**（lens）：咕咕摸索出的「怎么读懂你」的小规则（如某些话的言外之意），用于更贴合地回应

这些文件存储在你账户下的私有目录中，**其他用户无法访问**。记忆内容仅用于让咕咕更了解你，不会用于训练 AI 模型，也不会对外共享。你可在聊天里随时用 `/memory` 查看咕咕记得你哪些事、`/forget <内容>` 让它忘掉某条——**网页与飞书 / QQ / 微信聊天里都可用**；也可在「个人设置 → 记忆」一键清除全部记忆。

你可以随时通过对话指令要求咕咕清除或修改特定记忆，或在账户注销时一并删除。

---

## 五、数据保留与删除

| 数据类型 | 保留期限 | 删除方式 |
|---------|---------|---------|
| 回收站文件 | 最长 30 天 | 自动永久删除；也可手动清空 |
| 对话记录 | 账户存续期间 | 账户注销时删除 |
| AI 记忆文件 | 账户存续期间 | 可通过对话指令清除，或账户注销时删除 |
| 项目 / 文件 / 日历 | 账户存续期间 | 用户主动删除，或账户注销时删除 |
| IM Bot 凭据 | 账户存续期间 | 可在设置中主动解除绑定，或账户注销时删除 |
| 行为埋点数据 | 账户存续期间 | 账户注销时删除 |

**账户注销**：注销后，你的所有数据将从数据库和存储中永久删除，**不可恢复**。如需注销，请通过站内反馈联系我们。

---

## 六、数据安全

- **密码**：bcrypt 哈希存储，不存明文，我们的工作人员无法读取你的密码
- **IM 凭据**：AES-256-GCM 加密存储
- **传输加密**：所有通信通过 HTTPS / TLS 加密
- **访问控制**：文件和接口均需 Bearer Token 鉴权，不同用户的数据完全隔离
- **文件目录**：上传目录不对外暴露，所有文件访问必须经过后端鉴权接口

尽管我们采取了以上措施，互联网传输和存储本身存在固有风险，我们无法承诺绝对安全。

---

## 七、Token 与本地存储

咕咕不使用 Cookie 追踪你。登录状态通过 **JWT Token** 维持：

- Token 存储在你浏览器的 \`localStorage\` 中
- 有效期 7 天，登出后立即失效
- Token 仅包含你的用户 ID 和角色，不含任何个人信息明文

---

## 八、未成年人

咕咕面向所有年龄段用户开放。如果你未满 14 周岁，请在父母或监护人的陪同下使用本服务，并由监护人阅读和同意本隐私政策。我们不会主动收集未成年人的额外信息，也不会将其用于任何商业目的。

---

## 九、政策变更

如果本政策发生重大变更（涉及新增数据收集类型或新增第三方），我们会在网站公告或站内通知中提前告知，并更新文档顶部的「生效日期」。继续使用咕咕即视为接受更新后的政策。

---

## 十、联系我们

对隐私政策有任何疑问，或需要查阅 / 修改 / 删除你的数据，请通过以下方式联系我们：

- **站内反馈**：点击左下角用户头像 → 提交反馈
- **邮件**：coffeiz216@gmail.com

我们会在 **14 天内**回复你的隐私相关请求。`

const html = marked(md)
</script>

<style scoped>
.privacy-page {
  position: fixed;
  inset: 0;
  overflow-y: auto;
  background: var(--bg-gradient, linear-gradient(160deg, #e8e9ee 0%, #d8dae4 35%, #bfc4d2 65%, #9aa2b8 100%));
  display: flex; align-items: flex-start; justify-content: center;
  font-family: var(--font-sans);
  padding: 40px 16px 60px;
}

.bg-glow {
  position: fixed; border-radius: 50%; pointer-events: none; filter: blur(80px);
}
.glow-1 {
  width: 500px; height: 500px; top: -120px; left: -100px;
  background: radial-gradient(circle, rgba(123,127,178,0.18) 0%, transparent 65%);
}
.glow-2 {
  width: 380px; height: 380px; bottom: -100px; right: -80px;
  background: radial-gradient(circle, rgba(196,175,200,0.14) 0%, transparent 65%);
}

.privacy-card {
  width: 100%; max-width: 720px; position: relative; z-index: 1;
  background: rgba(255,255,255,0.56);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.76);
  border-radius: 20px;
  box-shadow:
    0 20px 60px rgba(80,90,110,0.12),
    inset 0 1px 0 rgba(255,255,255,0.95),
    inset 1px 0 0 rgba(255,255,255,0.55);
  overflow: hidden;
}

.privacy-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 28px;
  background: rgba(255,255,255,0.5);
  border-bottom: 1px solid rgba(0,0,0,0.06);
}

.back-link {
  display: flex; align-items: center; gap: 5px;
  font-size: 13px; color: var(--text-secondary, #6b7280);
  text-decoration: none; transition: color 0.15s;
}
.back-link:hover { color: var(--text-primary, #1a1d27); }

.header-brand {
  font-size: 13px; font-weight: 600;
  color: var(--text-secondary, #6b7280);
}

.privacy-body {
  padding: 32px 36px 40px;
}

/* ── Markdown 样式 ── */
.md-content :deep(h1) {
  font-size: 22px; font-weight: 700; color: var(--text-primary, #1a1d27);
  margin: 0 0 6px;
}
.md-content :deep(blockquote) {
  margin: 4px 0 20px;
  padding: 0;
  border: none;
  font-size: 12px; color: var(--text-secondary, #6b7280);
}
.md-content :deep(blockquote p) { margin: 0; }
.md-content :deep(hr) {
  border: none; border-top: 1px solid rgba(0,0,0,0.07);
  margin: 24px 0;
}
.md-content :deep(h2) {
  font-size: 15px; font-weight: 700; color: var(--text-primary, #1a1d27);
  margin: 28px 0 10px;
}
.md-content :deep(h3) {
  font-size: 13px; font-weight: 600; color: var(--text-primary, #1a1d27);
  margin: 16px 0 6px;
}
.md-content :deep(p) {
  font-size: 13px; line-height: 1.75; color: var(--text-primary, #1a1d27);
  margin: 0 0 10px;
}
.md-content :deep(ul), .md-content :deep(ol) {
  font-size: 13px; line-height: 1.75; color: var(--text-primary, #1a1d27);
  margin: 4px 0 10px; padding-left: 20px;
}
.md-content :deep(li) { margin-bottom: 3px; }
.md-content :deep(strong) { font-weight: 600; }
.md-content :deep(code) {
  font-family: monospace; font-size: 12px;
  background: rgba(0,0,0,0.05); border-radius: 4px;
  padding: 1px 5px;
}
.md-content :deep(table) {
  width: 100%; border-collapse: collapse;
  font-size: 13px; margin: 10px 0 14px;
}
.md-content :deep(th) {
  text-align: left; font-weight: 600;
  padding: 7px 12px;
  background: rgba(0,0,0,0.04);
  border-bottom: 1px solid rgba(0,0,0,0.08);
}
.md-content :deep(td) {
  padding: 7px 12px;
  border-bottom: 1px solid rgba(0,0,0,0.05);
  color: var(--text-primary, #1a1d27);
}
.md-content :deep(a) {
  color: #7b7fb2; text-decoration: none;
}
.md-content :deep(a:hover) { text-decoration: underline; }
</style>
