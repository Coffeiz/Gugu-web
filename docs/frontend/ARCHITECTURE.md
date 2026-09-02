# 前端架构规则

## 启动与路由

- `frontend/src/main.ts` 负责版本门、主题、按钮反馈、Runtime、Pinia、i18n、路由和公共组件注册的启动顺序。
- `router/index.ts` 负责路由、登录态和页面级访问前置条件；不要在页面组件中复制全局登录跳转。
- `layouts/` 负责页面壳层，`views/` 负责页面组合与流程调度；复杂入口应把状态和请求拆到 composables 或 service。

## 分层职责

```text
views / components
        ↓
业务 composables
        ↓
stores / interaction adapters
        ↓
services / api / utils
```

- 公共组件只负责模板、样式、DOM 交互和展示状态，不直接依赖页面入口或私有路由。
- `composables/` 承载 Vue 生命周期、局部状态、异步流程和业务编排；纯计算进入 `utils/`。
- `stores/` 持有跨组件或跨页面状态，并负责与 API、Live、缓存和回滚协作；不要在多个页面各自维护同一份服务器实体。
- `services/api.ts` 是请求协议入口；请求路径、鉴权、CSRF、客户端身份和通用错误转换不在组件内复制。
- i18n 文案按 `frontend/src/i18n/sections/` 注册，组件不得新增硬编码用户可见文案。

## InteractionSync 与 Runtime

- 单值偏好、高频拖拽和可明确回滚的即时操作使用 `InteractionSync.execute`，由调用方提供 apply、rollback 和 request。
- 密码、凭据、上传、多字段显式保存和危险操作保留服务端确认语义，不强行乐观化。
- Live 事件通过 `X-Client-Id` / origin 做同客户端回声抑制；其他客户端事件必须进入对账流程，不能无条件覆盖 pending 本地意图。
- Runtime 只拥有拖拽、landing、proxy、surface 和生命周期视觉状态；业务侧只注册 object/surface，并通过 adapter 提供业务持久化、权限和实体映射。
- Runtime 管理的节点不得由业务层额外推断 phase、合成 mouseenter 或重复控制 opacity/transform；遇到闪烁先排查节点身份、刷新和事件竞态。

## 状态与请求

- 读取、写入、乐观 apply、服务端确认和失败 rollback 要区分状态源。
- 连续写入使用稳定的 scope/entityKey 或等价 intent key；旧请求失败不能回滚更新的本地意图。
- 成功响应包含服务端规范化字段时，以服务端快照收敛；不能在成功后用可能过期的全量 GET 覆盖更晚的本地操作。
- 组件卸载时清理监听器、定时器、Observer、轮询、Teleport 和未完成的 UI 任务。
