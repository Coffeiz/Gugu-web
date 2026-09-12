# PRD-FS-4：顶层 Workspace 文件库空间

> 状态：Phase 1、Phase 2、Phase 3、Phase 4 已完成，Phase 5 待验收
> 创建：2026-09-07
> 关联：PRD-SHELL-4、PRD-FS-3、PRD-SHELL-1、PRD-LLM-9

## 1. 背景与目标

当前 Shell 未绑定 Workspace 时使用独立的持久目录。该目录不在 Files 页面可见，用户和 Agent 容易误以为 Shell 生成的文件没有进入文件库。

本 PRD 将 Workspace 设计为文件库的顶层空间：用户可以在文件库根页面直接创建和管理 Workspace，Shell 只使用虚拟挂载名 `/workspace`，但所有文件都落到对应的用户目录。

## 2. 目标结构

物理目录与个人文件、项目文件平级：

```text
<用户目录>/
├── workspace/          # 默认 Workspace，系统创建，不可删除
├── F1 数据分析/        # 用户创建，可删除
├── 图片生成/           # 用户创建，可删除
├── 个人文件/
└── 项目文件/
```

`/workspace` 是沙盒内的虚拟挂载别名，不代表物理目录层级。当前 Shell 动态提示和工具回执必须说明 `/workspace` 对应的 Files 逻辑位置。

## 3. 功能需求

### FR-001：根页面管理

- Files 根页面直接显示所有 Workspace；不放在某个 `workspace` 子目录中。
- 支持新建、重命名、打开、删除 Workspace。
- 默认 Workspace 在根页面显示，系统创建且不可删除。
- 用户创建的 Workspace 可删除。

### FR-002：默认 Workspace

- 每个用户至少有一个默认 Workspace。
- 未绑定 Session 或定时任务时，Shell 默认进入默认 Workspace。
- 未绑定 Session 或定时任务时，文件工具省略目标位置也默认读写默认 Workspace。
- 该默认落点不等同于完整用户沙箱授权；`/personal` 和 `/project` 仍按只读策略处理。
- 默认 Workspace 物理目录与其他顶层空间平级。
- Shell 关闭不隐藏该目录；文件库仍可查看其中内容。

### FR-003：绑定 Workspace

- Session/定时任务可绑定任意启用的用户 Workspace。
- 绑定后容器内仍使用 `/workspace`，但挂载源必须是被绑定 Workspace 的实际目录。
- 绑定 personal 文件夹或 project 文件夹的历史兼容逻辑保留，但新建的顶层 Workspace 优先使用独立 Workspace 空间。
- 每轮 Shell system prompt 注入 `/workspace → Files 逻辑路径` 的映射。
- Shell 回执返回 `cwd` 与 `cwd_display`，前者是容器路径，后者是用户可读位置。

### FR-004：删除与自动解绑

- 删除用户创建的 Workspace 必须经过统一确认弹窗。
- 确认内容显示 Workspace 名称、文件数量、绑定 Session 数和绑定定时任务数。
- 确认后递归删除 Workspace 文件及目录。
- 自动解除全部 Session 和定时任务绑定。
- 已运行 PTY 必须终止，避免继续使用已删除挂载。
- 定时任务不自动改绑默认 Workspace；由任务进入无绑定状态或停用，具体由任务状态策略决定。
- 默认 Workspace 永远拒绝删除。

### FR-005：配额与存储

- Workspace 文件计入用户文件库配额或专用 Workspace 配额，不能重复计数。
- 账本、存储对账、孤儿文件检查和回收站都必须识别 Workspace 空间。
- 旧 `<用户>/shell` 目录只做兼容保留和迁移，不直接删除。
- 迁移必须可重试、幂等，迁移失败不得覆盖新 Workspace 数据。

## 4. 权限边界

| 空间 | 默认权限 | 完整用户沙箱授权后 |
|---|---|---|
| 当前绑定 Workspace | 读写 | 读写 |
| 默认 Workspace（未绑定） | 读写 | 读写 |
| personal | 只读 | 读写 |
| project | 只读 | 读写 |

