# Node Agent 输入契约兼容与回归

日期：2026-11-14。从初始只读盘点继续记录实际实施和回归。范围为 Core 九个已有工具：`get_current_time`、`use_skill`、`list_clients`、`create_client`、`update_client`、`list_projects`、`get_project`、`create_project`、`read_file`。这里的“已有实现”不升级为生产 Host 完整迁移；特别是 read_file 仍是 file_id 文本切片。

当前已补统一安全issues/业务错误增强、已列出的有限输入兼容、Python16数字边界及成功对象的input_adaptations；具体边界和证据见后续实施节。未知字段名/任意wrapper键的安全回显、未迁移规则及生产Host装配仍未完成。下方逐工具表保留初始差异，不能当作最新未完成清单。

## 真实调用边界

Python `backend/agent/tools/base.py::SkillRegistry.dispatch` 在 handler、进度声明和确认前调用 `tool_contract.normalize_and_validate_tool_input`：限定顶层 object → 解匹配工具 envelope/arguments 包装 → 已知旧输入适配 → 按 schema 归一 → 缓存 Draft 2020-12 validator 校验。另有 `resolve_tool_call` 处理最多四层 `call_tool` Adapter。归一成功仍须校验，不能用兼容层补业务信息或授权。

Node `packages/core/src/agent/tools/registry.ts` 先保存调用与可信身份快照，按名称/配置/最新权限过滤，再经统一有限归一及每工具实际validator。失败返回安全tool_input_invalid/issues；成功执行后按结果类型补错误增强或修复回执。各工具多数为Zod safeParse，时间工具手工验证object；Provider仅解析JSON不能替代这些边界。Node尚无完整call_tool递归Adapter，危险工具仍不开放。

## 初始九工具逐项差异

初始盘点时所有工具均缺统一安全issues/恢复提示和业务错误增强。下表保留当时差异，已落地部分以本文实施节为准，不要求把未迁移工具的特殊修复一次搬入。

| 工具 | Python 输入基准 | Node 初始行为与当时下一步 |
| --- | --- | --- |
| get_current_time | 无声明字段，顶层 object，额外属性默认允许；handler 不使用参数 | 手工验证后输出空参数，满足无参主路径；无业务字段可命中时 Python 不解 arguments wrapper，不应泛化解包所有无参对象。无需“兼容”模型 timezone/owner，时区始终可信注入 |
| use_skill | id 必填，S/U 正整数 ID；允许额外字段；有声明字段时支持单层 arguments wrapper | Zod passthrough，直接 wrapper 无 id 被拒绝。数字 id 经 Python string-only 转换后仍不匹配 S/U 格式；不应借兼容把数字猜成 S 编号。缺 id 应给 required 路径；未知技能业务错误缺 tool/usage_hint/next_action |
| list_clients | 无声明字段，额外属性允许，返回列表 | Zod passthrough主路径一致；Python 仅对成功 dict 回执加 ignored_fields，不给列表附带元数据。不要为了全局增强把列表改成对象 |
| create_client | 旧 name→client_name；string-only 名称/联系方式接受 JSON number 转字符串（不转换 boolean）；可解 arguments wrapper | Zod直接拒绝旧 name 或数字文本字段；缺名称与空名称须区分：缺失是 schema required，空串进入 handler 返回“联系人名称必填”。passthrough额外字段在成功 dict应提示ignored_fields，目前无提示 |
| update_client | 同旧name别名；client_id整数字符串与#前缀归一；client_ids数组/元素递归归一；额外字段允许；存在字段即可清空空字符串 | Node仅原生类型；现有uniqueItems运行时及公开schema均已保留，须在归一后检查（如字符串与整数最终可能变同一ID）。不可把未传字段补成空值，否则会误清空；不得把client_ids被接受解释为批量更新已实现（Python handler也未用它） |
| list_projects | archived原生boolean或大小写true/false文本归一；status enum；额外字段允许 | Node只接受boolean；应支持已知标量转换而非JS真值：字符串false不能变true。缺archived由handler默认false，空字符串不会被Python猜成false/省略，仍应报错 |
| get_project | project_id数字字符串/#前缀；project名称number→string；允许额外属性和arguments wrapper | Node只接受原生整数/字符串。ID未提供时名称解析、歧义候选与owner隔离仍由真实领域服务处理，归一不能猜目标或改变ID优先级 |
| create_project | strict顶层；旧name别名；日期灵活写法归一；已知旧CSS渐变→语义色；字符串字段number→string；stages容器JSON字符串/item或block包装、嵌套todos与label按schema归一；匹配工具envelope可解 | Node strict schema只接受当前原生形状；合法当前参数已验证，不代表上述旧调用兼容。日期转换复用Python规则的有限格式及可信当前年份；不可放宽为任意Date.parse。颜色仅允许已知存储渐变映射，不接受任意CSS。阶段业务规范化/default由Host共享创建服务处理，Core不能另造领域默认 |
| read_file | Python完整工具支持多种来源，schema归一包含数值ID、target_lines string-only数字转字符串及包装等 | Node仅strict file_id正安全整数+target_lines（默认all）；即使补数字ID与行号兼容，也不能宣称URL、逻辑路径、批量/媒体读取已迁移。严格拒绝授权root/path/owner模型字段，真实根与可读记录仍由Host解析 |

