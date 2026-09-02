# Common 组件目录规范

本目录存放跨页面复用的展示组件、交互组件和基础布局组件。页面专属组件应放在对应的 `views/<Page>/components/`，不要因为组件体积较小就放入 `common/`。

## 目录结构

```text
components/common/
├── auth/          # 登录、注册和认证页公共组件
├── content/       # Markdown、引用建议等内容展示
├── controls/      # 输入、选择、切换、日期和排序控件
├── feedback/      # Toast、通知、反馈和支持入口
├── file-browser/  # 文件浏览、预览、上传和回收站公共组件
├── gugu-chat/     # GuguChat 公共窗口及其专属 composables
├── icons/         # 图标组件与注册表
├── layout/        # 品牌、侧栏、搜索和公共布局
├── mind/          # Mind 卡片的公共视觉/交互组件
├── overlays/      # Modal、Confirm、Popup、ContextMenu 等弹层
├── profile/       # 个人设置及其公共面板
├── viewers/       # 图片、PDF、文本和视频查看器
└── tests/         # 仅存放 common 组件级测试
```

目录按“组件职责”划分，不按页面名称划分。`common/mind` 表示跨 Mind 页面或被公共区域使用的 Mind 组件；只服务笔记页的组件仍应放在 `views/Mind/components/`。

## 放入 common 的条件

组件满足以下条件之一，才适合放入本目录：

- 已被两个或以上页面使用。
- 代表产品级统一交互，例如 `ConfirmDialog`、`BaseModal`、`AppToast`、通用控件或公共布局。
- 是一个有明确独立边界的基础展示能力，例如文件预览器或图标注册表。

只有一个页面使用的组件，即使看起来通用，也先放页面目录。第二个真实调用方出现后，再抽取并补充公共 API。

## 组件边界

- 组件负责模板、样式、DOM 交互和展示状态。
- 可复用状态和异步流程放在 `src/composables/` 或组件目录内的专属 `composables/`。
- 请求和数据转换放在 `api/`、service 或 utils，不在公共组件内复制接口调用。
- 公共组件不能依赖具体页面入口、页面私有 store 或页面 DOM 选择器。
- 通过 props、emits 和明确的函数引用传递业务差异，不在公共组件内判断具体页面路由。
- 不为了复用而把所有业务选项塞进一个万能组件；当语义不同，应拆成清晰的领域组件。

## 样式规范

- 优先使用现有 design token、主题变量和公共视觉类。
- 同一元素只保留一份主样式定义，避免组件 scoped CSS、全局 CSS 和页面 CSS 重复覆盖。
- 公共组件不得使用 `!important` 覆盖 Runtime 管理的 `transform`、`transition` 或 `opacity`。
- 弹层必须使用统一的层级注册和关闭规则，不能自行复制一套 z-index/ESC 处理。
- 视觉变体通过 token、明确的 modifier class 或 props 表达，不在页面中覆盖公共组件内部细节。

## 交互与安全

- 删除、重置、覆盖、停用等危险动作必须使用统一 `ConfirmDialog` 和 `useConfirmDialog`。
- 成功、失败和状态反馈使用 AppToast 或页面内提示，禁止直接使用浏览器原生 `alert`、`confirm`、`prompt`。
- 不可信 HTML 必须经过统一 Markdown 消毒流程，公共组件不得直接渲染未经处理的 `v-html`。
- 公共组件卸载时必须清理监听器、定时器、Observer、Portal 和异步任务。
- 组件中的可见错误文案必须经过 i18n；诊断日志不得包含聊天正文、附件名或凭据。

## 测试与新增组件

- 公共组件至少覆盖关键 props/emits、主题变体、键盘/关闭行为和危险操作取消路径。
- 组件级测试放在组件附近或 `common/tests/`，页面流程测试放在对应页面测试目录。
- 新增公共组件时，在本 README 的目录结构中补充归属，避免出现无主目录。
- 从页面抽取组件时，先保持现有 DOM 结构、设计 token、层级和事件语义，再进行内部清理。
- 修改公共组件后运行前端 typecheck、受影响测试；涉及样式或弹层时补充浏览器可见验证。
- 公共组件目录调整后应同步检查页面端和管理端的引用。