Workspace 删除、批量覆盖和跨空间移动必须经过统一确认与所有权校验。`workspace_id` 不得与 `project_id`、`folder_id` 混用。

## 5. 非目标

- 不把 Workspace 作为 personal 下的普通文件夹。
- 不用隐藏目录解决 UI 可见性问题。
- 不把 `/workspace` 解释为宿主机路径。
- 不因 Workspace 权限自动开放 system Shell、网络或任意代码执行。

### Phase 1 迁移设计

- 迁移只负责补齐数据库元数据，不在 Alembic 事务中直接操作宿主文件系统。
- 每个现有用户补建一条 `directory_name=workspace`、`is_default=true`、`is_system=true` 的默认记录；迁移可重复执行，已有记录不重复插入。
- 旧 `<用户>/shell` 目录保留为兼容数据源，由后续服务任务按用户逐项迁移到默认 Workspace；目标已存在同名文件时不得覆盖，迁移记录必须可重试。
- 任一用户迁移失败时保留旧目录和未迁移文件，写入管理员可查询的失败记录；不得因为单个用户失败回滚其他用户的元数据或删除旧目录。
- 物理目录创建、迁移执行和失败报告属于后续后端能力，不由本次数据库迁移产生副作用。

## 6. 分阶段 TODO

### Phase 1：数据模型与迁移基础

- [x] 增加独立 Workspace 文件空间/目录元数据。
- [x] 增加 `is_default`、`is_system`、`user_id` 等字段并建立归属约束。
- [x] 增加数据库迁移和回滚说明。
- [x] 盘点旧 `<用户>/shell` 目录，设计可重试、幂等的迁移流程。
- [x] 迁移失败时保留旧目录并生成管理员可见的失败报告。

### Phase 2：后端文件库能力

- [x] Workspace CRUD：创建、列表、读取、重命名、删除。
- [x] 文件列表、文件夹、上传、下载、移动、删除支持 `workspace` 空间。
- [x] 删除前返回文件数量、绑定 Session 数和绑定定时任务数。
- [x] 删除时自动解除 Session 和定时任务绑定。
- [x] 已运行 PTY 在 Workspace 删除后安全终止。
- [x] 对账、回收站和配额统计识别 Workspace 空间，避免重复计数。

### Phase 3：Shell 与定时任务

- [x] 未绑定时默认进入用户默认 Workspace。
- [x] 绑定顶层 Workspace 时挂载源必须是对应实际目录。
- [x] 保留 personal/project Workspace 绑定的兼容逻辑。
- [x] 每轮 system prompt 注入 `/workspace → Files 逻辑路径` 映射。
- [x] Shell 回执返回 `cwd` 和 `cwd_display`。
- [x] 定时任务支持绑定顶层 Workspace，并在执行前重新校验归属和启用状态。

### Phase 4：前端文件库

- [x] Files 根页面增加 Workspace 顶层入口。
- [x] 支持在文件库根页面新建 Workspace，不创建 `workspace` 容器目录。
- [x] 默认 Workspace 显示为不可删除状态。
- [x] 用户创建的 Workspace 支持重命名和确认删除。
- [x] 删除确认弹窗显示影响范围并使用公共 Confirm/Action 组件。
- [x] 补齐空态、加载态、错误态和 i18n 文案。

### Phase 5：验收与发布

- [x] 未绑定 Session 默认进入默认 Workspace。
- [x] 绑定顶层 Workspace 后，Shell 文件写入正确目录。
- [x] 绑定 personal/project 目录的历史行为不回归。
- [x] 删除未绑定 Workspace 成功，文件和目录按确认范围清理。
- [x] 删除已绑定 Workspace 自动解绑且运行中的 PTY 被终止。
- [x] Shell 关闭/重新开启后 Workspace 文件仍可在 Files 页面查看。
- [x] 刷新页面、重新登录和定时任务触发后目录映射保持一致。
- [x] 后端测试、前端回归、迁移演练和 devserver 验收全部通过。