## 归一化范围和默认语义

1. Python `normalize_name_aliases` 只在专属字段不存在时搬旧name；同时存在时不覆盖新字段。Core不能简单合并或把协议name当业务name。
2. Python只解 `{arguments:{...}}` 单键包装且内层至少命中schema属性；strict工具的完整 `{tool_name,arguments}` 还须名称匹配。`call_tool`的四层协议适配与普通业务对象是两层职责，不能把所有对象递归解包。
3. `normalize_input_by_schema`只做明确允许的标量/容器转换。整数可带符号、字段名以_id结尾时可去#；空白数字仍非法；boolean与number必须区分；非有限数拒绝。Node安全整数限制是明确平台边界，不能靠转换接受超安全范围ID。
4. 数组item/block解除最多四层，真实合法业务同名属性不拆；容器JSON字符串必须解析后类型匹配；`strict_array_fields`不做结构猜测。create_project还涉及数组item字段拍平、单项未知wrapper解除，需逐条移植既有适用条件，不能写通用“任意对象转数组”。
5. JSON Schema default本身不会插值：Pythonvalidator只校验；read_file的all、list_projects的false、create_project默认阶段/颜色/状态等仍来自相应handler/领域服务。Node read_file用Zod.default('all')，语义上与领域默认相符但不能推导所有schema default都应注入。
6. 额外字段默认允许不同于“实现支持该字段”。Python成功dict才加ignored_fields/hint；错误、确认载荷和列表不加。Node passthrough保留但实现通常忽略，缺少成功反馈；strict工具仍须拒绝额外字段。

## 安全错误、字段路径与恢复提示

Python `validate_input`按路径/规则稳定排序、去重，最多5项。每项仅 `path/rule/message`，根路径为 `$`，数组路径例如 `stages.0.todos.1`；required点名缺字段，additionalProperties仅指父路径，不回显未知键值。message由固定规则与可信schema约束生成，不能直接返回jsonschema/Zod原始message或input。

非法输入完整载荷为 `error:'tool_input_invalid'`、`tool`、`issues`、`_schema_recovery:{needed:true,reason:'validation_error'}`、`usage_hint`、`next_action`，必要时 `schema_hints`。缺必填时指示询问缺失信息，避免空参数重试；create_project数组错误有扁平阶段示例。调用协议错误另为 `tool_call_invalid`，不能和未知工具/业务不存在混为一谈。当前Node固定安全错误虽不泄露值，但丢失这些模型纠错契约。

Python `enrich_tool_error`保持原字典或JSON字符串类型，保留原业务字段，用setdefault补tool/usage_hint/next_action；未知工具有专用提示。Core联系人JSON字符串错误、项目错误对象、技能错误对象和文件错误对象目前没有统一增强。`unknown`必须继续保持未知提交，绝不能增强成可重试普通失败。

安全路径应只来自可信schema属性和数组索引；不要把任意动态键、模型输入、文件路径、凭据或原始异常混入issues、日志或hint。Python成功回执的ignored_fields会回显未知键名，Node新增时必须结合既有脱敏边界审查，不能直接把整个Zod错误对象暴露。归一日志只记录固定适配名和安全字段路径，不记录前后值；Python成功dict可带input_adaptations，Node目前缺此反馈。

