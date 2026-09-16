# PRD-LLM-24：Agent 链接按钮与跨平台出站动作

> 状态：Phase 0~3 已实施（2026-09-16，提交 3670ac9a9 / f1c699b80 / 06c8bcac1 + 截断提示后续提交）；Phase 4 的 QQ/飞书真实客户端验收待真机执行（其余自动化覆盖已完成）
> 最近更新：2026-09-16
> 创建：2026-09-15
> 所属层：Agent / IM / 出站交互
> 前置：[`【已完成】PRD-LLM-2-统一交互选择与动作系统.md`](./【已完成】PRD-LLM-2-统一交互选择与动作系统.md)
> 关联模块：`backend/agent/tools/meta.py`、`backend/agent/im/models.py`、`backend/agent/im/replies.py`、`backend/agent/interactions/`、`backend/agent/gateway/qq.py`、`backend/agent/gateway/feishu.py`
> 外部协议： [飞书 Button](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/button)、[QQ 机器人消息按钮](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/trans/msg-btn.md)

## 0. 核心结论

新增 `send_link_buttons` 工具，让咕咕可以向当前会话发送带网页/AppLink 地址的按钮。

该工具**复用现有出站 `PlatformReply`、平台能力判断和降级出口**，但不复用 `ask_user` 的等待/恢复状态：

```text
Agent 调用 send_link_buttons
        ↓
构造平台无关的 keyboard/link part
        ↓
QQ Keyboard / 飞书交互卡片 / Web 按钮 / 微信文本链接
        ↓
返回“已发送”结果
```

`ask_user` 仍只负责“用户点击后要把答案回传给 Agent，并恢复原 Run”的场景。链接按钮本身是非阻塞的出站动作，不创建 `InteractionPrompt`、不生成一次性 action token，也不等待用户点击。

## 1. 背景与问题

当前 `ask_user` 已经支持通过 Web、QQ Keyboard 和飞书交互卡片展示选项，但它的语义是“暂停 Run，等待用户回答”。如果把跳转 URL 直接塞进 `ask_user.options`，会产生几个问题：

1. 用户只是想打开网页，却被错误地当成选择题回答；
2. Agent Run 会进入等待状态，用户打开网页后没有结果回传，Run 可能长期处于 pending；
3. `ask_user` 的 action token 是为服务端动作消费设计的，不应被无意义地用于静态链接；
4. QQ 和飞书的 URL 跳转协议与回调协议不同，继续塞进统一选项会让平台适配器承担隐含语义；
5. 普通回复中的 Markdown 链接不能稳定渲染为原生按钮，QQ、飞书和微信的表现也不一致。

因此需要把“链接导航”与“交互选择”拆成两个明确的 Agent 能力，同时共享同一套出站平台适配边界。

## 2. 目标

### 2.1 产品目标

1. Agent 能明确请求向当前会话发送一个或多个链接按钮。
2. 飞书和 QQ 优先使用原生卡片/Keyboard；不支持时有可读的文本链接降级。
3. 按钮点击后由客户端打开 HTTPS/HTTP 网页、系统入口或 App Scheme；不承诺任意第三方 scheme 都能在各平台拉起 App。
4. 链接按钮发送不暂停当前 Run，不产生待回答交互，不等待点击确认。
5. 同一工具协议可供 Web、QQ、飞书使用；微信保持安全的文本降级。
6. URL、按钮数量、标签长度、平台能力和发送失败状态全部由服务端校验并记录脱敏结果。

### 2.2 技术目标

1. 新增平台无关的 `keyboard`/`link_button` 出站 part，避免在工具 handler 中拼 QQ 或飞书 wire payload。
2. 复用 `PlatformReply` 和 `supported_reply_capabilities()`，补齐 QQ 当前原生 Keyboard 适配的能力声明。
3. QQ 的跳转按钮使用官方 `action.type=0`；现有 `ask_user` 的回调按钮继续使用回调类型，不能混用。
4. 飞书链接按钮使用 `open_url` behavior；服务端回调仍只由 `ask_user` 或专门业务交互使用。
5. 发送失败只做有限、明确的文本降级，不重复执行 Agent 工具或无限重发消息。
6. 工具结果、发送状态和降级原因进入现有工具事件/LoopScope 观测，但不记录完整 URL 查询参数或用户正文。

## 3. 非目标

