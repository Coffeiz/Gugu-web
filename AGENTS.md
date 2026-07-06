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

## Debug 原则

不要靠 fallback/兜底掩盖问题。哪里出错就让它完整暴露出来，优先精准定位问题核心，再谈怎么修——兜底逻辑难以维护，也会让真实问题更难被发现、被反复踩坑。

# 安全规范

- **聊天内容不落原文日志**：任何 `print`/日志碰到用户消息正文（IM 收到的消息、发给用户的回复、附件文件名等），一律走 `agent/logsafe.py` 的 `fingerprint()`（长度 + md5 前 8 位指纹），不直接打印原文。后台 Debug 面板把日志变成可搜索的了，一旦原文落进去就等于可被随意翻查——聊天内容敏感度高于工具参数（可能涉及健康/感情/工作机密）。新增 IM 适配器（`agent/adapters/*.py`）或任何打印用户输入的地方都要过这一遍。
- **跨用户数据访问必须走 `get_owned()`**：查询「某条记录是不是当前用户的」一律用 `app/core/ownership.py` 的 `get_owned(db, model, obj_id, user_id)`，不要手写 `db.get(...) + if row.user_id != user_id`。`get_owned` 对外把「不存在」和「不是你的」统一返回 `None`（防止通过报错差异探测资源是否存在），对内在越权时打结构化告警（`ownership.denied`，接到运维监控的安全事件计数）。有静态守卫拦裸查询，新增 REST 路由/工具时留意别绕过。
- **不可逆操作必须挂确认门**：新增的 destructive 工具（删除、清空等不可逆动作）在 `Tool` 定义里标 `destructive=True`，并在 handler 里正确接入 `confirm` 机制（`agent/tools/base.py` 里 dispatch 有运行时绊线兜底，但不能靠兜底——`scripts/check_confirm_gate.py` 会做 AST 静态检查，要求源码里真的引用了确认门逻辑，漏接会在检查阶段被拦下来）。

# 开发/调试流程

## 本地开发环境

Gugu-web 不是本地起服务调试——本地编辑代码，通过 Mutagen 双向同步（session 名 `gugu-web`）同步到 devserver（`192.168.110.51`），改动生效后在 devserver 上跑 `npm run typecheck`/`npm run build`（前端）或触发进程重载（后端）来验证。改完代码记得先 `mutagen sync flush gugu-web` 再去 devserver 验证，否则测的是旧代码。

## IM 网关重启

`agent/adapters/{qq,feishu,wechat}.py` 由 `agent/adapters/supervisor.py` 分别拉起独立子进程管理。改了某个平台的代码后，只需要 `kill -TERM` 对应平台的子进程 PID，supervisor 的 reconcile 循环会自动把它重新拉起（这是它的设计职责）；**不要**重启整个 `gugu-supervisor.service`，那样会连累其他两个平台的长连接一起断开。重启生产环境的机器人进程会影响真实用户，动手前应该先跟用户确认。

# 语言规范

注释、日志、面向用户的文案统一用简体中文——前端 UI 文案、后端日志输出、commit message、本文件在内的项目文档均适用。

# Changelog 编写

`CHANGELOG.md` 现有分类是 安全 / 改进 / 新增 / 修复。写条目时留意区分「用户能感知到的变化」和「纯开发侧改动」（内部重构、API 调整、依赖升级），必要时在描述里点明是哪一类，方便读的人跳过跟自己无关的部分。版本号提升、常规依赖升级这类不需要单独写一条。
