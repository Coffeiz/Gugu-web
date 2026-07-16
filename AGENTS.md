# AGENTS.md

本文件记录 Gugu-web 项目的开发约定，供后续开发/重构参考。技术栈见 [README.md](README.md)（前端 Vue 3 + TS，后端 FastAPI + Python，`requirements.txt` 管理依赖，无 `pyproject.toml`/`uv`）。

# 代码规范

## Python import 规范（backend/）

标准库和第三方库的导入按如下顺序排列：

1. `from ... import ...` 语法的导入放前面，`import ...` 语法的导入放后面。
2. 同语法下有多个导入项时，在**不引起 import 错误**的前提下按字母顺序排列。
3. 标准库/三方库的导入整体放在本地模块导入前面。
4. 各导入块之间用一个空行分隔。

本地模块（`app.*`、`agent.*` 等）用绝对导入；同目录下的模块可以用相对导入。

重构已有代码时，如果顺手碰到导入顺序不合规范的地方，调整到位；不为此单独开 PR/大范围整理。

## 注释与类型注解

- 重构时如果原代码有注释，功能不变的代码要保留注释（可以改措辞保持准确，但不要删）；原代码没注释、但代码块较长或逻辑复杂时，补一句说明。
- 重构时如果原代码有类型注解，要保留（可以改，但不要删）；原代码没有、但函数逻辑较复杂或参数较多时，补类型注解。简单变量不必强制加注解。
- 参数化泛型用 `typing` 模块（如 `List[int]`、`Dict[str, Any]`），不用裸 `list`/`dict`。

## 变量与属性访问

- 已经通过类型注解/上下文确定某变量一定是某类型时，不必再用 `or` 做防御性兜底——例如确定 `x: str`，直接 `x.strip()`，不写 `(x or "").strip()`。
- 少用 `getattr`/`setattr`，除非在处理动态类或 pytest monkeypatch；能直接访问类属性就直接写 `instance.value`，不写 `getattr(instance, "value", "")`。

## 时间与日期

- 后端业务时间一律用 `app.core.tz.now_utc()`，不直接调用 `datetime.utcnow()`/`datetime.now()`；新增时间列沿用 `UtcDateTime`/timezone-aware UTC 的既有模式。
- 存储使用 UTC，展示和“归属哪一天”的判断按用户时区转换；前端日期归属复用 `frontend/src/utils/dateAttribution.ts`，不要拿 UTC 字符串切片代替本地日期。

## API 请求体命名规范（backend ↔ frontend）

后端 Pydantic model 分两种命名风格，调前端 API 前先看清楚对应的是哪一种：

- 继承 `CamelModel`（`app/schemas/__init__.py`，`alias_generator=to_camel`）的接口，请求体用**驼峰命名**（如 `folderId`、`displayName`）——例如 `filesApi.update`/`filesApi.copy` 对应的 `FileUpdate`/`FileCopyBody`。
- 继承普通 `BaseModel` 的接口，请求体用**下划线命名**（如 `folder_id`、`project_id`）——例如 `filesApi.presign`/`filesApi.confirm` 对应的 `PresignRequest`/`ConfirmRequest`。

`CamelModel` 同时开了 `populate_by_name=True`，两种命名混用有时不会立刻报错（后端会兼容接受），但类型检查和代码可读性上仍要按接口实际声明的字段名写，不要凭记忆套用另一个接口的命名风格。

## Vue / TypeScript 规范（frontend/）

`frontend/tsconfig.json` 走渐进式迁移（`strict: false`、`noImplicitAny: false`），新写的 `.vue`/`.ts` 沿用以下已成型的写法，保持前后一致：

- `defineProps` 用运行时对象写法（`defineProps({ foo: String })`），需要复杂类型时用 `PropType<T>`（`type: Array as PropType<Foo[]>`），不要切换成编译时泛型写法（`defineProps<{...}>()`）。
- 模板里 `$event.target` 需要访问 DOM 属性/方法时显式转型，如 `($event.target as HTMLInputElement).select()`。
- `Date` 相减求天数/毫秒差要用 `.getTime()`，不要直接对两个 `Date` 对象做算术运算。
- `ref(new Set())`/`ref([])` 这类空初始值容易被推断成 `Set<unknown>`/`any[]`，显式标注元素类型（如 `ref(new Set<number>())`）。
- `frontend/tsconfig.strict.json` 是文件级 strict 棘轮：已在白名单里的文件不得降回宽松类型；新增文件或完成一个稳定边界后，先 strict-clean 再加入白名单。涉及白名单或其依赖闭包时必须跑 `npm run typecheck:strict`。