## 注册期与公开schema

Python add检查名称唯一、顶层input_schema必须object、handler可调用，Draft202012Validator.check_schema在注册时失败，并缓存validator；Provider声明和dispatch共用同一schema，冻结Provider变体时同步重新建validator。

Node checked检查名称、重复、validate/execute函数并克隆公开definition，但不检查公开function.name等于registry name、parameters是否object/合法Draft schema，也不验证公开schema与手写Zod同一契约。部分工具从Zod生成schema，部分手写，两者仍可能漂移。不能把注册成功或safeParse存在视为fail-fast已等价。新gate等端口schema不是工具input schema校验替代品。

## 下一批可实施清单

按顺序小切片推进，每批完成后跑真实registry调用回归；不扩大到未迁移笔记/邮件/知识工具。

1. **安全issues与增强**：给validate结果保留受限规则/路径；新增统一payload投影与业务错误增强，保留JSON字符串/对象/列表形状、5项限制和unknown。用缺必填、stages深层非法、额外字段含合成秘密值、多个同时错误、业务候选错误验证安全输出与纠错动作。
2. **九工具已知标量/别名兼容**：先name别名、client/project/file ID文本、archived布尔文本、number→string；校验必须发生在转换之后，拒绝boolean误转、空数字和超安全整数；证明非法输入不调用领域服务、归一后重复ID仍拒绝、空字符串更新不会被吞。
3. **create_project有限旧输入**：共享日期/颜色映射与stages包装修复；以Python合成fixtures对照输入→规范化→结果/副作用，而非只比较schema。Host真实阶段创建与幂等测试单独验收。
4. **协议包装及注册fail-fast**：在既有Provider/Harness解析边界协调call_tool，保持权限/确认看到最终业务工具名；解包受限深度、名称不匹配拒绝。验证公开schema合法和名称一致、分组注册失败原子性；采用项目现有依赖与schema来源，避免为每工具引入第二套框架。

最相关Python基准为 `backend/tests/agent/test_tool_schema_validation.py` 中 normalize、schema shape hint、empty value、name alias/date/color/stages、unknown field、business enrich、invalid schema/cached validator/provider schema测试；另有 `test_tool_schema_security_contract.py`。Node新增回归应经过 `ToolPort.dispatch`，能观测handler调用次数、真实临时数据副作用及秘密不回显；确认、owner与路径安全覆盖不能因兼容层被绕开。

本次未执行这些基准，不沿用先前通过总数作为本审查的新增验收。文档仅定位差异和下一批范围，不将待实现的normalize/enrich/fail-fast标为完成。


## 首批输入契约实现（2026-11-14）

已落地 `normalize-input.ts` 与 `input-errors.ts` 并接入真实registry：name专属别名、已提供字段的schema驱动整数/布尔/数字文本转换、递归数组元素；随后仍调用每工具validator。数字ID使用安全整数边界，保留Python空白规则，不猜日期、数组结构、envelope或缺省业务值。Unicode十进制ID目前仍拒绝，作为明确未迁差异保留。

validator拒绝后返回tool_input_invalid、安全issues（稳定排序去重最多5项）、schema恢复标记和纠错提示；深层路径只来自公开属性/数组索引，未知键及原始值不进入错误。此投影只描述已失败的输入，不承担调用放行或替代Zod校验。业务错误增强保留JSON字符串/对象及已有字段，列表/成功值和unknown不变。未迁移工具专属提示、旧日期/颜色/容器适配、ignored_fields/adaptations回执、envelope与注册schema完整fail-fast仍待逐项完成。

原Node测试中把数值名称、数字字符串ID和文本false视为非法的预期已按Python明确契约纠正：新增真实临时SQLite回归证明合法旧输入持久生效，原非法类型/无权限/无副作用断言保留，非法输入改用boolean名称、非数字ID和非法布尔文本；业务错误的严格相等断言增加Python统一提示字段，没有改成宽松匹配来获得通过。

