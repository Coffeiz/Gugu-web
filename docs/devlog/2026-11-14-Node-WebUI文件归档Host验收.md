# Node WebUI Local 文件归档 Host 验收

## 范围

验收 Local 文件库的 ZIP 归档与解压路径：Vite API 代理、Node Host 用户认证、PostgreSQL 适配器以及临时磁盘存储。测试数据使用合成用户和文件，PostgreSQL 每次使用随机隔离 schema。

## 验收结果

- Vite→Node Host→PostgreSQL 完成文件夹 ZIP 归档和解压往返；验证归档内路径与正文、解压后的数据库记录和本地文件、配额账本更新及提交后资源事件。
- 未认证请求返回 401；选择其他用户的文件夹返回 404。
- Node 归档定向测试 11/11 通过，0 失败、0 跳过；Python 归档与 API 基准 33/33 通过；`corepack pnpm run typecheck` 通过。
- 测试结束后隔离 PostgreSQL schema 计数为 0，临时归档目录计数为 0。
- 清除了本轮测试环境中的 Python pytest 缓存、Python 字节码缓存和 Vite 预构建缓存。

## 回归修复

`unzipper.Open.file()` 返回的目录条目可能没有 `vars` 字段；实际解析结果将 flags、解压尺寸和外部文件属性放在条目顶层。解压器现在同时读取实际返回形状和带 `vars` 的类型形状，合法目录项不会再被判为损坏 ZIP。新增运行时测试使用归档器相同的 JSZip 流选项生成目录树，并验证解压正文。

PostgreSQL `bigint` 在 Node 驱动中以字符串返回。集成断言先转换数值再比较，避免把数据库类型映射误判为配额错误；ZIP 目录路径断言也遵循解压器去掉末尾斜杠后的规范化结果。

## 验收说明

测试通过 devserver 原生 Node、pytest、Vite 和隔离 PostgreSQL 运行，未使用 Docker，也未修改运行配置。Vite 测试进程会输出 Git 仓库探测 stderr 和 Node `module.register()` 弃用提示；本次请求及断言均通过，这些提示不影响结果。
