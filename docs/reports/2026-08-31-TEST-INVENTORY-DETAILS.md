# 测试清单详细测试项

> 由 `scripts/tests/generate-test-details.mjs` 根据测试源码生成。用于 Phase 0 人工复核职责、内容和潜在重复，不替代运行器实际收集结果。

- 清单来源：`docs/reports/2026-08-31-TEST-INVENTORY.json`
- 条目数：3

### backend/tests/test_shell_sandbox.py

- 类型/层级：pytest / L1
- 自动领域/owner：terminal-runtime / backend/terminal-runtime
- 源码声明数：16；无外部依赖；含 skip，需人工确认触发条件
- 测试项：
- test_local_sandbox_rejects_shell_operators
- test_local_sandbox_rejects_workspace_files_as_interpreter_input
- test_local_sandbox_rejects_interpreter_eval_mode
- test_local_sandbox_still_allows_reading_workspace_files_without_interpreter
- test_system_executor_can_run_workspace_script_inputs_without_sandbox_restriction
- test_local_sandbox_runs_inside_workspace
- test_local_sandbox_returns_shell_error_for_missing_command
- test_local_sandbox_cleans_up_timeout
- test_local_sandbox_truncates_output_and_rejects_escape
- test_local_sandbox_rejects_symlink_argument_escape
- test_local_sandbox_rejects_windows_style_traversal
- test_local_sandbox_rechecks_authorization_during_execution
- test_local_sandbox_rejects_symlink_escape
- test_local_sandbox_rejects_hardlink_to_outside_file
- test_local_sandbox_rejects_direct_file_symlink_to_outside
- test_local_sandbox_allows_proc_word_but_not_proc_absolute_path

### frontend/e2e/file-drag-runtime.spec.ts

- 类型/层级：playwright / L3
- 自动领域/owner：storage / frontend/e2e
- 源码声明数：13；有外部依赖；含 skip，需人工确认触发条件
- 测试项：
- 单文件拖入文件夹
- 单文件拖到面包屑返回上一层
- 底部拖拽单卡不改变文件区滚动位置
- 多选两个文件拖入文件夹，落地后能正常进入目标文件夹
- 文件和文件夹混合多选后拖入文件夹
- 单文件移动遇到 409 时回滚缓存和页面
- 单文件移动被权限拒绝时回滚缓存和页面
- 多文件移动部分失败时整体回滚

### frontend/e2e/filesystem-phases.spec.ts

- 类型/层级：playwright / L3
- 自动领域/owner：storage / frontend/e2e
- 源码声明数：10；有外部依赖；含 skip，需人工确认触发条件
- 测试项：
- 阶段 1：共享展示层挂载文件库浏览壳
- 阶段 2：目录进入后可以开启统一选择模式并退出
- 阶段 2：连续 Shift 选择保持第一次点击的范围锚点
- 阶段 2：批量选择工具栏统一暴露下载、剪切、复制和删除
- 阶段 3：文件操作边界通过右键复制入口可达
- 阶段 4：上传入口与空白区域右键菜单使用共享组件
- 文件库回收站保留场景扩展且仍由通用面板承载工具栏
- 项目文件区使用通用面板并保留项目工具栏适配层
- 窄窗口下文件浏览面板不产生横向溢出