Python参数与安全契约串行115通过、0失败/跳过；Node归一23项（含真实registry/SQLite），错误投影13项，注册器完整纠错载荷新增1项。实际生产Host与全部旧兼容路径仍未因此验收完成。


## 日期与受限包装兼容（2026-11-14）

已接入 `normalizeDateInput`：中文年月日、有限分隔符格式、Unicode十进制数字、两位年份与真实日历校验按Python规则处理，不使用Date.parse推断。缺年份时仅使用可信Host的 `ToolRegistryOptions.normalizationYear(identity)`；未注入保持原值交validator拒绝，不能用模型字段提供年份。此处与旧Python使用本机LOCAL_TZ年份存在明确默认行为差异，须在Host接线时提供可信年份。

固定旧色板渐变通过现有Core projectColorKey映射，未知CSS继续拒绝。仅解除单键arguments包装且内层命中声明字段，或strict工具精确匹配当前工具名的完整tool_name/arguments envelope；不重写授权工具名，不执行call_tool递归适配。日期/名称/标量兼容后仍走原validator和权限边界。阶段JSON容器与item/block结构修复仍未迁移。

Python既有MDY优先规则导致低年份歧义（例如0001-01-01会归为2001-01-01），本次保持参考行为并有专门回归，不宣称所有日期归一都幂等。节点39项日期规则回归；registry组合证明旧包装、日期和色值正确到达领域端口，错名envelope不调用，缺可信年份不猜。

最终工具/技能14文件203通过、0失败/跳过，测试源码类型检查通过；Python schema_validation/project_tools串行111通过、0失败/跳过。未验收Host默认年份装配、全部复杂历史输入或真实PG执行。

## 注册期校验首批（2026-11-14）

已落实公开function名一致、parameters/input_schema根object、读写属性/处理器检查；definition-schema.ts对当前常用关键字做形状验证，包含Python既有required误传字符串的回归。无效组合分组原子拒绝，循环声明在递归校验前安全拒绝，声明快照不被外部修改。不是完整Draft meta验证或公开Schema/validator等价证明，未实现部分继续保留。

Python注册/cached validator/Provider Schema最近邻4通过、86未选，0失败/跳过。标准Node入口当时被其他会话未登记的新测试阻断；使用临时独立配置实际运行本任务所有工具/技能15文件235项全部通过，配置运行后已删除。注册期32项含新增5项均在该集合内；不能把这次定向运行记成默认全仓发现检查通过。

名称lookup的Python strip与JS trim差异已由共享strip修复（C0去除、BOM保留），创建原始名称不变。年份服务延迟到缺年格式才读取，完整年月日不依赖该服务。标准测试发现入口恢复后的本任务最新结果为239通过；类型检查通过。

## 当前容器兼容切片（2026-11-14）

已支持仅在声明array/object且不接受string时解析同类型JSON容器，以及array-only的item/block最多四层包装，合法业务同名字段不拆；按实际类型唯一匹配anyOf分支后递归处理stages label/todos。类型不匹配JSON、五层包装、缺label/授权字段等仍由validator拒绝；client_ids归一后重复ID不写入。未补业务默认，未做顶层hoisted或同型分支猜测，strict_array_fields元数据仍待接。

## 严格数组与顶层拍平输入（2026-11-14）

补齐ToolDefinition.strictArrayFields，由可信装配指定叶字段名；注册时验证并保存冻结副本，模型输入不能更改策略。严格字段禁止item/block包装修复和顶层拍平修复，但合法JSON数组文本、已有数组及其中标量仍按原规则归一。递归数组沿用叶字段名，覆盖对象嵌套及数组元素内同名字段。

顶层拍平行为沿用Python判据：数组容器缺失/null/空白时，至少一个额外键属于该数组items.properties，且所有顶层额外键均可安放，才移动为单元素数组；已有数组、未知额外键或严格字段不修复。修复后的参数仍经过原validator，不补业务必填值，也不改变授权和owner。Python当前实现并未额外要求顶层additionalProperties=false，此处保持其运行行为，不以注释中的closed-schema示例收窄兼容范围。

