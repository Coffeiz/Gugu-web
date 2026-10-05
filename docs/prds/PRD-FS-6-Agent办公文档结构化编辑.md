# PRD-FS-6：Agent 办公文档结构化编辑

> 状态：Office 文档文本提取已支持；结构化检查、编辑和创建待实施
> 创建：2026-10-03
> 最近更新：2026-10-04
> 关联模块：`backend/agent/tools/files/`、`backend/app/core/doctext.py`、`backend/app/services/storage/file_service/`、`backend/app/services/files/`
> 背景参考：`docs/prds/【已完成】PRD-FS-3-文件事实源与双向同步.md`、`docs/prds/【已完成】PRD-FS-4-顶层Workspace文件库空间.md`、`docs/prds/PRD-LLM-16-工具Schema语义显式化与注入优化.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| Office 文本读取 | PDF、DOCX、XLSX、PPTX、ODT、ODS、RTF、XLS、ODP 可提取文本 | ✅ 已完成 | 通过 `read_file` 调用 `doctext`；旧式 `.doc`、`.ppt` 当前明确不支持提取。 |
| Office 结构化读取 | 返回可用于定点修改的段落、表格单元格、工作表、幻灯片及稳定定位信息 | 🔲 待实施 | 现有读取结果以提取文本为主，缺少通用结构定位契约。 |
| Office 内容编辑 | Agent 通过结构化操作增改删 DOCX/XLSX/PPTX 内容并保存 | 🔲 待实施 | `edit_file` 仅支持 UTF-8 文本；Office 二进制文件不会由它直接修改。 |
| Office 文档创建 | Agent 根据结构化内容创建真实 DOCX/XLSX/PPTX 文件 | 🔲 待实施 | `create_file` 只写 UTF-8 文本，并拒绝直接生成这些二进制格式。 |
| Office 文件级 CRUD | 浏览、读取、重命名、移动、删除整个文件 | 🟡 部分完成 | 复用现有文件工具；不等同于增删改文档内部的结构和内容。 |

## 1. 背景与目标

### 1.1 背景

咕咕当前已经能提取常见 Office 文档文本，但 Agent 的 `create_file` / `edit_file` 都是 UTF-8 文本工具，无法把读取到的内容安全地改回 DOCX、XLSX 或 PPTX。文件级重命名、移动和删除也只改变文件记录，不会编辑 Office 文档内部内容。

仓库已安装 `python-docx`、`openpyxl`、`python-pptx`，并有文件归属、空间解析、存储和文件版本基础能力。应在现有文件库权限与存储链路上增加 Office 结构化读取、定点编辑及创建能力，不另建一套文件系统。Office 库并不完整实现所有 Office 特性；保存前的重新解析只能验证文件结构可读，不能证明所有未支持的图表、宏、嵌入对象或排版都无损。

### 1.2 目标

1. Agent 能检查 DOCX、XLSX、PPTX 的结构，并获得可复用、无歧义的内容定位信息。
2. Agent 能对用户授权可访问的 Office 文件执行有边界的结构化增删改，并以原格式保存。
3. Agent 能根据结构化内容创建 DOCX、XLSX、PPTX；现有文本 `create_file` / `edit_file` 契约保持不变。
4. Office 写入复用当前文件归属校验、Workspace/project/personal 落点、配额、存储和文件版本/同步语义。
5. 编辑失败或校验失败时不改变原文件；超出首期支持范围时明确报错，不静默丢弃内容或改存为错误格式。
6. 对工具调用和文件操作提供可验证的成功回执，不在可见日志记录文档正文或用户文件名。

### 1.3 非目标

- 不实现浏览器内完整 Word、Excel、PowerPoint 编辑器或实时协同编辑。
- 不承诺完全兼容 Microsoft Office 全部格式、宏、插件、复杂图表、SmartArt、动画、OLE 对象或版式。
- 不将 PDF、旧式 `.doc` / `.ppt`、ODT / ODS / ODP 纳入首期可编辑范围；它们可继续按现有能力读取或作为不支持格式明确拒绝。
- 不通过 LibreOffice/UNO 新增常驻服务或增加大型办公套件运行依赖。
- 不把 Office 二进制文件交给文本 `edit_file`，也不让模型直接输出/覆盖完整二进制编码。
- 不执行文档宏、嵌入代码、外部链接或文档内脚本。
- 不原样安装或运行外部 Office Skill，不依赖 MiniMax 模型或 API；首期不强制增加 .NET、LibreOffice 或独立 Office 服务。

## 2. 功能需求

### FR-FS6-01：Office 类型与可编辑范围明确

首期可编辑格式为 `.docx`、`.xlsx`、`.pptx`。根据文件扩展名和实际容器格式双重检查类型；扩展名与内容不匹配、损坏、加密或超出限制时拒绝写入并返回可理解的错误。

Office 文件继续使用现有文件记录、`file_id`、用户归属及 `personal`、`project`、`workspace` 空间语义。格式白名单不得仅由用户提供的扩展名决定。

### FR-FS6-02：提供结构化文档检查

新增 `inspect_office_file` 工具，接收单个 `file_id`，返回文档格式、文件版本、结构摘要和有界内容片段。返回内容需适合模型定位与后续编辑：

- DOCX：按文档顺序返回段落、标题层级和表格；段落与表格单元格带稳定于当前文件版本的 locator。
- XLSX：返回工作表名、使用范围、非空单元格坐标和值/公式；公式以公式文本呈现，不声称计算结果为最新。允许通过 sheet 和范围缩小读取。
- PPTX：按顺序返回幻灯片、形状标识/类型及可编辑文本；表格内容提供行列定位。
- 输出设置硬性数量/字符限制；文档太大时返回分页或范围提示，不将整份超大文档无界注入上下文。
- locator 必须绑定 `file_id` 与当前 `version`。文件版本变化后，旧 locator 不得用于修改，需重新检查。

### FR-FS6-03：提供定点 Office 编辑

新增 `office_edit` 工具，一次调用针对一个文件和一个明确操作，避免多个格式和动作混在当前文本编辑模式中。至少支持：

| 格式 | 首期支持操作 |
|---|---|
| DOCX | 替换指定段落文本；在指定段落前/后插入段落；删除指定段落；替换表格单元格；在表格末尾追加一行；删除指定表格行。 |
| XLSX | 设置/清空指定单元格；在指定工作表末尾追加一行；删除指定工作表行。 |
| PPTX | 替换指定文本形状/表格单元格文本；在指定幻灯片新增文本框；删除指定文本形状；按现有版式复制指定幻灯片后更新文本。 |

操作使用 `file_id`、`expected_version`、格式专属定位字段及单一 `action`。不得仅按重复文本静默选择第一个匹配项；目标不存在或匹配不唯一时返回歧义和重新检查提示。修改操作不得改变文件格式或绕过用户文件归属校验。

任何会丢弃内容的操作（段落、行、工作表、形状或幻灯片删除，以及无法局部定位的整体替换）必须接入统一确认门。对于受支持的定点单元格/文字更新，按现有 Agent 写文件授权与确认策略执行，不额外弹出与策略冲突的确认。

### FR-FS6-04：创建 Office 文档

新增 `create_office_file` 工具，首期创建 DOCX、XLSX、PPTX。调用必须明确格式、文件名和目标空间；内容按结构化对象表达：

- DOCX：标题、段落、列表和表格；
- XLSX：工作表、表头、行和可选基础单元格格式；
- PPTX：主题模板、标题/正文/要点页及简单表格页。

首期只支持应用提供的基础模板和有限样式选项，不承诺模型可复刻任意上传模板。创建成功后使用现有文件冲突策略、配额和文件库落点规则，回执返回真实 `file_id`、名称、格式和版本。

### FR-FS6-05：写入采用校验后提交

Office 编辑必须先读取并检查目标文件当前版本；若 `expected_version` 与当前版本不一致，拒绝写入并要求重新检查，防止覆盖用户或其他流程刚做的修改。

编辑器在内存或隔离临时对象中生成候选字节，完成格式容器校验、对应库重新解析、目标修改核对、未修改部件保留验证及大小限制检查后，才通过统一文件内容更新服务提交。提交需保持文件数据与数据库版本更新一致；失败时保留原文件和原版本。并发提交必须使用版本条件避免最后写入静默覆盖。

写入成功后递增文件版本、更新大小与时间、触发现有 canonical 文件变更/同步事件并重新计算配额。不得由 Office 工具自行拼物理存储路径或绕过 FileService。

### FR-FS6-06：限制格式风险并明确回执

- 首期拒绝 `.xlsm`、密码保护文件、损坏包、超大文件和库不支持的操作；不得为了“尽量保存”而移除未知内容后继续成功回执。
- `openpyxl` 不计算公式。写入公式/单元格后回执说明公式值需由 Excel/兼容引擎重算；不把旧缓存值当成新计算结果。
- 任何库明确无法保证保存的特性，应在写入前阻止该类文档或在能力检查中说明风险；不能依靠泛化免责声明替代实际风险识别。
- 成功结果指出实际修改的文件及结构目标，不回显敏感正文；失败结果区分格式不支持、定位歧义、版本冲突、容量限制、解析失败和存储失败。

### FR-FS6-07：保持文件工具职责边界

- `read_file` 保持现有文本/文档提取契约；结构定位使用 `inspect_office_file`。
- `create_file` 和 `edit_file` 继续只处理 UTF-8 文本，不接受 Office 二进制内容或 Office 专属 action。
- `delete_file`、重命名、移动、复制仍表示文件级操作；不将删除整个文件与删除文档内部对象混为同一动作。
- Office 工具复用现有文件定位、权限、确认、存储更新和回执基础设施；不复制一套所有权或路径实现。

## 3. 技术方案

### 3.1 调用边界

```text
Agent
  ├─ read_file：现有全文文本/文档提取
  ├─ inspect_office_file：Office 结构检查与版本绑定 locator
  ├─ office_edit：单文件、单操作、显式目标、expected_version
  └─ create_office_file：结构化创建新 Office 文件
          ↓
