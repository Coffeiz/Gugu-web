# PRD-UI-6 Phase 1 验收记录

> 日期：2026-08-30

## 结论

Phase 1 已完成。Phase 2 的项目、文件、日历、思维内容区、咕咕聊天和 Admin 业务表单仍未宣称完成，继续按 PRD 单独迁移。

## 已交付

- 接入 `vue-i18n`，支持 `zh-CN`、`ja-JP`、`en-US`。
- 通过 `frontend/src/i18n/registry.ts` 提供唯一 locale 注册入口。
- 未显式选择语言时按浏览器语言族适配；显式选择后立即切换并持久化到用户偏好和本地存储。
- 后端偏好接口接受并返回受支持的 `locale` 值。
- 共享侧栏、布局、认证页、通用 toast、确认框、搜索控件和 API 基础 HTTP 错误使用 locale 文案。
- 提供日期、数字、百分比、相对时间和文件大小 formatter。
- 个人设置的语言选项使用 `frontend/src/i18n/types.ts` 中的各语言原生名称（简体中文、日本語、English），切换后选项本身保持稳定，避免无法识别当前目标语言；`frontend/src/i18n/index.test.ts` 对此行为有回归断言。
- 用户输入、项目名、文件名、Markdown、Agent 回复和通知正文仍按内容边界原样展示。

## 验证

- `pnpm --filter gugu-web typecheck` 通过。
- `pnpm --filter gugu-web exec vitest run src/i18n src/utils/formatters.test.ts` 通过：3 个测试文件、8 个测试。
- `git diff --check` 通过。

Node 版本提示和 Vite 配置提示属于现有环境警告，不影响上述检查结果。
