# N2 QQ 与 Telegram 绑定码签发

新增：

- `POST /api/v1/me/bots/{bot_id}/qq-binding-code`
- `POST /api/v1/me/telegram/connect/{bot_id}/binding-code`

## 合约与接线

Python 基线为 `user_bots.py:create_qq_binding_code`、`telegram_connect.py:create_binding_code` 及 `im_identity.py` 的创建和消费函数。只允许当前 owner、对应平台且尚未绑定的 Bot；不存在/跨用户/平台不匹配返回404，已绑定返回409。六位码允许前导零；Redis只保存 owner、HMAC与随机challenge_id，TTL600秒，不保存明文码。

Core `im/binding-code.ts` 承载授权与用例；Host `modules/im/binding-code.ts` 注入 PostgreSQL、Redis和密码学。QQ HMAC消息为 bot_id:owner:code，Telegram增加 telegram: 前缀；密钥由Host注入，不写配置或日志。重发覆盖同Bot旧挑战；并发重发保留最后写入值。保留Python六位随机空间可能碰撞及既有消费者在重发期间的并发限制，没有额外承诺跨重发的强单次消费。

生产入口直接调用Core并写入现存Python消费者读取的正式Redis键。消费由旧Python入口承担，本次没有增加无人消费的队列，也不声称Node IM网关已迁移。QQ原消费者支持同身份重复成功并发布IM变化；Telegram底层消费者第二次返回False，未将两者强行统一。

## 证据与限制

- 先写两平台授权/HMAC/TTL行为测试，devserver因Core模块缺失失败，再实现后通过。
- 生产无Redis真实路径先返回500，与预期503失败；随后新增明确不可用错误和目标route的固定脱敏503，不向调用方返回未保存的内存挑战，也不修改共享错误handler。这是相对Python裸Redis异常的显式服务不可用映射。
- Node 2/2（规则与生产跨语言集成）。真实生产Host经认证签发，覆盖404/409、两并发重发、哈希不含明文值、TTL、缺Redis503；真实Python消费函数在同一隔离PostgreSQL schema和Redis读取并绑定成功。QQ消费后的IM会话epoch递增亦已验证。
- Python模型元数据在随机schema建表；不是生产Alembic升级或网关触发器验收。正式SQLite、真实IM消息和已部署服务未验收。
- Python旧QQ绑定、Telegram连接及协议回归30/30。初跑26通过、4项因测试venv缺aiohttp失败；仅在本任务临时venv安装requirements声明依赖后30/30，不修改真实运行环境。
- Core build通过。Host tsc本切片无报错，整体仍有并行Core assemble/Anthropic driver/history的findLast/findLastIndex与ES2023 lib及其隐式类型错误。
- 测试使用临时配置/存储、合成账号与凭据、私有Redis逻辑数据库及隔离PG，Python消费者夹具显式禁用真实.env/override读取；没有请求真实外部IM、Provider或Docker。Core、Host和Python夹具本地/devserver SHA-256一致。

未修改Python参考实现，未提交、推送或触发CI。

消费者CLI夹具默认拒绝数据库连接，集成测试显式传入 `--allow-isolated-test-database` 后才执行；该安全开关及两平台503固定文案追加验收1/1通过，最终夹具和生产测试本地/devserver哈希一致。未进行额外构建。
