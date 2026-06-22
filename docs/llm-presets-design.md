# 设计方案 · 多套 LLM 预设 + 激活选择器

> 状态：设计稿（交接给负责 Admin/后端配置的 agent 实现）
> 作者视角：Agent Phase 1 重构方 —— 本方案保证**对 `backend/agent/` 包零改动**

## 目标

把当前「单套 LLM 配置」升级为「**同时保存多套命名 provider 配置 + 一键切换当前生效**」：
- 后台可把 MiniMax / OpenAI / DeepSeek / 通义 等各配一套（各自 key + base_url + model），全部留存。
- 每套配置一张卡，各有「设为当前」按钮；当前生效的高亮标记。
- 切换即时热更新生效，无需重启。

## 现状（重构前）

`config.override.json` 仅一个 `ai` 段：
```json
{ "ai": { "provider": "minimax", "api_key": "...", "base_url": "...", "model": "MiniMax-M3" } }
```
前端「provider 预设下拉」只是选 provider 时自动填 base_url 的便捷 UI，**最终只存一套、只有一套生效**，无多套持久化。Agent 运行时读 `get_settings().ai.*`。

## 核心设计原则

**`ai` 段语义不变** —— 始终是「当前激活预设的解析快照」。多套预设单独存在 `ai_presets`，切换激活 = 把选中预设字段复制进 `ai` + 更新 `active_id`。

→ 这样 `backend/agent/`（`adapters/web.py`、`core.py` 读 `settings.ai.*`）**完全不用改**，改动全部收敛在 admin 配置层。

## 数据模型（config.override.json）

```json
{
  "ai": {                          // 不变：当前激活预设的快照，agent 读这里
    "provider": "minimax", "api_key": "...", "base_url": "...", "model": "MiniMax-M3"
  },
  "ai_presets": {
    "active_id": "p_minimax",
    "items": [
      { "id": "p_minimax", "name": "MiniMax 主力", "provider": "minimax",
        "api_key": "...", "base_url": "https://api.minimaxi.com/anthropic", "model": "MiniMax-M3" },
      { "id": "p_openai",  "name": "GPT 备用",    "provider": "openai",
        "api_key": "...", "base_url": "https://api.openai.com/v1", "model": "gpt-4o" }
    ]
  }
}
```

**向后兼容迁移**：加载时若只有 `ai` 没有 `ai_presets`，自动生成单预设（`id="default"`, `name` 取 provider），`active_id` 指向它。

## 后端 API（admin token，建议挂在 `agent_admin.py` 或 `config.py`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`    | `/admin/agent/llm-presets` | 返回 `{active_id, items}`，**api_key 脱敏**（如 `sk-cp-…1234`） |
| `POST`   | `/admin/agent/llm-presets` | 新建预设，返回带 id |
| `PUT`    | `/admin/agent/llm-presets/{id}` | 编辑；**api_key 留空 = 保持原值**（沿用现有 admin 密码处理模式） |
| `DELETE` | `/admin/agent/llm-presets/{id}` | 删除；禁止删 active（或删后自动切到 items[0]） |
| `POST`   | `/admin/agent/llm-presets/{id}/activate` | 设为当前：字段写进 `ai` + 更新 `active_id`，触发现有热更新 |
| `POST`   | `/admin/agent/llm-presets/{id}/test` | 连通性测试（复用现有 `test-connection` 思路，发一条最小 ping） |

## 配置层改动（core/config.py）

- 新增 `AIPresetItem` / `AIPresets` 模型，`AppSettings` 增 `ai_presets` 字段，纳入 override merge 逻辑（与 `ai`/`db`/`storage` 同样的 `model_construct` 合并路径）。
- `apply_overrides` 时：若 `ai_presets.active_id` 存在 → 用激活预设解析出 `ai`，保证 `settings.ai` 恒等于当前生效预设。
- 加载入口做一次性向后兼容迁移（见上）。

## 前端（Admin LLM 配置页）

- 改为**预设卡片列表**：每卡显示 名称 / provider 徽标 / model / 脱敏 key；当前激活卡高亮 + 「当前」角标。
- 卡片操作：编辑、测试连通、**设为当前**（按钮）、删除。
- 顶部「+ 新建预设」；新建/编辑表单里选 provider 自动填 base_url（复用现有下拉填充逻辑）。
- 切换激活后给即时反馈（toast），并刷新「当前」标记。

## 安全 / 边界

- api_key 一律脱敏返回；编辑留空保持原值。
- 这是**系统级全局配置**（非按 user_id），与现状一致。
- 切换走现有 config 热更新通道，无需重启。

## 与未来 router/profile 的衔接（不在本期）

本期只做「全局激活一套」。未来若要 agent.md 的 per-profile 绑定（不同 Profile 用不同预设），只需在 Profile 上加 `llm_preset_id` 引用这里的预设 id —— 本数据模型天然兼容，不返工。届时 `core.LLMRunner` 接收的 `settings` 可由 router 按 profile 解析后传入，仍不破坏现有读取方式。

## 实现顺序建议

1. core/config.py 数据模型 + 向后兼容迁移（先让 `settings.ai` 仍正确）。
2. 后端 6 个 API（先 GET/activate 打通切换闭环，再补 CRUD/test）。
3. 前端卡片列表 + 设为当前按钮。
4. 联调：配两套，切换后用咕咕聊天窗发一句验证生效 provider 确实变了。
