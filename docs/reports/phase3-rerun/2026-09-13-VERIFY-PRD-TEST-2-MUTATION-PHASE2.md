# PRD-TEST-2 Phase 2 变异测试报告

- 日期：2026-09-13
- 基线提交：`0bdc6f877`（运行时工作树有未提交修改）
- 策略：周期性手动运行；不属于自动 CI，不阻断既有 CI。

## python

- 执行状态：passed；耗时 39829 ms；退出码 0
- 变异：总数 60；杀死 60；存活 0；超时 0；编译错误 0；运行错误 0；无覆盖 0；等价 0；未检查 0；mutation score 100.0%（仅以 killed+survived 为分母）
- 范围：
  - `backend/agent/context/budget.py` → `backend/tests/test_context_budget.py`：工具调用位于消息末尾时不越界、不丢失原子消息组
  - `backend/agent/interactions/confirmations.py` → `backend/tests/test_confirm_gate.py`：确认结果的布尔值和标准化字符串判定
  - `backend/agent/tools/files/documents.py` → `backend/tests/test_agent_file_folder_parity.py`：批量删除参数必须进入软删除流程，文件移入回收站而非漏删
  - `backend/app/core/ownership.py` → `backend/tests/test_ownership.py`：归属 ID 字符串归一后仅允许同一所有者访问
  - `backend/app/core/ownership.py` → `backend/tests/test_ownership.py`：归属拒绝日志对资源标识做指纹化，不泄漏原始 ID
  - `backend/app/services/conversation_pending_queue.py` → `backend/tests/test_chat_pending_queue.py`：消息领取租约在 60 秒边界后可安全接手
  - `backend/app/services/storage/file_service/files.py` → `backend/tests/test_file_service.py`：只有显式 overwrite 模式和目标文件 ID 才执行原位覆盖

- 结果：本次选定变异全部被测试杀死，无等价项。

## typescript

- 执行状态：passed；耗时 43067 ms；退出码 0
- 变异：总数 30；杀死 29；存活 0；超时 0；编译错误 1；运行错误 0；无覆盖 0；等价 0；未检查 0；mutation score 100.0%（仅以 killed+survived 为分母）
- 范围：
  - `frontend/src/utils/optimisticMutation.ts` → `frontend/test/optimisticMutation.test.ts`：乐观更新提交、回滚及更新意图结算时序

- 编译错误变异（TypeScript 检查器拦截，未进入测试判定）：
  - `10`：src/utils/optimisticMutation.ts(56,17): error TS1313: The body of an 'if' statement cannot be the empty statement.
