# Node 固定工具入口与按需 Schema 边界

Python基准：`backend/agent/tools/meta.py::_get_tool_schema`以及能力上下文对`tool_schemas`的后处理。`get_tool_schema`只返回名称和拒绝项并不足以完成迁移：下一轮Provider请求必须实际收到对应公开Schema，恢复历史时也须保持授权边界。

## 已实现的选择规则

`@gugu/core/tools::selectToolSchemas(requested, available)`是无IO的选择函数。`available`必须来自可信注册器当前`capabilities(identity)`的有序结果，而非模型参数、Skill正文或未经授权的历史Schema。

- 先取前12个请求，再按Python空白规则strip；空白也占请求槽位，空白项不进入拒绝列表。
- 精确名称或末尾`*`前缀展开，沿可用目录顺序保留至多12个互异名称。
- 本次请求没有新增名称即进入`rejected`，包含重复精确项和完全重复的前缀项。
- 有成功项返回`{tool_schemas,rejected}`；全部拒绝返回`{error,rejected}`；全空白返回两个空数组。
- 不执行业务工具，不加载Skill正文，不改变工具配置或权限，不生成/接纳模型提供的Schema。

## Harness/Host剩余依赖

当前未注册`get_tool_schema`工具，也未把选择函数当作完成标记。由Harness会话协调既有能力投影与Canonical上下文消费：

1. 工具输入按Python公开契约校验：`tools`非空数组、最多12项，元素字符串长度1–80，顶层禁止额外属性。
2. 工具执行取得当前授权目录；平台能力、配置、权限继续由可信Host及注册器负责，动态MCP前缀不能扩大授权。
3. 只从可信目录解析返回名称对应的Schema；将实际声明合入下一轮Provider工具列表与现有上下文历史/恢复链。模型写出的`tool_schemas`文本不能授予发现或执行权限。
4. 加载结果发布前及实际业务调用时重新执行必要的当前权限/启停检查。历史成功声明不能恢复已撤销能力，跨owner历史不能带入其他账号能力。
5. `call_tool`须在权限、确认、事件展示及恢复边界看到最终业务名称；有限自包装最大4层。不能靠把call_tool当普通写工具再次嵌套dispatch绕过Harness的待答/unknown/恢复契约。

验收必须包括真实Harness连续两轮Provider请求、Schema实际出现、历史恢复、撤权、未知名称/前缀、无业务副作用及固定入口调用。纯选择规则测试仅证明第一段边界，未证明上述链路完成。当前迁移总表中两个固定Adapter仍保持依赖阻塞。

Harness会话已确认现实现的Provider可见工具与授权目标只有同一集合，与Python固定Adapter不等价。后续需在既有RunCapabilities内明确Provider可见入口及冻结的授权目标，可信Schema事件随同轮原子提交后供下一次Provider使用，并覆盖use_skill关联工具、Schema恢复、artifact、MCP/IM权限；当前选择函数不试图在工具层替代这些职责。

Harness后续设计还须持久化Provider声明/授权目标及其版本摘要；固定Adapter解包保留外层call_id，对最终目标再次授权与确认。当前优先完成既有跨端业务公共化，这些新增Node消费链先记契约，不继续注册生产入口。

## 本轮证据

真实ToolRegistry→capabilities→选择函数10/10通过，覆盖授权和配置过滤、重新撤权、动态前缀插入序、重复拒绝、请求/声明两个12上限、C0/BOM空白差异及handler零执行。它验证选择规则，不是实际Provider下一轮Schema消费。标准工具/技能与SQLite查询20文件328通过、0失败/跳过；测试类型检查、作用域diff检查通过。Python`test_capability_injection.py -k get_tool_schema`4通过、39未选、0失败/跳过，2条弃用提示；保护IM owner/member/unknown技能管理发现权限与动态MCP前缀展开。未验证真实IM/MCP、外部Provider、PG/Redis或固定Adapter生产调用。本轮仅使用受控授权回调和无执行handler，没有调用外部服务。

edit-check未发现选择函数参数不兼容；quality_delta新选择模块无报告项，但整树并行改动仍有门限，不能宣称全仓质量门通过。
