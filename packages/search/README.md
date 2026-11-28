# @gugu/search

咕咕 monorepo 的共享搜索 API。Web、Desktop、Core 数据来源和 Agent 工具通过这个包复用查询规范、来源编排、Unicode 匹配规则与目录扫描算法。

## 边界

- 本包不连接数据库、不读取应用配置、不保存文件索引，也不决定用户能访问哪些数据。
- 调用方装配可信来源；数据库查询和 owner 限定留在 Core/Host adapter，文件根目录授权、路径校验和结果引用留在具体 Host。
- 文件系统扫描器只接收宿主提供的目录读取函数；宿主必须在该函数内执行授权范围和符号链接检查。
- 首版不建立持久索引。目录变化立即来自真实文件系统；当扫描数据和实测性能证明需要时，可新增索引来源而不改变查询 API。

## 公共 API

| API | 导入路径 | 用途与输入 / 输出 |
|---|---|---|
| `parseGlobalSearchQuery(value)` | `@gugu/search` | 校验并规范化 `q`、`queries`、`mode`、`per_type`、`types`；返回 `GlobalSearchQuery` |
| `normalizeGlobalSearchQueries(q, queries)` | `@gugu/search` | 去空白、按码点截断、Unicode casefold 去重；返回最多 8 个关键词 |
| `createGlobalSearchOperations(sources)` | `@gugu/search` | 注册可信来源，按统一类型顺序查询并合并；返回支持取消信号的 `GlobalSearchOperations` |
| `createFileSearchSources(search)` | `@gugu/search` | 把宿主回调接成 `file` 与 `folder` 来源，共享同次扫描结果 |
| `scanFilesystem(options)` | `@gugu/search` 或 `@gugu/search/filesystem` | 有界并发、按层 BFS 扫描；返回扫描条目数和 `partial` 标志 |
| `matchFolderSearchHits(query, hits)` | `@gugu/search` | 优先精确路径匹配，其次完整名称匹配，并按路径去重 |
| `searchSnippet(text, queries)` | `@gugu/search` | 根据关键词生成短文本片段 |
| `casefoldSearchText(text)`, `lowerSearchText(text)` | `@gugu/search` | 按固定 Unicode 16 规则执行大小写折叠和小写转换 |
| `stripSearchWhitespace(value)` | `@gugu/search` | 移除搜索词首尾的 Unicode 空白 |
| `SearchError`, `GlobalSearchUnavailableError` | `@gugu/search` | 搜索错误及不可用来源错误；`SearchErrorCode` 为 `invalid_request`、`not_found`、`conflict`、`storage_error` |

类型 API 包括 `GlobalSearchQuery`、`GlobalSearchType`、`GlobalSearchSource`、`GlobalSearchOperations`、`SearchFilesystemRoot`、`SearchFilesystemEntry`、`SearchFilesystemScanOptions` 和 `SearchFilesystemScanResult`。`GLOBAL_SEARCH_TYPES`、`GLOBAL_SEARCH_ORDER` 为可用类型及来源排序常量。

```ts
import {
  createGlobalSearchOperations,
  parseGlobalSearchQuery,
  createFileSearchSources,
  scanFilesystem,
} from '@gugu/search'

const query = parseGlobalSearchQuery({ q: '设计', types: ['file', 'folder'] })
const operations = createGlobalSearchOperations(sources)
const result = await operations.search(trustedOwnerId, query, { signal })
```

`GlobalSearchSource` 描述一个按类型查询的来源；`createGlobalSearchOperations` 校验来源目录、依次调用请求的来源、合并分组并尊重取消信号。身份必须由调用方从已验证会话取得，不能从搜索词或工具参数中推断。

`scanFilesystem` 提供按层 BFS、默认 4 路且最多 16 路的有界并发遍历和最大条目数。它逐条回调，不长期保留扫描结果；达到条目上限时返回 `partial: true`。它不跟随符号链接，依赖 `readDirectory` adapter 对每一层重新校验路径。

`createFileSearchSources` 让文件和文件夹结果共享宿主的一次扫描。`normalizeGlobalSearchQueries`、`casefoldSearchText`、`lowerSearchText` 和 `searchSnippet` 提供跨数据库、文件名及 Agent 使用的一致 Unicode 行为。

## 目录

```text
src/
  errors.ts       搜索包错误及协议码
  file-source.ts  文件/文件夹共享扫描来源适配
  filesystem.ts   有界并发的 BFS 目录扫描
  index.ts        公开 API
  query.ts        查询解析、规范化、文件夹命中匹配
  service.ts      来源编排、缺失来源检测、结果片段
  unicode.ts      固定 Unicode 16 casefold/lower 规则
```

## 构建

```sh
pnpm --filter @gugu/search typecheck
pnpm --filter @gugu/search build
```
