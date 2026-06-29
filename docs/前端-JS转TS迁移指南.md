# 前端 JS → TS 迁移指南 + Roadmap

> 适用范围：`frontend/`（Vue 3 + Vite）。后端是 Python/FastAPI，与本文无关。
> 状态：工具链已就绪（2026-06-30），处于**增量迁移**阶段。

---

## 1. 为什么做 / 可行性

把前端从 JS 渐进迁到 TS，拿到类型安全、重构信心、更好的编辑器提示。

可行性高——最硬的活儿已经不存在：

| 指标 | 数据 | 含义 |
|---|---|---|
| `.vue` 文件 | 64 个（30.3k 行） | 中等规模 |
| `.js` 文件 | 34 个（3.1k 行） | 逻辑/store/composable/util |
| **`<script setup>`** | **62 / 64**，Options API **0 个** | ✅ 无范式重写，迁移≈「加 `lang="ts"` + 标注类型」 |
| `defineProps` | 27 文件**全对象式**，数组式 0 | ✅ 易加类型 |
| 第三方依赖类型 | 几乎全自带（pinia/axios/vue/marked/dayjs/chart.js/phosphor/arco/pdfjs…） | ✅ 仅 `qrcode` 可能需 `@types/qrcode` |

**结论：低难度、低风险、可增量、永不阻塞功能。** 主要成本在「建领域类型」+「啃 5 个巨型文件」（见 §6）。

---

## 2. 工具链现状（已搭好）

| 文件 | 作用 |
|---|---|
| `frontend/tsconfig.json` | `allowJs:true` + `checkJs:false` + `strict:false` 起步 —— **JS/TS 共存，存量 `.js` 不检查，只查新写的 `.ts` / `lang="ts"`**；配了 `@/*` 别名、`vite/client` 类型 |
| `frontend/src/vite-env.d.ts` | `vite/client` 引用 + `__APP_VERSION__` 声明 |
| `frontend/vite.config.js` | AutoImport / Components 的 `dts` 已开 → 自动生成 `auto-imports.d.ts`（`ref`/`computed`/`watch`…）、`components.d.ts`（Arco 组件），**否则 vue-tsc 不认识这些自动导入的全局名** |
| `frontend/.gitignore` | 忽略两个生成的 dts + `*.tsbuildinfo`（每次 vite 运行自动重建，不入库） |
| `package.json` | `"typecheck": "vue-tsc --noEmit"`；devDeps：`typescript@~5.6` + `vue-tsc@~2.1` |

**类型检查命令**：

```bash
cd frontend
npm run typecheck      # vue-tsc --noEmit，绿 = 0 错
```

当前基线：**绿（exit 0）**。已用「故意写错的 .ts」验证门禁确实会抓错（`TS2322`），不是摆设。

---

## 3. 日常约定（强制）

> 长期偏好：**新代码一律 TS，不再新建 `.js`；改到的 JS 顺带转 TS。**

- **新文件**：
  - 组件 → `<script setup lang="ts">`
  - 逻辑/composable/store/util → `.ts`
- **顺带迁移**：因修 bug / 加功能动到某文件时：
  - `.vue` → 把 `<script setup>` 改成 `<script setup lang="ts">`（**不改文件名，最安全**），补类型
  - `.js` → rename 成 `.ts`，补类型（不求完美、能过 `typecheck` 即可）
- **不主动批量转换**存量——只转触碰到的，避免不相关的大 diff（项目有并发提交，**大爆炸重写会撞车**）。
- 写完跑一次 `npm run typecheck` 确认没把门禁带红。

---

## 4. 转换操作细则 / 注意事项

### 4.1 `.vue` 转 lang=ts
最省事：只改 `<script setup>` → `<script setup lang="ts">`。然后 vue-tsc 会**连模板一起**类型检查，按提示补：
- `defineProps` → 用泛型式：`defineProps<{ id: number; title?: string }>()`（替代运行时对象式）
- `defineEmits` → `defineEmits<{ (e: 'save', id: number): void }>()`
- 模板 ref → `const el = ref<HTMLElement | null>(null)`；组件 ref → `ref<InstanceType<typeof Foo> | null>(null)`

### 4.2 `.js` rename `.ts` 的坑
- Vite 无后缀 import 两者都解析，**但别处用显式 `.js` 后缀** import 该文件会断。转前先 grep：
  ```bash
  grep -rn "from '.*<文件名>\.js'" frontend/src
  ```
- `services/api.js` 是**类型咽喉**：把请求/响应泛型化后，类型顺着 api → store → 组件全链路自动流，优先转。

### 4.3 自动导入
项目用 `unplugin-auto-import`，`ref`/`computed`/`watch`/`defineProps` 等**全局可用、可不显式 import**。`dts` 已开，vue-tsc 认得。但**新代码建议显式 import**（TS 下更清晰、利于 tree-shaking 判断）。