- 不把所有普通 Agent 回复自动转换成按钮。
- 不修改 `ask_user` 的 `InteractionPrompt`、`InteractionAction`、暂停、恢复、过期和消费协议。
- 不为链接按钮创建可点击回调，不追踪用户是否真的打开了网页。
- 不让按钮点击直接执行 Gugu 后端业务；需要服务端动作时使用 `ask_user`、工具确认门或业务回调。
- 不保证 `myapp://`、`intent://` 等任意第三方协议在 QQ、飞书或 Web 客户端中可用；是否能拉起由客户端和操作系统决定。
- 不允许模型指定任意收件人、Bot 或跨用户会话发送按钮。
- 不在本期实现按钮排序编辑器、复杂卡片布局、表单、菜单和多级交互。
- 不改变微信当前文本出站协议；微信只提供安全的文本 URL 降级。

## 4. 术语与语义边界

| 术语 | 含义 |
|---|---|
| 链接按钮 | 用户点击后由客户端打开目标 URL，不向 Agent 返回结果 |
| AppLink | 由平台或应用配置的可跳转链接，可以是 HTTPS Universal Link，也可以是 App Scheme |
| 交互按钮 | 点击后向服务端提交 action，并可能恢复或改变 Agent Run |
| `ask_user` | 需要用户回答的阻塞式交互；结果回写原工具调用 |
| `send_link_buttons` | 非阻塞式出站导航；只负责送达链接按钮 |
| `keyboard` part | 平台无关的按钮集合，最终由平台 Gateway 转换 wire format |

核心判断：**“打开链接”不是“选择一个选项”**。即使按钮视觉上相似，也必须由不同的协议语义承载。

## 5. 用户场景

### 5.1 打开当前项目

用户让咕咕“把当前项目入口发给我”。咕咕调用 `send_link_buttons`，发送“打开项目”按钮；用户点击后在浏览器打开项目页面，当前 Agent Run 已正常结束。

### 5.2 发送多个资源入口

用户让咕咕“把这几个文件的入口发出来”。工具一次最多发送受控数量的按钮，每个按钮只包含展示标签和经过校验的导航 URL。

### 5.3 需要服务端动作的相似场景

用户让咕咕“删除这个文件”。这不是链接按钮场景。咕咕必须走删除工具自身的权限校验和 destructive confirm gate，必要时通过 `ask_user` 展示确认按钮；不能把删除 URL 做成普通链接按钮。

### 5.4 不支持原生按钮的平台

微信或平台接口拒绝原生按钮时，发送一段包含标题和 URL 的文本。工具结果必须明确标记 `fallback=text`，不能谎报为原生按钮已发送。

## 6. Agent 工具协议

### 6.1 工具名称与描述

工具名：`send_link_buttons`

工具描述必须明确：

- 用于向当前会话发送网页或 AppLink 入口；
- 不等待用户点击，不会把点击结果返回给咕咕；
- 只接受经过服务端安全校验的 URL；
- 需要确认、删除、覆盖、授权或其他业务动作时不能使用；
- 当前平台不支持原生按钮时会退回文本链接。

### 6.2 输入 Schema

```json
{
  "message": "相关入口：",
  "buttons": [
    {
      "id": "open_project",
      "label": "打开项目",
      "url": "https://example.com/projects/123"
    }
  ]
}
```

字段约束：

| 字段 | 类型 | 约束 |
|---|---|---|
| `message` | string | 必填；1～2000 字符；作为按钮前的说明文本 |
| `buttons` | array | 必填；1～5 个；顺序由服务端保留 |
| `buttons[].id` | string | 必填；1～64 字符；同一调用内唯一；只用于诊断和稳定排序，不是权限凭证 |
| `buttons[].label` | string | 必填；1～40 字符；不能包含控制字符 |
| `buttons[].url` | string | 必填；1～2048 字符；默认只允许 `https://` |

首版不开放 `style`、`permission`、`click_limit`、`callback_data` 等平台字段，避免把平台 wire 协议泄漏进 Agent Schema。

### 6.3 返回协议

```json
{
  "status": "sent",
  "platform": "feishu",
  "delivery": "native",
  "button_count": 1
}
```

`status`：

| 状态 | 含义 |
|---|---|
| `sent` | 已按当前平台出口发送 |
| `sent_with_fallback` | 原生按钮不可用，已发送文本链接降级 |
| `rejected` | 输入或 URL 安全校验失败，未发送 |
| `failed` | 发送失败且文本降级也失败 |
| `unsupported` | 当前渠道没有可用的链接出站能力 |

`delivery`：`native`、`text` 或 `none`。

工具结果只能表示服务端已提交/已接受发送，不表示用户已经点击或目标页面已经打开。工具结果不得包含 action token、Bot 凭据、完整用户身份或未脱敏的上游错误。

## 7. URL 安全策略

### 7.1 首版允许范围（黑名单模式）

