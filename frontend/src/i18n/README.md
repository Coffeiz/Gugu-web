# i18n 目录与编写规范

本目录集中管理 Gugu Web 的界面文案、语言注册和本地化测试。组件只能通过 `vue-i18n` 读取文案，不应直接导入某个语言文件。

## 目录结构

```text
i18n/
├── locales/
│   ├── zh-CN.ts          # 简体中文基础文案
│   ├── ja-JP.ts          # 日文基础文案
│   └── en-US.ts          # 英文基础文案
├── sections/
│   ├── profileTool.ts    # 个人工具与 SMTP 文案
│   ├── profileAccount.ts # 个人账号设置文案
│   ├── canvas.ts         # 画布文案
│   ├── adminAgent.ts     # 管理员 Agent 文案
│   ├── common.ts         # 通用 patch 与兼容性补充
│   └── ...               # 其他页面或功能 section
├── messages.ts           # 组装所有语言消息
├── registry.ts           # 唯一语言注册入口
├── index.ts              # i18n 实例与语言切换 API
├── types.ts              # 支持的语言和语言选项
└── *.test.ts             # i18n 单元测试
```

## 编写规范

### 新增文案

1. 按页面或功能将文案放入对应的 `sections/<feature>.ts`。
2. 同时补充 `zh-CN`、`ja-JP` 和 `en-US` 三种语言。
3. 保持三种语言的 key 名称和嵌套结构一致。
4. `messages.ts` 只负责导入、组装、应用 patch 和导出类型，不直接写 UI 文案。
5. 跨页面通用文案或历史兼容 patch 才放入 `sections/common.ts`。

section 推荐使用按语言分组的结构：

```ts
export const exampleUi = {
  'zh-CN': { title: '示例', save: '保存' },
  'ja-JP': { title: '例', save: '保存' },
  'en-US': { title: 'Example', save: 'Save' },
} as const
```

### Key 命名

- 使用稳定、可读、描述用途的 camelCase，例如 `saveSuccess`、`smtpPasswordKeep`。
- 按功能对象分组，例如 `profileToolUi.smtpTest`。
- 不使用中文、拼音、数字序号或视觉位置命名，例如 `button2`、`左侧标题`。
- 同一语义复用已有 key；只有语气、上下文或参数不同才新增 key。
- 参数使用 vue-i18n 插值，不拼接用户输入。

### 文案内容

- 中文使用简体中文；英文和日文需表达自然含义，不机械逐字翻译。
- 保留产品名、API 名、文件名、命令和技术标识的原文格式。
- 文案保持简短，按钮优先使用动词，提示只保留必要信息。
- 标点、空格、大小写和换行应符合目标语言习惯。
- 不写入 token、密钥、邮箱、真实用户名或其他用户数据。
- 不把 HTML 拼进文案，需要格式化时使用受控插值或安全渲染组件。

### 组件使用

组件、composable 和 service 使用 `$t` 或 `useI18n()`，不直接导入 `locales/*.ts`，也不在模板或脚本中硬编码面向用户的文案。错误、成功和确认提示同样必须使用 i18n。

## 校验与提交流程

在 `frontend/` 目录执行：

```bash
npm run i18n:scan
npm run test:run -- src/i18n
npm run typecheck
npm run build
```

提交前确认三种语言的 key 集合一致、没有硬编码文案或错误语言路径、`messages.ts` 仍只负责组装，并通过 `git diff --check`。
