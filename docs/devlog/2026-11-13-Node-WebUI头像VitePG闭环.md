# Node WebUI 头像 Vite 与 PostgreSQL 闭环

## 范围

为账户资料页头像上传与公开头像读取补充 Vite→Node Host→PostgreSQL/Local 文件系统集成验收。

## 验证的行为

- 未认证头像上传返回 401；认证用户只能以 Host 身份写入自己的头像，客户端不能传入 owner。
- multipart 使用 `file` 字段；WebP 上传更新 PostgreSQL 相对路径并写入 Local 临时根目录。
- 替换头像只删除当前用户旧文件，其他用户文件不受影响；公开头像读取返回保存的字节、媒体类型和 `no-cache`。
- SVG 上传返回 400，现有头像保持可读；测试使用随机 schema 与一次性临时目录。

## 验证结果

- devserver Node TypeScript typecheck 通过。
- devserver Node 头像 route、隔离 PostgreSQL 与 Vite 集成测试 **5/5 通过、0 跳过**。
- devserver Python `tests/platform/auth/test_auth_avatar.py` **5/5 通过**。
- 本地未运行测试。Vite 启动期间版本脚本因同步树没有 Git 元数据打印 `fatal: not a git repository`，不影响本次 HTTP/数据库行为测试。