标准工具/技能与SQLite名称查询18文件297通过、0失败/跳过，normalize-input文件51项包含本轮新增22项；注册器参数测试使用受控内存handler记录实际输入与副作用次数，另有既存真实SQLite联系人隔离用例。本轮未增加PG/Redis/平台执行验收。Python参数schema基准90通过、0失败/跳过，2条弃用提示；源码/测试类型检查及作用域diff检查通过。edit-check未发现新增调用参数不兼容；quality_delta仍报告整树并行改动及本模块的复杂度提示（含新增hoistArrayItems），不宣称质量门全绿。

## Unicode 十进制整数兼容（2026-11-14）

关闭此前明确保留的ASCII-only差异：integer字段采用Unicode Nd十进制字符，支持ASCII正负号、混合数字字符及仅`*_id`允许的`#`前缀；先确认整段整数格式，再转ASCII并检查Number.safeInteger。上标/罗马数/伪减号、`#`后空白、BOM和超安全整数仍保留给validator拒绝，不发生精度截断。数字字符转换复用既有日期Nd算法到内部unicode-decimal helper；日期格式和年份语义不变。

旧测试中“１２保留原值”原本记录的是Node未迁移限制，现依据Python `normalize_input_by_schema`的`\d`与`int`行为改为12；不是为通过失败测试放宽安全断言。Node与Python的Unicode字符数据库版本可能不同，本轮以两端均支持的既有Nd字符集验证，不宣称未来新增码点跨版本自动完全等价。

标准工具/技能与SQLite查询20文件329通过、0失败/跳过，包含日期原有39项规则和新增真实registry→临时SQLite联系人更新：工具创建的多位ID转换成7种Nd/符号组合后确实写入备注并重读；非法/超safe输入及跨owner访问不能修改记录。normalize-input整文件52项，唯一旧预期调整如上所述。源码/测试类型检查及作用域diff检查通过。Python schema_validation/project_tools串行111通过、0失败/跳过、4条弃用提示；另直接调用纯Python归一函数8组断言通过，不将其冒充新增pytest。未新增PG/Redis/平台执行或真实外部服务验收。edit-check未发现调用不兼容；quality_delta新helper/日期模块无报告项，整树并行改动仍有门限，不宣称全仓质量门通过。

## read_file物理行选择兼容（2026-11-14）

`files.ts::selectLines`改用共享Python strip和Nd数字转换，支持Unicode十进制单行/范围及C0包装all；BOM仍作为非法字符，不再被JS trim误当空白。负数、伪数字、重复分隔符和倒序/越界保持原错误语义。splitlines(keepends=True)和numbered_content只剥CR/LF的既有行为不变，Unicode换行仍是原始物理行边界，编号不能重新从1开始。

新增26项真实ToolRegistry→packages/fs→临时文件回归，包含6合法行选择、12非法输入和8种Unicode/控制换行；均验证原文件未改变。files文件47/47，标准工具/技能与SQLite查询20文件355通过、0失败/跳过，源码/测试类型检查及diff检查通过。Python `tests/storage/files/test_file_operations.py -k read_file`2通过、20未选、0失败/跳过，2条弃用提示；另直接加载参考text_edit模块核对6组Unicode行选择，不冒充pytest。原有路径/符号链接、owner、大小、取消清理回归保留；未增加新的文件来源或真实Host授权后端。edit-check未发现调用不兼容；quality_delta仍有读取器复杂度、嵌套工厂/execute计数与整树并行门限，不宣称全仓质量门通过。

## 固定Python数字版本与项目编号（2026-11-14）

关闭此前保留的Unicode数据库版本差异：生产Python3.14为Unicode16，当前Node所带Unicode18把U+11DE0–U+11DE9额外识别为Nd。旧归一化会把这些Python拒绝的字符串转换成真实ID，不能依赖Node的`\p{Decimal_Number}`决定可写参数。共享实现位于`shared/unicode-decimal.ts`；整数、日期、文件行号及项目阶段/待办编号均直接复用固定规则。

`generate-tool-unicode.py`用Python16生成760个Nd/76组，校验连续0–9及完整覆盖；`--check`只读比较，版本不符拒绝写。未知字符原样保留给validator拒绝，不做NFKC；ASCII符号、仅ID字段允许的#、safe integer、授权与owner边界不变。日期模式使用同一固定字符类，不因Node新增数字触发可信年份查询。

