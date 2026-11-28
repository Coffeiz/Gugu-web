# 偏好配色规则公共化

Core `preferences/palette.ts` 统一当前用户配色：Ink、Cafe、Terra、Harbor、Grove 分别使用现有接口值 `neutral`、`cafe`、`red`、`blue`、`green`。Web 偏好读写与反馈邮件共用有效值；反馈邮件和 SMTP 预览复用相同的亮色、暗色主色。旧配色名称和其他未知值在偏好读取中使用 Ink，写入和 SMTP 预览仍拒绝无效输入。

devserver 上偏好路由与反馈通知定向测试 22/22、前端主题状态测试 7/7 通过，覆盖当前配色的写入与重读、未知值和实际调用路径。后端测试通过临时路径映射加载已核对的 Core 源码；前端测试使用临时依赖和 API 模拟。尚未验收真实 SMTP 部署或发行包。

普通偏好的字段校验、默认值、响应投影、人格文件更新及失效编排已迁入 Core `preferences/`；Web Host 保留认证、上传协议和实际文件适配。偏好文档由 Core 双库存储，Web 生产 Host 已接入；正式 SQLite v15→v16 备份升级、owner 约束和冲突回滚，以及隔离 PG 合同已通过。生产 Host、Vite 代理和 PG 定向测试 4/4 通过，Vite 使用临时目录且未验证页面预构建。桌面 Host 的 schema 校验和侧车清单已复用 Core 版本，真实 CoreHost 定向测试 20/20 通过；桌面偏好 IPC 和发行制品尚未验收。

SMTP 设置读取与写入仅委托 Core，Host 保留凭据解密以执行测试邮件；旧 PostgreSQL 设置读写已删除，启用密码能力但未装配 Core 服务时明确失败。正式 SQLite/隔离 PG 合同 2/2 及 Host/隔离 PG 定向回归 3/3 通过，覆盖密文、保留与清除密码和用户隔离。

SMTP 保存与测试请求共用 Core 字段解析，测试邮件的传输和凭据解密仍由 Host 处理。SQLite、隔离 PG 和偏好 HTTP 定向回归共 20 项通过，保留密码省略、清除及用户隔离验证。