agent/tools/files/office.py：Schema、权限上下文、确认与回执
          ↓
app/services/files/office/：按格式解析、定位、应用操作、验证候选字节
          ↓
FileService 内容更新入口：归属、配额、版本并发、存储提交、canonical 变更
```

### 3.2 格式编辑器

- 创建与编辑分开选型：创建新文件优先使用已有成熟格式库；编辑已有文件优先评估目标 OOXML 部件的局部修改，不把所有格式都固定为整包打开后重新保存。Phase 0 按格式与 action 确定唯一执行路径和拒绝条件，不在执行失败后自动切换另一套编辑器掩盖错误。
- DOCX 使用 `python-docx` 进行结构读取和基础创建，段落、表格编辑对比库保存与局部 OOXML 修改的保留效果；只暴露明确支持的操作，不支持的文档部件必须保留并经 fixture 测试验证，否则对应输入应拒绝修改。
- XLSX 使用 `openpyxl` 进行结构读取和基础创建；编辑重点评估局部 worksheet、sharedStrings、styles 等必要部件的修改，避免默认全量 round-trip。行删除/追加涉及公式、命名范围、表格、图表或跨表引用时，必须正确更新受影响引用或在写入前拒绝，不能仅改行号。不执行公式计算，首期仍拒绝宏工作簿。
- PPTX 使用 `python-pptx` 进行结构读取和基础创建；文本和表格更新优先评估局部 slide XML 修改。复制幻灯片必须处理关联的 relationships、部件身份和 Content Types，不能只复制 slide XML。对不支持的图表、媒体、动画和形状结构采取保留验证或拒绝修改。
- 局部修改先确定允许变化的部件集合；未变化的 ZIP 成员保留原始解压字节，不批量美化或重写全部 XML。目标部件内还需验证非目标内容、命名空间和关系引用；ZIP 压缩结果不必逐字节相同，部件保留也不等于完整 Office 兼容。
- 采用轻量内部结果契约表达 `changed`、`locator`、`warnings` 和 `candidate_bytes`；格式库不能直接访问数据库、Storage 或用户权限。
- 首期不增加 LibreOffice/UNO；若后续确需高保真转换或复杂格式支持，另行评估独立执行服务和资源边界。

### 3.3 数据、权限与并发

- 不新增数据库表或迁移；复用现有文件记录 `version`、存储 key 和文件空间字段。
- 新的二进制内容更新入口必须扩展现有 `FileService` 写入路径，统一处理文件归属、配额、版本、同步事件和存储提交；不能长期由 Agent handler 直接 `storage.put`。
- 所有读取和写入基于 `get_owned` / 现有文件服务定位；禁止接受物理路径、存储 key 或跨用户 file id 绕过授权。
- 确认信息只包含文件标识、操作类型和目标，不包含文档正文；可见错误按现有 redaction 规则处理，日志只记录脱敏指纹与格式/操作/耗时等诊断元数据。
- 临时文件使用受控临时目录或内存流；处理结束后清理，禁止遗留用户文档副本。

### 3.4 文件范围

```text
backend/agent/tools/files/office.py                      【新增】Office 工具参数、确认、文件上下文与回执
backend/agent/tools/files/file_tools.py                  【修改】注册 Office 工具
backend/app/services/files/office/__init__.py            【新增】Office 编辑器公共入口与类型路由
backend/app/services/files/office/docx.py                【新增】DOCX 结构检查、编辑、创建
backend/app/services/files/office/xlsx.py                【新增】XLSX 结构检查、编辑、创建
backend/app/services/files/office/pptx.py                【新增】PPTX 结构检查、编辑、创建
backend/app/services/storage/file_service/files.py       【修改】受版本约束的二进制内容更新
backend/app/services/storage/file_service/__init__.py    【修改】暴露统一内容更新入口
backend/agent/skills/file-ops.md                         【修改】说明 Office 检查、编辑和格式限制
backend/agent/tools/README.md                            【修改】记录工具边界与 Schema 契约
backend/tests/agent/tools/files/test_office_tools.py     【新增】工具参数、归属、确认与回执行为
backend/tests/services/files/office/                     【新增】格式编辑器结构操作、拒绝条件和 round-trip 测试
backend/tests/services/storage/test_file_content_update.py 【新增】版本冲突、配额、原子提交及文件变更事件
```

格式编辑器只负责文档字节和结构操作；Agent 工具负责对话工具契约；FileService 是文件写入、权限、版本和同步的唯一业务入口。不得修改 `create_file` / `edit_file` 的文本语义，不新增数据库迁移，不把 LibreOffice 安装进 Web 镜像，不在工具 handler 复制 FileService 的归属/配额/同步逻辑。若现有 FileService 无法原子更新文件内容，应先在其职责内建立受测入口，不从 Office 编辑器绕开。

### 3.5 MiniMax Office Skill 选择性融合

2026-10-03 已对 [MiniMax 官方 Skills 仓库](https://github.com/MiniMax-AI/skills) 进行源码调查；这属于复用候选评估，不代表已安装、完成兼容测试或接入运行时。

| 上游能力 | 可复用部分 | 首期接入策略 |
|---|---|---|
| [minimax-docx](https://github.com/MiniMax-AI/skills/blob/main/skills/minimax-docx/SKILL.md) | 创建/编辑/套模板工作流、排版指南、OpenXML 结构与校验案例 | 转译为 Gugu 的工具指南和 fixture；.NET 8/OpenXML SDK 实现只作对比候选，不直接引入其安装脚本或运行依赖。 |
| [minimax-xlsx](https://github.com/MiniMax-AI/skills/blob/main/skills/minimax-xlsx/SKILL.md) | OOXML 局部编辑思路、基础模板、公式静态检查和引用处理案例 | 优先评估 Python 实现，审查后按需改造为内部字节处理函数；不原样调用路径型 CLI。 |
| [pptx-generator](https://github.com/MiniMax-AI/skills/blob/main/skills/pptx-generator/SKILL.md) | 版式配方、模板编辑、幻灯片关系处理与质量检查流程 | 基础创建仍使用现有库；PptxGenJS 仅在模板与排版收益经验证后另行评估，不作为首期必需依赖。 |

融合分为三层，不能新增绕过现有工具的第二套文件写入入口：

1. **Skill 指南层**：将上游场景路由、模板和验证经验改写到现有 `file-ops` Skill，按需加载；调用本 PRD 的三个 Office 工具，不要求模型直接改物理路径或自行安装依赖。上游的脚本、资源和 references 不能仅靠复制 SKILL.md 获得运行能力。
2. **格式编辑器层**：复用通过审查的算法或资源，统一接收受控字节和结构操作，返回候选字节及校验结果；需要临时目录的实现由服务创建并限制范围，不能接受用户提供的输出目录或递归清理任意路径。
3. **文件业务层**：归属、确认、版本冲突、配额、文件变更和存储提交继续由现有工具及 FileService 处理；Office 核心能力不依赖 Shell 授权、独立沙盒服务或某个 LLM Provider。

已发现的上游边界必须纳入改造与测试，不能照搬其“零格式损失”或“校验通过即安全”的描述：

- [XLSX 解包器](https://github.com/MiniMax-AI/skills/blob/main/skills/minimax-xlsx/scripts/xlsx_unpack.py) 会清理已有输出目录并重新格式化全部 XML；内部实现必须改为独立受控临时目录和限定部件修改，并加入解压总量、成员数量、路径及 XML 解析限制。
- [行位移脚本](https://github.com/MiniMax-AI/skills/blob/main/skills/minimax-xlsx/scripts/xlsx_shift_rows.py) 遍历多个工作表，且命名范围、结构化引用和外部链接处理存在明确限制；不能直接用于指定工作表的增删行。测试必须区分目标表、其他表自己的坐标与确实引用目标表的公式。
- [公式校验器](https://github.com/MiniMax-AI/skills/blob/main/skills/minimax-xlsx/scripts/formula_check.py) 是静态检查，不执行重算且含启发式判断；不能将退出码 0 当成计算正确或整份文件兼容的证明。
- DOCX 上游的自动修复、格式清理或校验降级只能作为案例，不能成为本服务遇错继续提交的兜底路径。

实际引入代码、模板或文档前固定上游 commit，记录来源、改造范围和依赖；保留 [MIT 版权与许可声明](https://github.com/MiniMax-AI/skills/blob/main/LICENSE)，逐项核对资源及第三方依赖许可证。不运行上游自动安装脚本，不从浮动分支在用户运行时下载或更新代码；复用材料随 Gugu 发布。需要增加运行依赖或扩大格式范围时，先更新本 PRD 再实施。

## 4. 验证与上线

- 工具契约测试验证：支持格式与 action 枚举正确；缺字段、额外字段、混合动作、模糊 locator 和过期版本均在写入前拒绝。
- 格式行为测试使用包含段落/表格、公式/样式、文本形状/表格及未支持对象的真实 fixture；分别验证新增、更新、删除、重读定位、保存后再次解析，以及未修改部件保留或明确拒绝。
- 局部编辑验证 ZIP 成员清单、非目标部件解压字节及受影响关系；加入共享字符串、跨表公式、命名范围、幻灯片关联资源等 fixture。保留原部件但关系或引用已损坏也必须判为失败；不能用可重新解析替代语义保留测试。
- 故障注入验证：解析、序列化、配额、存储写入、数据库提交、版本冲突任一失败，原文件字节、版本和配额事实不被部分覆盖；canonical 文件变更只在成功提交后产生。
- 安全测试验证跨用户文件 ID、已删除文件、空间边界、Workspace 绑定、确认取消及过期 locator 均不产生写入。
- 端到端验收覆盖 Agent 检查文件 → 按 locator 修改 → `read_file`/再次检查确认修改 → 在文件库下载并由对应 Office 解析器打开。
- 先以 DOCX/XLSX/PPTX 各自有限 fixture 完成后端验证，再开放工具注册；首期不要求新增 Admin 开关，不依赖浏览器 Office 预览能力。
- 回滚时撤销工具注册并保留文件数据；不需要数据库回滚或迁移。若出现文件兼容或内容丢失风险，立即关闭 Office 写入入口，继续保留现有 Office 读取和文件级 CRUD。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 格式库不理解某些 Office 部件 | 保存后图表、媒体、宏或版式可能丢失 | 先定义可支持子集；未知部件 fixture 覆盖；不能证明保留时拒绝写入。 |
| 文件在检查和修改之间被其他请求更新 | 丢失并发修改 | locator 绑定 `version`，写入要求 `expected_version` 匹配并进行原子条件更新。 |
| Word/PPT 重复文本导致定位不唯一 | 修改错误段落或文本框 | 使用文档版本绑定的 locator；按文本定位必须唯一，否则返回歧义。 |
| XLSX 修改公式后旧缓存值仍存在 | 用户把缓存值误认为重算结果 | 不声称执行计算，回执明确指出重算边界；测试区分 formula 与 cached value。 |
| 多层工具参数对模型不稳定 | 工具校验失败或动作目标缺失 | 每次单文件单操作，压平关键定位字段；控制 Schema 深度；对真实 Provider 调用做契约回归。 |
| 存储和数据库提交无法构成单事务 | 文件字节与元数据版本可能短暂不一致 | 复用/扩展统一 FileService，设计可恢复提交顺序并加入故障注入测试；确认实现策略后才开放写入。 |

**待确认事项**：首期允许编辑的最大文档字节数、每次 inspect 的最大输出量和是否默认对复杂格式生成副本，应在 Phase 0 根据当前文件上传限制、存储提交能力及真实 fixture 评估后定案；未定案前不得绕过现有限制。

## 6. 唯一实施 TODO

### Phase 0：能力与格式安全基线

- [ ] `FS6-001` 核对三种格式库对已支持/未支持 Office 部件的 round-trip 行为并确定拒绝策略；验收：每种格式均有带未支持部件的 fixture，文档记录最大字节数、输出限额、格式检测及复杂格式处理策略。
- [ ] `FS6-002` 定义结构检查结果、版本绑定 locator 和单操作工具 Schema；验收：DOCX/XLSX/PPTX 均能表达唯一目标，歧义、过期 locator、额外字段和多动作混传均可拒绝。
- [ ] `FS6-011` 完成 MiniMax Office 复用选型与来源审查；验收：固定候选上游 commit，记录许可证、依赖、复用/拒绝清单；使用同一批 fixture 对比库 round-trip 与局部 OOXML 修改，确定每种格式/action 的唯一执行路径，不引入未经确认的 .NET/LibreOffice/PptxGenJS 依赖。

### Phase 1：结构化检查

- [ ] `FS6-003` 实现 `inspect_office_file` 并复用现有文件归属/读取限制；验收：三种格式能返回有界结构与 locator，跨用户、损坏文件、超限文件均不泄露内容或绕过限制。

### Phase 2：原子内容更新基础

- [ ] `FS6-004` 在 FileService 增加受 `expected_version` 约束的二进制内容更新入口；验收：版本冲突拒绝覆盖，配额/文件版本/canonical 变更一致，注入失败时原内容可验证不变。

### Phase 3：Office 定点编辑

- [ ] `FS6-005` 实现 DOCX 段落和表格操作；验收：目标增改删后可重新解析定位，未支持部件不被静默丢弃，失败不改变原文件。
- [ ] `FS6-006` 实现 XLSX 单元格和行操作；验收：按 Phase 0 路径完成目标部件与非目标部件保留验证，行操作不误移其他工作表坐标，相关公式/命名范围正确更新或拒绝；不支持宏/图表等风险输入按基线拒绝，静态公式检查不被声称为已重算。
- [ ] `FS6-007` 实现 PPTX 文本形状、表格与简单幻灯片操作；验收：目标形状/幻灯片经保存重读与关系完整性验证，复制后部件身份和关联资源有效，非目标部件保留，未支持媒体、图表和动画对象按基线保留或拒绝。
- [ ] `FS6-008` 注册 `office_edit` 并接入统一确认、文件工具授权及回执；验收：模型可单操作完成三种格式增改删，确认取消无写入，成功后文件库读回和版本均更新。

### Phase 4：结构化创建与发布验收

- [ ] `FS6-009` 实现 `create_office_file` 的基础模板创建；验收：可在个人、项目和授权 Workspace 创建有效 DOCX/XLSX/PPTX，冲突、配额、归属和真实 file_id 回执符合现有文件契约。
- [ ] `FS6-010` 完成文件工具 Skill、测试和上线验收；验收：选择性吸收 MiniMax 场景路由、模板和验证指南并适配 Gugu 工具，不保留直接 Shell 写回或自动安装指令；Agent 完成检查—修改—重读闭环，后端文件工具/格式/存储测试通过；发布说明明确首期格式边界与风险，不改动现有文本工具行为。