## HTML 渲染

- 禁止把不可信字符串直接交给 `v-html`。Markdown/HTML 必须走 `frontend/src/utils/markdown.ts` 的 `sanitizeHtml` / `sanitizeChatHtml` / `renderMarkdown`；预渲染 HTML 也同样不可信。
- 不要手写 HTML 字符串插值来拼链接、属性或错误提示。确需扩展 Markdown 渲染时，保持协议白名单和属性转义；聊天专用 `gugu://` 仅能经聊天消毒路径放行，不能扩大到通用 sink。

## Debug 原则

不要靠 fallback/兜底掩盖问题。哪里出错就让它完整暴露出来，优先精准定位问题核心，再谈怎么修——兜底逻辑难以维护，也会让真实问题更难被发现、被反复踩坑。

**连续 2-3 轮读代码猜都猜不中，立刻换成实测手段**：静态读代码推理时序/CSS 优先级/跨组件调用链这类问题，容易系统性想错方向——改一版猜中一个症状，暴露或引入另一个，反复几轮都收敛不了。出现这种"改了又崩"的信号后不要继续加猜测式补丁，改用能拿到真实运行时数据的手段，按问题所在层选工具：
- 布局/动画/CSS 时序问题：Chrome DevTools 性能录制（Performance trace），导出 JSON 后按 `nodeId` 过滤 `Animation`/`LayoutShift` 事件重放真实的 class 组合和 DOM 坐标变化。
- 视觉表现类问题（"看起来卡住了""闪了一下"）：截手机/桌面录屏，`ffmpeg -vf fps=30` 逐帧抽帧后按 `Read` 工具挨个看关键帧，比反复读代码猜时序直接。
- 跨组件/跨模块调用链断在哪一环：不要继续读多层 prop/emit 透传代码找茬，直接在链路每一跳各打一行 `console.log`，一次测试就能定位断点。用完记得清理探针，别留在提交里。

## Vue 组件卸载后 emit() 静默失效

Vue 对已卸载组件实例调用 `emit()` 会静默不转发给父级监听器（不报错、不警告）。这类坑通常出现在"异步回调触发时，发起该回调的组件早已因为同一次操作被卸载"的场景——例如乐观更新先把数据摘掉、组件跟着被卸载，随后才触发的收尾回调（动画结束、接口返回等）。这类跨组件的后续通知不要用 `emit`，改用直接下发的函数引用（当 prop 传，不当 event 发），不依赖 Vue 组件实例的存活状态。

# 安全规范

- **聊天内容不落原文日志**：任何 `print`/日志碰到用户消息正文（IM 收到的消息、发给用户的回复、附件文件名等），一律走 `agent/logsafe.py` 的 `fingerprint()`（长度 + md5 前 8 位指纹），不直接打印原文。后台 Debug 面板把日志变成可搜索的了，一旦原文落进去就等于可被随意翻查——聊天内容敏感度高于工具参数（可能涉及健康/感情/工作机密）。新增 IM 适配器（`agent/adapters/*.py`）或任何打印用户输入的地方都要过这一遍。
- **错误信息走双出口**：`gugu.log`、SystemLog 和 Debug 面板都是可见出口，禁止写原始 `str(e)`、traceback、上游响应体或聊天正文。跨边界/可见日志的错误文案必须走 `app.core.redaction.redact()`；原始异常仅用 `diag_log()`/`diag_log_raw()` 写入受限诊断出口。`app.*` 不得反向 import `agent.*` 来复用脱敏逻辑。
- **异常分类与重试**：业务可预期失败用 `ExpectedError`，瞬时外部失败用 `RetryableError`（`code` + 固定 `public_message` + `cause`）；未知异常让链路边界记录并降级，不在中途宽泛吞掉。重试只适用于幂等操作或带幂等/去重键的写操作；4xx、认证/参数错误和已产生副作用的操作不得盲重试。
- **外部 URL 与文件边界**：新增网络抓取/转发能力复用既有 URL 安全校验；禁止在只校验首跳后自动跟随重定向，每一跳都要重新校验。不要绕过文件上传大小限制、存储 key 规范或下载时的归属校验。
- **跨用户数据访问必须走 `get_owned()`**：查询「某条记录是不是当前用户的」一律用 `app/core/ownership.py` 的 `get_owned(db, model, obj_id, user_id)`，不要手写 `db.get(...) + if row.user_id != user_id`。`get_owned` 对外把「不存在」和「不是你的」统一返回 `None`（防止通过报错差异探测资源是否存在），对内在越权时打结构化告警（`ownership.denied`，接到运维监控的安全事件计数）。有静态守卫拦裸查询，新增 REST 路由/工具时留意别绕过。
- **不可逆操作必须挂确认门**：新增的 destructive 工具（删除、清空等不可逆动作）在 `Tool` 定义里标 `destructive=True`，并在 handler 里正确接入 `confirm` 机制（`agent/tools/base.py` 里 dispatch 有运行时绊线兜底，但不能靠兜底——`scripts/check_confirm_gate.py` 会做 AST 静态检查，要求源码里真的引用了确认门逻辑，漏接会在检查阶段被拦下来）。
- **认证与密钥边界**：不得把 token、密钥或凭据写进 URL、日志、异常、前端响应或 Git；新增认证/注册/重置等可滥用入口时接入既有 `rate_limit`，重置链接使用服务端规范 base URL，不信任请求 `Origin` 生成外链。