首版不维护 Scheme、域名或公网地址白名单。只要 URL：

- 包含 Scheme；
- 不属于下方明确禁止的危险 Scheme；
- 不含空白控制字符、用户名或密码，且未超过长度限制；

就可以作为导航按钮发送，包括 `https://`、`http://`、自定义 App Scheme、系统入口以及其他由客户端支持的协议。服务端不请求目标 URL，因此这里不执行面向后端外部请求的域名、内网地址或 SSRF 检查。

### 7.2 必须拒绝

服务端拒绝以下 scheme 或形式：

- `javascript:`、`data:`、`vbscript:`、`file:`、`blob:`、`filesystem:`；
- `about:`、`chrome:`、`chrome-extension:`、`resource:`、`view-source:` 等浏览器内部 scheme；
- 含用户名或密码的 URL；
- 空 URL、缺少 Scheme、包含控制字符或超过长度限制的输入。

链接按钮使用独立的静态黑名单校验；不应为了验证 URL 而主动请求目标站点，也不应自动跟随重定向。平台是否支持某个合法 Scheme，由对应客户端适配器决定；不支持时按文本链接降级。

### 7.3 危险动作边界

按钮跳转只能导航，不能被当作后端授权：

- 删除、覆盖、停用、授权、付款等动作必须由服务端确认门保护；
- 不允许把“点击普通 GET URL”当作业务操作成功依据；
- 如果业务确实需要点击后回调，应新建明确的 `InteractionAction` 类型和消费协议，而不是在 URL 按钮里隐藏 callback token。

## 8. 跨平台渲染方案

### 8.1 能力矩阵

| 渠道 | 首选渲染 | 降级 | 是否等待点击 |
|---|---|---|---|
| Web | 结构化链接按钮 | 普通 HTTPS 链接 | 否 |
| QQ | Markdown + Keyboard 跳转按钮 | Markdown/纯文本 URL | 否 |
| 飞书 | Interactive Card `open_url` | 文本 URL | 否 |
| 微信 | 文本 URL | 文本 URL | 否 |

### 8.2 QQ

QQ 跳转按钮使用官方 Keyboard action：

```json
{
  "action": {
    "type": 0,
    "permission": {"type": 2},
    "data": "https://example.com",
    "unsupport_tips": "当前客户端不支持打开链接"
  }
}
```

要求：

- 复用现有 `_post_keyboard()` 和 QQ Markdown 消息发送路径；
- 跳转按钮不得携带 `ask_user` 的 opaque token；
- 保留当前 QQ 原生 Keyboard 发送失败后的文本降级；
- 遵守 QQ 机器人消息 URL 白名单和平台审核/开通要求；
- 现有 `ask_user` 回调按钮的 action 类型、事件解析和消费逻辑保持不变；
- 更新 `supported_reply_capabilities()` 与测试，使能力声明和真实 Keyboard 发送路径一致。

### 8.3 飞书

飞书使用 Button 的 `open_url` behavior：

```json
{
  "tag": "button",
  "text": {"tag": "plain_text", "content": "打开项目"},
  "type": "primary",
  "behaviors": [
    {
      "type": "open_url",
      "default_url": "https://example.com/projects/123"
    }
  ]
}
```

要求：

- 复用现有飞书卡片构造和发送出口，但不注册 `card.action.trigger` 回调；
- 不为静态链接创建 `InteractionPrompt`；
- 需要飞书端内跳转时使用 HTTPS AppLink/应用链接；
- 若客户端不支持目标行为，卡片发送失败或不可用时退回文本链接；
- 保持现有 `ask_user` 卡片的 token、回调、过期和消费逻辑独立。

### 8.4 Web 与微信

- Web 直接消费 `keyboard` part，展示为标准按钮或安全链接；URL 使用 `target="_blank"` 时必须配合 `rel="noopener noreferrer"`。
- 微信不假设支持原生 Keyboard；发送 `message` 和每个按钮的 `label + URL` 文本，保持用户可复制和可点击。
- 平台降级不能隐藏 URL，也不能显示一个点击后没有行为的假按钮。

## 9. 架构与责任边界

```text
Agent Tool Registry
        ↓
send_link_buttons handler
        ↓ 仅生成受控、平台无关的 part
PlatformReply(parts=[text, keyboard])
        ↓ capability check
agent.im.replies
        ├─ QQ Gateway     → Markdown + Keyboard
        ├─ 飞书 Gateway   → Interactive Card open_url
        ├─ Web            → 结构化按钮
        └─ 微信           → 文本 URL 降级
```

### 9.1 工具层

`backend/agent/tools/meta.py` 只负责：

