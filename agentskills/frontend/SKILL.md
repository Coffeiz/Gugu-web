---
name: frontend
description: 前端开发约定。Vue 3 script setup、TypeScript 严格模式、文件组织、Runtime 动画所有权、HTML 安全边界。修改前端代码前必须阅读。
---

# 前端开发约定

## 代码风格

- Vue 3 使用 `<script setup>`；新增代码保持现有渐进式 TypeScript 风格。
- `defineProps` 使用运行时对象写法，需要复杂类型时使用 `PropType`。
- 模板中的 `$event.target` 访问 DOM 属性时显式转型。
- 日期相减使用 `.getTime()`；日期归属复用 `frontend/src/utils/dateAttribution.ts`。
- 空的 `ref(new Set())`、`ref([])` 显式标注元素类型。
- 已加入 `frontend/tsconfig.strict.json` 的文件不得降回宽松类型。

## 文件组织

- 页面入口 `views/**/index.vue` 只负责布局、组件组合和流程调度。
- UI 交互放在 `components/`，状态和异步流程放在 `composables/`，请求放在 `api/` 或 service，纯逻辑放在 `utils/`。
- 新功能不要继续堆进入口文件；已有大文件按功能逐步收口。
- 复用现有组件、Store、设计变量和设计文档，不要重复实现。

### Admin 页面拆分

- 修改 `views/Admin/**/index.vue` 时，如果文件已经包含多个独立模块、弹窗、表单区块或大量请求/状态逻辑，必须在本轮顺手拆分可独立部分，不得继续扩大入口文件。
- Admin 页面入口只保留布局、模块组合和流程调度；可复用 UI 放入 `components/`，状态与异步流程放入 `composables/`，请求和纯逻辑放入 service/utils。
- 新建与编辑流程应优先复用同一个表单组件，通过 props/emits 或明确的 composable 区分模式，避免在 `index.vue` 维护两套近似实现。
- 拆分必须保持现有 design token、权限边界、数据流和测试覆盖，避免为了形式上的拆文件引入全局状态或重复请求。

## Runtime 动画 Ownership

Runtime 管理的元素，其业务或主题 CSS 不得使用 `!important` 强制覆盖 `transform`、`transition`、`opacity` 等由 Runtime 控制生命周期的属性。需要保留 hover、主题或静态状态时，应使用普通优先级的 token 规则。

## HTML 与组件边界

- 不可信 HTML 必须经过 `frontend/src/utils/markdown.ts` 的消毒函数，禁止直接使用 `v-html`。
- 不手写未经转义的 HTML 字符串来拼接链接、属性或错误提示。
- 组件卸载后不要依赖 `emit()` 传递异步收尾事件；改用直接传入的函数引用。

## 验证

- 修改完成后按风险运行 typecheck、测试，并在 devserver 验证 UI。
- 完成功能或提交前运行完整 `npm run typecheck`；涉及 strict 白名单文件用 `npm run typecheck:strict`。

## PR 前本地 CI（GitHub Actions 已禁用）

提交 PR 前必须在本地完成以下检查，确保不引入回归：

```bash
cd frontend
npm run typecheck          # TypeScript 类型检查
npm run typecheck:strict   # strict 模式（涉及 strict 白名单文件时）
npm run test:run           # 单元测试（vitest 单次运行）
npm run build              # 构建验证
```

全部通过后再提交 PR。不需要等待 GitHub CI——本地通过即可。
