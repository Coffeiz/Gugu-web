# 离线沙盒一体化分发设计

## 目标

让 FNOS、群晖等本地部署用户只需导入一个镜像包即可使用完整 Shell 沙盒，不需要手动拉取 Docker Hub/GHCR 镜像，也不需要理解 `sandboxd` 与执行镜像的关系。

## 已确认的边界

- 分发合并：一个 tar 包包含部署所需的 Gugu 应用、Shell 执行镜像和 egress 代理镜像。
- 运行隔离：`sandboxd` 继续作为常驻控制服务，按需创建临时 `gugu-sandbox` 执行容器。
- 不新增 `sandbox-bootstrap` 常驻容器。
- 本地镜像优先：镜像已导入时，启动不得无条件访问 Docker Hub。
- 安全不降级：离线包携带固定 digest 与发布信任元数据；不通过关闭验签来规避网络问题。
- 网络部署仍可使用默认 Compose 的在线拉取方式。

## 运行模型

```text
用户导入一个 tar 包
        │
        ├── gugu-web                 常驻应用
        ├── ubuntu/squid             常驻 egress 代理
        └── coffeiz/gugu-sandbox     按需创建的临时执行容器
                    ▲
                    │
              sandboxd 控制
```

`sandboxd` 不等于执行容器：它负责权限、工作区、网络和生命周期；`gugu-sandbox` 只负责运行命令。两者在运行时保持隔离，在分发时合并进同一个镜像包。

## 配置与失败行为

- 在线模式：执行镜像缺失时允许按现有策略拉取并解析 digest。
- 离线模式：执行镜像缺失时立即输出明确错误，说明需要重新导入 bundle；不得尝试访问外部 registry。
- 离线模式使用 bundle 中记录的固定 digest；启动前校验本地镜像 ID/digest 与 bundle manifest 一致。
- bundle 在构建/发布阶段完成 Cosign 校验，运行时不为了离线启动再拉取 Cosign verifier。
- `egress-proxy` 的配置不再依赖宿主机存在 `squid/egress.conf`，Compose 自包含配置。

## 交付物

1. bundle 构建脚本：校验所需镜像、生成 manifest、使用 `docker save` 输出单个 tar。
2. Compose 离线覆盖配置：`pull_policy: never`，引用本地标签与 bundle manifest。
3. sandbox 初始化逻辑：本地优先、在线/离线模式分流、digest 一致性校验。
4. 发布/验收测试：覆盖镜像已存在、镜像缺失、离线禁止外连和 manifest 不匹配。
5. 部署文档：用户只需 `docker load` 一次，再导入 Compose 项目。

## 非目标

- 不把不可信 Shell 执行逻辑直接并入 `gugu-web` 进程。
- 不把 `sandboxd` 与执行容器做成同一个常驻服务。
- 不修改生产分体 Compose 的数据库拓扑。