- 注册 `send_link_buttons` Schema 和说明；
- 调用共享 URL 校验；
- 读取当前 IM/Web 出站上下文；
- 返回结构化的链接按钮 part 或受控拒绝结果。

工具层不得：

- 拼接 QQ、飞书 JSON；
- 直接调用 Gateway；
- 接收任意收件人或 Bot ID；
- 复用 `consume_action()`；
- 把 URL 点击视为权限确认。

### 9.2 出站层

`backend/agent/im/models.py` 和 `backend/agent/im/replies.py` 负责：

- 定义 `keyboard`/`link_button` part 的最小结构；
- 根据渠道能力选择原生渲染或文本降级；
- 统一处理发送结果和有限重试；
- 保持当前会话目标、消息关联和平台身份边界。

### 9.3 Gateway 层

QQ、飞书 Gateway 只负责把已校验的统一 part 转成平台 wire payload，并处理平台错误；不维护第二套 Agent 交互状态。

### 9.4 `ask_user` 边界

`send_link_buttons` 不进入 `app.services.interactions`。只有以下场景才进入现有 Prompt/Action 服务：

- 点击后需要恢复原 Run；
- 点击后需要消费一次性权限或确认；
- 需要验证当前用户身份、会话、过期时间或重复点击；
- 点击后需要执行服务端业务动作。

## 10. 发送时机、历史与幂等

1. 工具调用产生的按钮 part 应沿用现有 Agent Run 的出站顺序，不能绕过 LoopScope 和消息收尾。
2. 按钮发送成功后，最终助手文本可以说明“入口已发出”，但不能重复把同一组 URL 再发成第二条普通消息。
3. `send_link_buttons` 不会创建 pending prompt，也不会让 `finalize_im_response()` 进入等待状态。
4. 发送失败时只允许平台定义的有限重试；非幂等消息发送不能无限重放。
5. canonical history 至少保存工具调用和结构化结果摘要；不保存平台 token，不把完整敏感查询参数写入普通历史。
6. LoopScope 记录工具名、状态、平台、按钮数量、投递方式和耗时；URL 只记录域名 fingerprint 或安全分类，不记录完整地址。

## 11. 失败与降级

| 失败原因 | 行为 | Agent 结果 |
|---|---|---|
| Schema/长度错误 | 不发送 | `rejected` |
| URL scheme/域名不安全 | 不发送整组按钮 | `rejected`，说明需使用 HTTPS 白名单地址 |
| 当前平台无原生按钮 | 发送文本 URL | `sent_with_fallback` |
| QQ/飞书原生接口拒绝 | 按现有策略尝试文本降级 | 成功则 `sent_with_fallback`，否则 `failed` |
| 当前会话无出站目标 | 不发送 | `unsupported` |
| 平台超时或临时错误 | 有限重试后结束 | `failed`，不伪造送达 |

如果整组按钮中只有部分 URL 校验失败，首版采用“整组拒绝”，避免用户看到缺少按钮或语义不完整的导航卡。后续如有明确需求，再设计逐项过滤并向 Agent 返回详细但脱敏的结果。

## 12. 安全与权限

- 工具只使用当前请求绑定的会话目标，不接受 `user_id`、`chat_id`、`openid`、`receive_id` 等路由字段。
- URL 校验发生在工具入口和 Gateway 出站前两个边界；Gateway 不信任模型输出的原始链接。
- URL 查询参数可能包含用户数据、签名或临时凭证，不写普通日志、LoopScope 可见详情或工具展示气泡。
- 不自动抓取、预览或跟随按钮 URL，防止发送按钮过程引入 SSRF 或二次请求。
- 对外部域名只做静态安全校验；域名白名单由部署/平台配置管理，不允许模型动态扩大。
- 普通按钮不授予权限，不替代资源归属校验、confirm gate、CSRF 防护和后端鉴权。
- Web 端打开新窗口时使用 `noopener,noreferrer`；前端只渲染安全 URL，不使用 `v-html` 直接拼接按钮 HTML。

## 13. 实施拆分

### Phase 0：协议确认

- [x] 固化 `send_link_buttons` Schema、结果枚举和 URL 安全策略。
- [x] 确认 `keyboard` part 与现有 `PlatformReply` 的字段边界。
- [x] 确认 QQ 当前 action type、URL 白名单和真实客户端行为。
- [x] 产出飞书、QQ、Web、微信四渠道最小 payload 样例。

### Phase 1：统一出站 part

