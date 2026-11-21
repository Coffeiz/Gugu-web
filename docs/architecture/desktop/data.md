# 咕咕 Desktop 数据架构

本文定义 macOS 与 Windows 的用户文件、应用数据、工作区和本地 Agent 执行方案。桌面端已使用本地 SQLite，工作区管理、系统回收站和双平台 MXC 接入按本文验收。

## 数据归属与平台目录

| 数据 | macOS | Windows |
| --- | --- | --- |
| 用户文件的默认工作区 | 系统「文稿」目录下的 `Gugu-data/personal/`，通常为 `~/Documents/Gugu-data/personal/` | 系统「文档」已知文件夹下的 `Gugu-data\personal\`，通常为 `%USERPROFILE%\Documents\Gugu-data\personal\` |
| 项目文件的默认目录 | `Gugu-data/project/YYYY/MM/项目名 #项目ID/` | `Gugu-data\project\YYYY\MM\项目名 #项目ID\` |
| 正式应用数据根目录 | `~/Library/Application Support/Gugu/` | `%LOCALAPPDATA%\Gugu\` |
| 应用数据库和内部附件 | 应用数据根目录下的 `data/core.db` 与 `data/blob_storage/` | 应用数据根目录下的 `data\core.db` 与 `data\blob_storage\` |
| 外部工作区 | 用户选定的 Finder 文件夹 | 用户选定的文件资源管理器目录，可位于其他盘符 |

- **用户文件**以普通目录和原文件名保存。个人文件、项目文件和用户从聊天主动保存的成果都属于这一类。
- **应用数据**包括 SQLite、文件索引、关联关系、操作收据和内部附件。缩略图等可重建产物放在独立缓存目录。应用管理的软件凭据继续走现有安全存储。
- **外部工作区**是对现有目录的绑定。文件正文保留在原目录，咕咕记录绑定、权限和项目关联，用户可继续使用系统文件管理器直接操作。

默认工作区由 Electron Main 通过 `app.getPath('documents')` 解析。Windows 的「文档」可能已重定向到 OneDrive 或企业目录，界面显示实际解析路径。Windows 正式应用数据单独解析 `FOLDERID_LocalAppData`，避免使用 Electron 默认指向 Roaming AppData 的 `appData` 作为活跃 SQLite 的长期位置。 [Electron app API](https://www.electronjs.org/docs/latest/api/app/) · [Windows Known Folders](https://learn.microsoft.com/en-us/windows/win32/shell/known-folders) · [OneDrive 已知文件夹重定向](https://learn.microsoft.com/en-us/sharepoint/redirect-known-folders)

macOS 应用数据沿用 Application Support 惯例。系统文稿目录用于解析「个人文件」的初始位置。 [Apple 文件系统指南](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html)

## 用户操作

| 操作 | 预期行为 |
| --- | --- |
| 首次进入文件库 | 在系统文稿或文档下初始化 `Gugu-data/personal` 和 `Gugu-data/project`，个人文件映射到 `personal/`。系统拒绝访问时提示授权或重新定位。 |
| 导入文件或保存聊天附件 | 复制到当前工作区，保留原文件名。目标已有同名文件时提示用户选择处理方式。 |
| 保存项目文件 | 默认保存到 `Gugu-data/project/YYYY/MM/项目名 #项目ID/`，首次写入时创建目录。沿用 Linux Web Host 的年月、项目名称清理和项目 ID 后缀规则，缺少年月时按现有规则省略年月目录。项目改名或日期变更后，下次访问项目文件时按项目 ID 找到原目录并移动到新位置。 |
| 添加外部工作区 | 通过 Electron 原生目录选择器选择已有目录，也可在系统允许时先创建文件夹。绑定后直接访问原目录，默认以目录名显示，同一真实目录重复添加时打开已有工作区。项目可关联已登记的工作区。 [Electron 目录选择器](https://www.electronjs.org/docs/latest/api/dialog#dialogshowopendialogwindow-options) |
| 在系统中显示 | macOS 打开 Finder，Windows 打开文件资源管理器，并定位到文件或目录。 |
| 重命名工作区 | 更新咕咕内的显示名，磁盘目录沿用原名。 |
| 移到系统回收站 | Electron Main 调用 `shell.trashItem`。macOS 在 Finder 废纸篓恢复，Windows 在系统回收站恢复。失败时保留原文件并提示原因。批量操作按项报告结果。 [Electron 系统回收站接口](https://www.electronjs.org/docs/latest/api/shell#shelltrashitempath) |
| 迁移现有文件 | 由用户单独触发。预览来源、目标和同名冲突，复制并校验成功后再更新关联。 |
| 解除外部绑定 | 移除导航入口并撤销访问授权，保留原目录和文件。历史引用保留原工作区 ID，并显示需要重新绑定。 |

绑定以稳定的工作区 ID 标识，文件关联保存工作区 ID 与相对路径。外置盘断开、盘符变化、云文件尚未下载、目录移动或权限失效时，保留关联并提示用户重新定位或授权。重定位成功后，同一工作区 ID 下的关联可继续解析。

桌面端文件库的显式删除操作使用系统回收站，恢复通过 Finder 或文件资源管理器完成。切换前已存在的 `.gugu-trash` 目录及其内容原地保留，继续排除在文件库和索引之外。需要找回旧文件时，可通过系统文件管理器访问该目录。桌面 Agent 不注册独立的回收站/清理工具；需要由 Agent 清理文件时使用桌面 Shell，文件操作语义由命令本身决定，并继续受桌面 Shell 权限策略约束。

Linux 沙箱通过 `/personal` 和 `/project` 暴露个人及项目目录。Desktop 从实际的 `Gugu-data/project` 根目录访问相同的相对结构，由 Core 复用项目路径规则并解析宿主路径。

## Session 与目录策略

- 普通新对话默认绑定「个人文件」。从文件库发起「在此工作区新建对话」时带入当前工作区。输入框旁显示所选工作区并允许切换。
- Session 保存 `workspace_id`。每次运行由 Core 验证绑定并解析真实根目录，将其作为本地 Shell 的 `cwd`。单次运行固定使用启动时的绑定及权限。正常切换在下一次运行生效，撤销授权时停止使用该授权的执行并禁止后续启动。工作区不可用时提示重新定位或切换。
- 个人与项目目录是管理根下的同级目录。桌面用户终端以个人文件目录为起点，每个会话通过 PTY 启动本机 Shell，继承系统用户权限。Agent 工具执行继续由 MXC 按工作区授权。重新绑定个人文件只改变个人目录映射，项目仍使用固定的 `Gugu-data/project`。
- 文件库按工作区 ID 与相对路径浏览和操作文件。Desktop 的 `@文件` 使用下文的本机搜索契约，可选择工作区之外的文件。Session 的工作目录与 MXC 权限继续由工作区授权决定。
- macOS 和 Windows 均使用绑定目录的真实宿主路径。工具输出按平台保留原生路径语义，业务层使用工作区 ID 与相对路径作为跨平台契约。两端均可在系统文件管理器中直接操作原文件。

## Desktop 文件引用与索引

- **默认复用系统索引。** macOS 使用 Spotlight，Windows 查询本机 Windows Search 的 `SystemIndex`。搜索覆盖系统已有索引中的可访问文件。系统服务关闭、索引尚未就绪或某目录被系统排除时，显示对应状态，补充目录仍可单独搜索。 [Apple NSMetadataQuery](https://developer.apple.com/documentation/foundation/nsmetadataquery) · [Microsoft 查询 Windows Search 索引](https://learn.microsoft.com/en-us/windows/win32/search/-search-3x-wds-qryidx-overview)
- **允许添加补充目录。** 用户通过系统目录选择器添加本机目录或可访问的外置卷目录。咕咕仅在这些明确选择的目录中建立增量元数据索引，移除目录时清理其候选索引，保留已选引用的快照。补充目录与文件库工作区分别管理。
- **共用搜索契约。** 平台适配层只负责查询系统索引，Core 合并系统候选和补充索引，按文件身份或平台规范化路径去重，并统一过滤、排序、分页和取消过时请求。应用数据目录、凭据存储和废纸篓从候选排除。输入搜索词时仅读取候选元数据。
- **选中时写入 SQLite 快照。** 引用使用稳定 ID，记录选中时的文件名、类型、原路径、大小、修改时间、文件身份和引用时间。快照仅保存元数据。原文件移动、删除、被替换或失去权限时，历史引用仍显示快照，并标记原文件不可用；预览和读取先重新验证访问权限及文件身份。
- **按文件授予读取。** 搜索结果仅用于选择。用户提交引用后，可信 Core 可为本次请求读取明确选中的单个文件，遵循现有附件读取与传输规则。Shell 的 `cwd`、工作区授权及 MXC 策略继续沿用 Session 的执行配置。

## 沙箱与共享实现

桌面聊天 Shell 在 macOS 探测到 MXC Seatbelt、Windows 探测到严格的 MXC ProcessContainer 时提供。与 Web 共用命令风险和确认规则。默认请求确认，允许只读和已识别的隔离目录内写入直接执行。用户可以在聊天输入栏启用本机自动模式，危险命令授权及沙箱边界仍生效。执行目录是单次调用的隔离临时目录，网络关闭。工作区挂载待接入。

macOS 与 Windows 的本地 Agent 工具进程统一使用 MXC。共享策略使用 MXC 的进程隔离模式，由 macOS Seatbelt 或 Windows ProcessContainer 执行。以桌面制品锁定的 SDK 版本、随包原生组件及目标系统实际探测结果作为启用依据。 [Microsoft MXC 平台与后端支持](https://learn.microsoft.com/en-us/windows/apps/develop/mxc/platform-support) · [MXC 进程隔离策略](https://github.com/microsoft/mxc/blob/main/docs/containment-policy/1.0.0/policy.md)

| 层级 | 职责 |
| --- | --- |
| Electron Main / Preload | Main 调用系统目录选择、定位与回收站接口。Preload 提供类型化 IPC，沿用可信窗口和主 frame 校验。 |
| Desktop Core | 维护绑定、补充目录索引、文件引用快照、Session 关联与可信授权。文件操作和执行准备共用一套工作区解析及真实路径校验，处理符号链接、Windows junction、跨卷和大小写规则。 |
| `packages/sandbox/` | 复用现有 MXC 执行器及执行契约，统一生成策略、启动与停止进程、映射错误和输出诊断。桌面 Shell 的 macOS 和 Windows 命令适配分别位于 `src/macos/` 和 `src/windows/`。 |

- `cwd` 指定起点。MXC 策略限制实际访问范围，仅按授权开放当前工作区的读写和受控临时目录，按需开放运行所需的系统只读资源。应用数据库、凭据、其他工作区与旧回收站不在工具授权内。网络按工具需求单独授权。
- MXC 原生组件由独立 Node 运行时加载。探测或策略应用失败时，本地 Agent 执行保持禁用并返回脱敏原因。文件库仍按独立的 IPC 文件授权提供手动操作。
- macOS 若采用 App Sandbox，持久目录授权使用安全作用域书签。Windows 文件库访问仍受当前用户权限及磁盘状态约束。两端都以实际读写、撤销授权和停止执行的结果验收。 [Apple 安全作用域书签](https://developer.apple.com/documentation/professional-video-applications/enabling-security-scoped-bookmark-and-url-access)

## 备份、迁移与恢复

- 从旧版平铺目录迁移时，由用户确认将顶层个人文件移入 `personal/`，将旧「项目文件」下的目录移入 `project/`。同名冲突时保留原件，隐藏的系统文件与旧回收站保留原处。

- 咕咕备份包含一致的数据库快照、应用内部附件和工作区绑定清单。活跃 SQLite 通过一致性备份机制导出，或在 Core 完全停止后进行离线备份。
- 用户工作区与外部目录的实际文件由用户单独备份。跨设备导入时先恢复应用数据，再通过清单逐个定位目录。导入结果标明已恢复数据与仍需绑定的目录。
- 当前版本的数据根目录由 `app.getPath('appData')` 拼接 `com.gugu.desktop.preview` 得到，数据库位于其下的 `core.db`。浏览器桌面预览使用按代码检出隔离的预览数据库。正式路径切换作为独立迁移交付。
- 正式目录迁移前停止写入，生成带时间戳的备份。校验数据库、附件、LLM 预设与配置段后再切换目录；保留迁移前的数据作为回退来源。遇到已有目标库时提示用户选择，保留两份数据直到确认。

## 首版交付与验收

1. 落地「个人文件」、原生目录绑定、系统回收站。验证路径不可用、解除绑定、重新定位和回收站操作失败时的数据保留，并确认切换前已存在的 `.gugu-trash` 内容仍在原处。
2. 接入双平台系统索引、补充目录及 `@文件` 的 SQLite 元数据快照。验证工作区外搜索、候选去重、系统索引不可用、移除补充目录和原文件失效后的历史展示。
3. 接入 Session 工作区选择并复用 MXC 执行器实现双平台本地执行。验证 Shell 初始目录、默认个人与项目文件按各自授权可访问、当前工作区内允许的操作、其他工作区和应用数据访问被拒绝，以及切换、撤权、探测失败时的行为。
4. 在真实 macOS 和 Windows 制品上分别验收。macOS 覆盖文稿授权、Seatbelt 和外置盘重连。Windows 覆盖 ProcessContainer、OneDrive 重定向、非系统盘、junction 和 Unicode 文件名。
5. 独立交付工作区文件迁移及应用数据备份恢复，验证失败重试和旧数据保留。