### 4.4 SMB / devserver 注意
- 在 SMB 盘开发：git 必设 `core.fileMode false`（已设），否则满屏 filemode 假改动。
- `npm install` 必须在 **devserver（Linux）** 跑，别在 Mac 上对 SMB 装 —— esbuild 等有平台二进制，会错乱。
- 改 `tsconfig` / `vite.config` 后 vite 会自动重启；`auto-imports.d.ts` / `components.d.ts` 随之重建。

---

## 5. 类型怎么建（按收益排序）

1. **领域实体类型（最高收益）**：后端是 Pydantic，**用 OpenAPI 一键生成**，顺带前后端对齐：
   ```bash
   cd frontend
   npx openapi-typescript http://127.0.0.1:8000/openapi.json -o src/types/api.ts
   ```
   拿到 Project / Event / File / Stage / Todo / Message 等类型，替代手搓对象（`normalizeEvent` 之类）。
2. **api 层**：`services/api.js` → `.ts`，请求/响应套上 §1 生成的类型。
3. **stores（12 个）**：Pinia 原生 TS，setup store 类型很顺。
4. **composables（11 个）**：通常干净好类型；`usePhysicsDrag` 这种重逻辑较费劲。
5. **utils（5 个）**：纯函数，最易转，可当练手。

---

## 6. Roadmap（分阶段）

> 原则：每阶段结束 `npm run typecheck` 必须绿；增量推进，不阻塞功能开发。

### ✅ 阶段 0 · 工具链（已完成，2026-06-30）
- [x] `tsconfig.json`（allowJs / checkJs:false / strict:false）
- [x] `vue-tsc` + `typecheck` 脚本，基线绿 + 门禁验证
- [x] AutoImport/Components dts、`vite-env.d.ts`、`.gitignore`

### ✅ 阶段 1 · 类型地基（已完成，2026-06-30）
- [x] OpenAPI 生成 `src/types/api.ts`（7468 行；`npm run gen:types` 一键重生，需后端 dev 在 :8000）
- [x] `services/api.js` → `api.ts`：`request`/`get`/`post`… 泛型化（默认 `any` 不阻塞存量）；projects/events/files/folders/clients/preferences 用 OpenAPI 类型标注返回值，其余留 `any` 待增量升级
- [x] ~~补 `window.*` 自定义全局的 `global.d.ts`~~ —— **实测不需要**：109 处 `window.*` 全是标准属性读取，无自定义全局赋值
- [x] `@types/qrcode` 已装（qrcode 用在 GuguChat/ProfileModal，转 ts 时会用到）

> 备注：`src/types/api.ts` 是生成物但**入库**（这样 CI/`typecheck` 不依赖后端在跑）；改了后端模型后跑 `npm run gen:types` 重生并提交。

### 阶段 2 · 低风险层（~2–4 天）
- [ ] `utils/`（5）→ ts（练手）
- [ ] `stores/`（12）→ ts
- [ ] `composables/`（11）→ ts（`usePhysicsDrag` 留到最后）
- [ ] 小型 `components/`（22 里的简单件）→ lang=ts

### 阶段 3 · 巨型视图（主要工作量，~3–5 天）
> 这 5 个文件 ≈ 37% 代码、≈80% 的痛，**配合功能迭代逐个转**、别集中硬啃：
- [ ] `views/Projects/components/ProjectModal.vue`（3017 行）
- [ ] `views/Files/index.vue`（2760）
- [ ] `views/Calendar/index.vue`（2313，含拖拽/网格）
- [ ] `views/Admin/Agent/index.vue`（2294）
- [ ] `components/common/GuguChat.vue`（2143，聊天流）

### 阶段 4 · 收紧 + 守门（~1–2 天）
- [ ] 全量绿后，`tsconfig` 渐进开严：`noImplicitAny` → `strict` 子项 → `strict:true`
- [ ] CI / 部署流程加 `npm run typecheck` 门禁（红则挡）
- [ ] 存量 `.js` 清零后，`tsconfig` 关 `allowJs`

**工时估**（单人，增量）：全量 strict 约 **1.5–2.5 周**；但阶段 1 几小时即可拿到大半收益，其余随功能推进。

---

## 7. 常见报错速查

| 报错 | 原因 / 处理 |
|---|---|
| `Cannot find name 'ref'`（lang=ts 文件） | auto-import dts 没生成 → 重启 vite，或新代码直接显式 `import { ref } from 'vue'` |
| `Cannot find module '@/...'` | tsconfig `paths` 已配 `@/*`；确认文件真实存在、后缀正确 |
| 模板里组件标红（Arco `<a-xxx>`） | `components.d.ts` 没生成 → 重启 vite 让 unplugin 重建 |
| rename `.js`→`.ts` 后某处 import 断 | 有显式 `.js` 后缀 import，改掉后缀（见 §4.2） |
| `npm install` 后 vite 起不来 | 是否在 Mac 上对 SMB 装的？去 devserver（Linux）重装（见 §4.4） |

---

*维护：随阶段推进勾选 Roadmap；约定见记忆 `gugu-ts-migration`、`gugu-smb-sync`。*