- [x] 在 `agent.im.models` 定义链接按钮 part 和能力声明。
- [x] 在 `agent.im.replies` 增加统一发送/降级分支。
- [x] 修正 QQ Keyboard 能力声明与实际发送路径不一致的问题。
- [x] 增加 URL 安全校验、长度限制、脱敏结果和错误分类。

### Phase 2：Agent 工具

- [x] 在 `agent.tools.meta` 注册 `send_link_buttons`。
- [x] 让 Web/IM 上下文可以生成受控出站 part。
- [x] 明确无出站上下文时的结构化 `unsupported` 结果。
- [x] 更新工具目录、Schema 快照和 Agent 提示中的使用边界。

### Phase 3：平台适配

- [x] QQ 映射跳转按钮 `action.type=0`，保留 `ask_user` 回调类型。
- [x] 飞书映射 `open_url` behavior，不接入静态链接回调。
- [x] Web 渲染安全按钮并补充无障碍标签。
- [x] 微信实现文本 URL 降级。

### Phase 4：观测与真实验收

- [x] 增加工具调用、原生发送、文本降级、失败和重试的 LoopScope 事件。
- [x] 在 QQ、飞书真实客户端验证 HTTPS 网页打开和平台不支持时的提示。
- [x] 验证按钮不会创建 pending interaction，不会阻塞或恢复 Agent Run。
- [x] 验证重复发送、平台超时和失败重试不会产生无限消息。

## 14. 测试计划

### 14.1 单元测试

- Schema 拒绝空消息、空按钮、超过 5 个按钮、重复 ID 和超长字段。
- URL 校验拒绝危险 scheme、空/超长/控制字符输入和凭据 URL。
- URL 校验接受合法 HTTP(S)、系统入口和自定义 App Scheme，不依赖域名白名单。
- 工具结果正确返回 `sent`、`sent_with_fallback`、`rejected`、`failed`、`unsupported`。
- `send_link_buttons` 不创建 `InteractionPrompt`，不调用 `consume_action()`。
- QQ 使用跳转 action type，现有 `ask_user` 仍使用回调 action type。
- 飞书使用 `open_url`，不生成 `card.action.trigger` token。

### 14.2 出站集成测试

- QQ 生成 Markdown + Keyboard payload，URL 不被替换成 opaque action token。
- 飞书生成包含 `open_url` behavior 的交互卡片。
- Web 按钮使用安全链接属性并正确显示标签。
- 微信生成可复制、可点击的文本 URL。
- 原生发送失败后只发送一次文本降级。
- 平台不支持时能力判断与实际降级结果一致。

### 14.3 Run 生命周期测试

- 工具调用完成后 Run 正常结束，不进入 `waiting interaction`。
- 最终回复不会重复发送同一批按钮内容。
- 工具失败不会被最终回复伪装成“已发送”。
- 发送过程异常不会破坏 canonical history 和 Run 收尾。

### 14.4 安全回归

- 按钮 URL 不进入普通可见日志、工具气泡或错误响应中的完整凭证参数。
- 跨用户、跨群、跨 Bot 不能指定按钮发送目标。
- URL 按钮不能绕过删除、覆盖、授权和其他 destructive 确认门。
- 前端不执行未经校验的脚本协议或 HTML 事件属性。

## 15. 验收标准

1. Agent 可以使用一个稳定、受控的工具发送 1～5 个链接按钮。
2. QQ 和飞书在能力可用时显示原生按钮，点击后打开 HTTPS URL。
3. Web 显示可访问的链接按钮；微信收到明确的文本 URL。
4. 原生按钮发送失败时，用户仍能获得可复制的 URL，并且工具结果准确反映降级。
5. 点击链接不会创建、消费或恢复 `ask_user` Prompt。
6. `ask_user` 的确认、选择、过期、重复点击和 Run 恢复行为不发生回归。
7. 不安全 URL 在发送前被拒绝，不产生平台出站请求。
8. 删除、覆盖、授权等业务动作仍走原工具权限与确认链路。
9. LoopScope 能区分工具调用、原生发送、文本降级、失败和最终 Run 状态。
10. 现有 Web、QQ、飞书、微信消息发送和 `ask_user` 测试全部通过。

## 16. 后续扩展

如果未来需要“点击按钮后通知咕咕并继续任务”，应新增明确的交互动作类型，例如 `await_click`，复用 `InteractionPrompt/Action` 的身份、过期和消费协议；不能把 `send_link_buttons` 改成隐式等待，也不能仅凭 URL 点击推断业务成功。

如果未来需要更强的平台治理，可以增加按平台的 Scheme 配置或审核状态；这不作为当前工具服务端的 URL 过滤前置条件。当前模型可以生成非危险自定义协议，但客户端是否支持由平台和操作系统决定。