Python项目编号先isdigit再int；固定888个isdigit字符与760个Nd分别判断。²/①等非十进制Digit沿用Python转换失败语义，Node报固定安全invalid_request，不再静默忽略它们后生成新编号。此处经工作台会话交接修改项目规则，现位于共享`projects/domain.ts`；未知新字符则不推动编号计数，旧阶段/待办数据不改写。

全1,112,064个Unicode标量的转换、Nd/isdigit分类与独立Python摘要一致；公开字符类逐项对照也一致。真实registry创建联系人后，以实际多位ID构造未知数字、#前缀及混合形式，均拒绝且重读备注不变；实际packages/fs读取的非法新数字行号失败且源文件不变。项目编号覆盖合法Nd、忽略新数字、非十进制Digit失败及原输入不变。临时SQLite/文件为真实实现，授权/resolver为替身；不证明生产Host授权或运行链已接通。

最终标准工具/技能与domain20文件377/377、定向5文件151/151、Python schema/project4文件150/150通过，0失败/跳过；Python有4条既有弃用提示，确认测试Redis为替身。生成物check、Core build、测试类型检查与diff通过。类型检查曾因与build并行导致dist被重建而找不到模块，构建完成后顺序复验通过，没有改断言或隐藏错误。新测试元数据已登记；未新增真实PG/Redis/平台执行或生产Host验收。

edit-check没有签名不兼容；新数字helper有两个分类器的44 token相似提示，分别表达Nd与isdigit契约，不为消除静态提示合并语义。整树quality_delta仍有19项门禁及读取器/归一化既有复杂度提示，不宣称全仓质量通过。没有新增工具、修改Harness/main/schema/package、接入配置或更改生产工具计数。

## 成功回执中的输入修复事实（2026-11-14）

既有normalizer增加每调用可选collector，返回参数形状不变；registry在授权与实际validator通过后执行工具，仅向successful completed的普通对象补`input_adaptations`。标签只由固定规则和可信Schema属性/数组索引构造，顺序为legacy→顶层hoist→Schema深度优先→项目阶段业务事实；不记录原值、未知字段名、临时strip、未成功的转换或validator默认值。普通arguments解包与Python一样不生成标签。update_client声明字段顺序对齐Python，以保持ID、名称及联系方式转换标签同序。

覆盖别名、严格同名envelope、旧颜色/日期、数字文本、布尔、JSON容器、item/block及拍平结构的已迁移规则。数组路径形如`entries[0].file_id`。项目创建含名称数组时按Python补`stages:stage_names_to_objects`；这只是已有项目领域处理的回执，不注册新工具或替代业务执行。

错误、failed状态、待确认、waiting/unknown、列表、字符串（即使内容是JSON成功对象）及无修复的结果不加入字段。输入校验失败不发布已收集事实；read取消继续抛原reason，write已提交后取消仍保留真实结果，异常写入仍unknown不可重放。返回对象与标签数组分别复制，handler原对象及并发调用不被污染；已有反馈在本次实际修复发生时由可信新事实覆盖，不合并模型伪造标签。

未知字段`ignored_fields/hint`仍未完成安全回显策略：任意键名本身可能包含凭据或正文，不能直接照搬Python原键名回显；Python任意未知wrapper键的修复标签同样尚未迁移。此处不输出假字段名或假装已完整等价。通用number/empty-string策略及尚未迁移工具的专用兼容也不由本次collector补齐。

新16项注册器行为回归覆盖有序标签、原始值/未知键/伪造标签不泄漏、返回结构、冻结对象、并发、取消和未知写入；既有真实SQLite联系人测试新增回执和重读数据断言，证明反馈与实际归一化/持久化一致。项目port、授权和Provider/RunStore仍有明确替身，不冒充生产Host。Python新增1项成功顺序与4项非成功对象形状回归经过原注册器。最终标准Node工具/技能与domain21文件393/393、Python schema/isolation/project158/158通过，均0失败/跳过，Python7条既有弃用提示；测试类型及diff通过。源码在三方协调窗口保持冻结，随后Core构建通过；其他会话暂停后留下的Mind/共享事务桥原型只保留工作区，不因编译通过当作已接线或功能验收。
