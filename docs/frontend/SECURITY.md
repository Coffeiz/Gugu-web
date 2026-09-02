# 前端安全规则

## 请求与身份

- 普通 API 请求统一复用 `frontend/src/services/api.ts`，不得在页面中复制鉴权、CSRF 或错误解析逻辑。
- 用户请求使用 `user_token`，后台请求使用独立的 `admin_token`；Token 不得进入 URL、可见日志、错误文案或提交记录。
- 非安全方法请求自动携带 `X-CSRF-Token`；写操作自动携带当前标签页的 `X-Client-Id`，用于 Live 回声识别。
- 权限校验以服务端为准。前端路由守卫和按钮隐藏只负责体验，不能作为数据访问边界。
- 401 由请求层统一清理用户登录态并跳转登录；业务组件不要自行复制这套处理。

## HTML、Markdown 与链接

- `v-html` 只能接收 `frontend/src/utils/markdown.ts` 导出的安全渲染结果。
- Markdown 必须经过 `DOMPurify`；不要直接把用户输入、后端返回 HTML 或流式 HTML 写入 DOM。
- 普通 Markdown 只允许安全链接协议；聊天动作链接 `gugu://` 只能通过 `sanitizeChatHtml`，并交给受控的动作匹配器处理。
- 外部链接统一使用 `target="_blank"` 和 `rel="noopener noreferrer"`；禁止拼接未经转义的 href、title 或 HTML 属性。
- Mermaid、代码高亮和任务列表可以保留专用动态 DOM，但必须沿用现有消毒和事件委托边界。

## 凭据与敏感数据

- 密码、API Key、SMTP 密码、绑定码和上传文件只存在于必要的表单或请求生命周期内，不写入 localStorage、日志、URL 或 Git。
- BYOK、SMTP、修改密码、头像上传等操作使用显式保存和服务端确认，不做乐观展示或自动回填秘密值。
- 用户输入和附件名不得写入可见诊断日志；需要关联时使用 fingerprint 或现有脱敏工具。
- 错误提示展示经过服务端允许的可见信息；原始异常仅进入受控诊断通道。

## 危险操作与组件边界

- 删除、重置、覆盖、停用、清空数据和注销账号必须使用 `useConfirmDialog` / `ConfirmDialog`。
- 禁止在 Vue 源码中调用原生 `alert`、`confirm`、`prompt`。
- 公共组件不能依赖页面私有 DOM 选择器来做权限判断或安全处理。
- 新增外部请求、富文本能力或凭据字段时，必须同时补充协议白名单、输入边界和失败路径测试。
