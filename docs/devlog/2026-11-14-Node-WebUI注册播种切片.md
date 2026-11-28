# Node WebUI 注册播种切片

## 范围

把新用户引导播种从注册后的 no-op 接到 Node Host。播种会建立引导项目、首日日历活动、两份项目 Markdown 文件、可选的个人 MP3，并写入 seed 与 guide 状态。账户注册已经提交后才运行播种；播种失败不会撤销账号创建。

PostgreSQL 适配器在一个事务中锁定并检查 seeded 状态，再写项目、日历、Local 文件元数据与引导状态。Local 文件复用文件上传域的安全路径、同名冲突和存储配额规则；数据库回滚时补偿删除本轮已创建的文件。Dockerfile runtime stage 已配置复制可选 onboarding MP3 资源；按测试边界没有构建或运行 Docker 镜像。

## 基线与验证

- Python 兼容基线：`tests/platform/security/test_review_security_regressions.py`、`tests/platform/auth/test_onboarding_state.py`、`tests/platform/auth/test_user_smtp_api.py`、`tests/platform/auth/test_auth_cookies.py`，25 项通过。仓库没有直接覆盖 `seed_for_user` 的 Python pytest，因此此基线覆盖注册事务、验证码、Cookie 与引导状态相邻契约，不代表 Python 播种函数本身的直接回归覆盖。
- Node 注册与引导切片：注册验证码、注册事务、引导状态、播种适配器与 MP3 资源测试合计 30 项通过、0 项失败；5 项隔离 PostgreSQL 测试因 devserver 未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 而跳过。
- 播种适配器的受控 PG 替身测试覆盖完整创建、重复调用幂等、写入第二个文件失败的补偿，以及 seed 状态更新失败的补偿。它不替代真实 PostgreSQL 集成验证。
- Node TypeScript 类型检查与构建配置检查通过。
- 所有执行均在 devserver 原生环境进行；未使用 Docker，也未对运行数据库写入。

## 待验证

配置专用隔离 PostgreSQL 测试库后，运行 onboarding seed 的真实 PG 集成回归，验证表结构、配额账本和并发 seeded gate。生产数据库不作为测试库。