# 开发/调试流程

## 本地开发环境

Gugu-web 不是本地起服务调试——本地编辑代码，通过 Mutagen 双向同步（session 名 `gugu-web`）同步到 devserver（`192.168.110.51`），改动生效后在 devserver 上跑 `npm run typecheck`/`npm run build`（前端）或触发进程重载（后端）来验证。改完代码记得先 `mutagen sync flush gugu-web` 再去 devserver 验证，否则测的是旧代码。

## 验证门禁

- 开发阶段不要每次修改后都跑完整 typecheck，保持快速反馈。
- UI、样式、动画、探针、调试类修改：优先通过 dev server 和浏览器验证。
- 类型、接口、Store、API 等结构变化：需要执行 typecheck；涉及 strict 白名单/类型边界再跑 `npm run typecheck:strict`。
- 完成功能或提交前执行完整 typecheck；有行为或纯函数改动时跑 `npm run test:run`。
- 后端变更同步后在 devserver 跑 `PYTHONPATH=. .venv/bin/pytest`。改到用户归属或 destructive 工具时，额外跑 `scripts/check_ownership.py` 与 `scripts/check_confirm_gate.py`。
- P2-b 相关的外部 I/O/适配器改动，测试至少覆盖瞬时失败重试、4xx 不重试、非幂等写不盲重试，以及外发/可见日志不泄露原始异常。

## IM 网关重启

`agent/adapters/{qq,feishu,wechat}.py` 由 `agent/adapters/supervisor.py` 分别拉起独立子进程管理。改了某个平台的代码后，只需要 `kill -TERM` 对应平台的子进程 PID，supervisor 的 reconcile 循环会自动把它重新拉起（这是它的设计职责）；**不要**重启整个 `gugu-supervisor.service`，那样会连累其他两个平台的长连接一起断开。重启生产环境的机器人进程会影响真实用户，动手前应该先跟用户确认。

# 语言规范

注释、日志、面向用户的文案统一用简体中文——前端 UI 文案、后端日志输出、commit message、本文件在内的项目文档均适用。

# Changelog 编写

`CHANGELOG.md` 现有分类是 安全 / 改进 / 新增 / 修复。写条目时留意区分「用户能感知到的变化」和「纯开发侧改动」（内部重构、API 调整、依赖升级），必要时在描述里点明是哪一类，方便读的人跳过跟自己无关的部分。版本号提升、常规依赖升级这类不需要单独写一条。

**条目本身要简短**：粗体标题后可以带一个括号，只放涉及的文件/模块名（方便以后定位代码），不带函数名/参数名/行号；正文一句话说清「更新了什么功能/修了什么问题」，不展开实现细节和过程。

**详细调试记录与 changelog 分开**：踩坑排查的完整过程（真因定位、多次尝试、"教训"总结）写进 `docs/devlog.md`，按 `## YYYY-MM-DD · 标题` 分节，不写进 CHANGELOG.md。两者关联用纯文本日期指针（如「详见 [devlog.md](docs/devlog.md) 2026-07-06 条目」），不用 GitHub 锚点（中英文混排标题生成的锚点不稳定）。写之前先看 devlog.md 是否已有当天对应条目，避免重复记录。
