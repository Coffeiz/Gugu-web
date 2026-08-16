# 前端开发约定

- Vue 3 使用 `<script setup>`；新增代码保持现有渐进式 TypeScript 风格。
- `defineProps` 使用运行时对象写法，需要复杂类型时使用 `PropType`。
- 模板中的 `$event.target` 访问 DOM 属性时显式转型。
- 日期相减使用 `.getTime()`；日期归属复用 `frontend/src/utils/dateAttribution.ts`，不要直接截取 UTC 字符串。
- 空的 `ref(new Set())`、`ref([])` 显式标注元素类型。
- 已加入 `frontend/tsconfig.strict.json` 的文件不得降回宽松类型；新增稳定边界先通过 `npm run typecheck:strict`。
- 页面入口 `views/**/index.vue` 只负责布局、组件组合和流程调度。
- UI 交互放在 `components/`，状态和异步流程放在 `composables/`，请求放在 `api/` 或 service，纯逻辑放在 `utils/`。
- 新功能不要继续堆进入口文件；已有大文件按功能逐步收口。
- 复用现有组件、Store、设计变量和 `docs/development/design.md`，不要重复实现。
- 修改完成后按风险运行 typecheck、测试，并在 devserver 验证 UI。

## Runtime 动画 Ownership

Runtime 管理的元素，其业务或主题 CSS 不得使用 `!important` 强制覆盖 `transform`、`transition`、`opacity` 等由 Runtime 控制生命周期的属性。需要保留 hover、主题或静态状态时，应使用普通优先级的 token 规则，让 Runtime 的内联状态和动画阶段可以正常接管。

## HTML 与组件边界

- 不可信 HTML 必须经过 `frontend/src/utils/markdown.ts` 的消毒函数，禁止直接使用 `v-html`。
- 不手写未经转义的 HTML 字符串来拼接链接、属性或错误提示。
- 组件卸载后不要依赖 `emit()` 传递异步收尾事件；改用直接传入的函数引用。

跨项目的调试、安全和提交规则见根目录 `AGENTS.md`。
