# 生产沙箱的 Rootless 启动与路径隐私

## 适用范围与当前状态

本规范用于后续生产 Shell 沙箱的新部署、重建和迁移，覆盖一次性 Shell、交互式 PTY 和 MCP stdio。仅约束沙箱执行环境，不要求改变运行业务容器的 Docker。

后续部署统一使用受 systemd 或 supervisor 托管的、版本匹配的官方 `dockerd-rootless.sh`；不得用手写 `rootlesskit dockerd` 替代完整的 Rootless 初始化。生产路径隐私以真实容器验收为准，不能以目录改名、终端提示符或 daemon 启动成功代替。

截至 2026-10-16：独立 Rootless Docker 的默认 OverlayFS 和 fuse-overlayfs 非 root 容器冒烟已通过；FUSE 目录转接在手工命名空间原型中通过。**完整目录转接、Docker 自动文件挂载和应用执行器尚未完成联合验收，不得把本规范视作已经可自动安装的完整隐私部署方案。** 业务服务器是否启用必须由该次部署记录和现场验收确认，不能从本文推断。详见[实验记录](../devlog/2026-10-16-沙箱虚拟文件系统路径隐私实验.md)。

生产候选进一步验证：用户目录和运行时目录均转接后，真实 Docker 容器的 9 个挂载信息入口通过路径检查，但 bindfs 转接未保留现有 ACL 写入行为；直接挂载同一合成目录可写，转接后创建文件失败。因此当前 bindfs 候选被阻止切换，不能直接推广。必须先解决权限兼容，不得通过放宽用户文件权限绕过。

该 ACL 阻断已有 devserver 隔离实验修复：协商 POSIX ACL/DONT_MASK，并在单线程创建回调中正确处理调用者 umask 与默认 ACL。直接目录/原版/修正版和独立 Docker 的权限对照已通过，材料见[实验补丁与回归脚本](../../scripts/ops/sandbox-acl/README.md)。这是固定版本、无权限变换模式的实验补丁，不是系统包升级；仍需完整部署验收，未自动用于生产。

## 必须保留的执行边界

- 沙箱使用独立 Rootless daemon；业务 backend、worker、gateway 不直接获取 Docker Socket，执行请求由 sandbox manager 校验。
- 继续保留非 root 执行用户、只读根文件系统、capability 裁剪、`no-new-privileges`、资源限制、授权目录和受控网络；路径隐私不替代这些边界。
- 文件系统管理和 FUSE 所需权限只属于可信管理层，不给用户执行容器添加 privileged、`CAP_SYS_ADMIN`、宿主 PID/网络命名空间或 `/dev/fuse`。
- 不把宿主配置、凭据、Docker 数据根或原始用户文件父目录额外挂进执行容器。
- 不对运行中的 Docker 原数据目录直接切换 storage driver；使用独立新目录和明确回滚点。禁止用放宽宿主目录权限或改用 rootful Docker 解决启动问题。

## Rootless 启动基线

1. 为执行环境准备专用非 root 账号、subordinate UID/GID、user namespace、FUSE 和所需 cgroup 条件。UID/GID 由现场检查得出，不照抄另一台部署的数值；以运行中 Rootless 子进程的 `uid_map`/`gid_map` 计算真实映射，不能假定 `/etc/subuid` 第一条范围就是正在生效的第一段映射。
2. 安装经过来源和版本核对的 Docker CLI、daemon、官方 Rootless 启动脚本、RootlessKit 及用户态网络依赖。采用 FUSE 路径隐私方案时，还需固定 `fuse-overlayfs` 和目录转接层版本。
3. 使用 systemd user service 或既有 supervisor 托管官方 Rootless 启动脚本；显式指定本部署 socket、运行目录、数据目录和存储策略。不要继承实验 daemon 的临时路径。
4. 若选用 fuse-overlayfs，必须通过实际 `docker info` 确认生效；Docker containerd image store 与经典 graphdriver 的配置不同，不能仅检查启动参数。迁移方案必须按目标版本验证，不得把禁用 snapshotter 当作适用于所有版本的默认设置。
5. 配置日志轮转，保留 `--pull=never` 的固定 digest 镜像策略；在该 daemon 内预先导入执行和 egress 所需镜像。

只读核对示例，`DOCKER_HOST` 由管理员指向本部署的 Unix Socket：

```bash
docker info --format 'driver={{.Driver}} security={{json .SecurityOptions}}'
```

结果必须包含 rootless；路径隐私使用 fuse-overlayfs 的部署还应报告相应驱动。镜像存在性、摘要、内网隔离和 egress 均需单独验证。

### `/run/docker/plugins` 权限失败及空指针

RootlessKit `--copy-up=/run` 不代表所有子目录已适合新 daemon 使用。既有 `/run/docker` 可能成为指向宿主来源的符号链接；Docker 插件管理器访问 `/run/docker/plugins` 时会被拒绝。

官方 Rootless 脚本会在**子命名空间**解除 `/run/docker`、`/run/containerd` 和 `/run/xtables.lock` 的旧链接，使新 daemon 能创建自己的目录。这是官方启动流程的一部分，**不能在宿主 Shell 中手工删除这些路径，也不能递归删除链接目标**。

Docker 29.1.3 在上述初始化失败时可能进一步在 `Events.Close` 中空指针崩溃。排查时应查找它之前的权限或初始化错误，必要时在独立实验环境用系统调用 trace 验证。不能仅凭栈顶判断 FUSE 不兼容；不要为调试停止现有业务 daemon。

参考：[对应版本的官方 Rootless 启动脚本](https://github.com/moby/moby/blob/docker-v29.1.3/contrib/dockerd-rootless.sh)。其他版本使用其对应脚本，不直接混用。

## 路径隐私部署要求

| 来源 | 部署要求 |
| --- | --- |
| 容器根文件系统 | 使用经验证不会公开宿主镜像层来源的存储方式；fuse-overlayfs 是已通过根挂载冒烟的候选，不代表整套挂载已通过 |
| 用户工作区、个人文件及项目文件 | 管理层提供 FUSE 转接视图，仅将授权目录映射到原有容器规范路径；不可继续直接 bind 物理目录后声称隐私生效 |
| 转接文件系统名称 | 使用管理命名空间中的中性来源名，验证挂载 source 和 root 两个字段；部分 bindfs 版本会覆盖手工 `fsname` |
| `/etc/hosts`、`/etc/hostname`、`/etc/resolv.conf` | 检查 Docker 自动创建的文件绑定挂载，不能遗漏 daemon 数据目录泄露；正式方案需同时覆盖 |
| 业务数据事实源 | 不复制成另一份用户工作区再定期覆盖回去；读写、权限、同步监听和授权撤销必须保持既有契约 |

禁止使用输出字符串替换、伪造 `cat`/`df` 命令、只覆盖 `/proc/self/mountinfo` 或隐藏报错作为路径隐私实现。目录转接服务异常时不能静默切回原始物理路径。

这项要求不承诺隐藏磁盘容量、内核、CPU、内存或公网出口地址；FUSE 可能继续报告底层容量。这些属于独立目标，不得在验收记录中混淆。

## 生产切换流程

1. 盘点当前版本、管理器拓扑、Rootless 单元与 socket、UID 映射、存储驱动、镜像摘要、受控网络和用户数据事实源；确认磁盘能同时容纳新旧 daemon 镜像及备份。
2. 带时间戳备份用户文件、数据库及本次涉及的配置、service/drop-in、Compose override。校验备份可读；不要把原始配置或凭据写进公开日志和 Git。
3. 用独立 socket、运行目录和新数据目录准备候选 daemon，不修改旧 daemon 数据目录。先用合成临时文件完成下方验收，失败则不切流。
4. 安排 Shell 维护窗口：停止实际 sandbox manager，核对执行容器和长驻 PTY/MCP 已退出，避免继续向旧环境写入。其他业务是否需要暂停由当前拓扑决定，不默认停整站。
5. 只修改事先列出的 sandbox endpoint、路径映射和管理单元字段；用户 `.env` 和 `config.override.json` 不得被整文件覆盖。涉及 JSON 时先验证、备份，再原子更新，保留数据库、LLM 预设和其他配置段。
6. 重建受控 egress 网络及代理并核对其隔离；启动 manager，再验证应用 Shell、PTY、MCP 和文件同步。检查站点/API 与管理器健康状态。
7. 验收通过后才启用新管理单元的持久启动，记录重启恢复和回滚步骤；保留旧 daemon 数据、配置及匹配镜像，不立即 prune。

## 必须通过的验收

- 在使用正式固定镜像和正式执行器参数的非 root 容器内检查 `/proc/mounts`、`/proc/self/{mountinfo,mounts,mountstats}`、`/proc/thread-self/mountinfo`、数字 PID 和任务目录的对应入口；另外创建子进程验证，不只检查固定 PID。
- 检查根挂载、所有授权目录、嵌套挂载和 Docker 自动文件挂载。探针输出只记录通过/失败和必要脱敏信息，不把现场来源路径、用户名、用户文件名或原始 mountinfo 写入 Git。
- 用合成目录验证读写、重命名、删除、双向修改可见性、缓存一致性、锁及 mmap；核对文件同步监听和配额记账。
- 验证跨用户拒绝、只读授权、符号链接和并发重命名、授权撤销、异常退出、转接层断开后的 fail-closed 行为。
- 分别验证一次性 Shell、PTY、MCP stdio 的启动、取消、超时、退出和资源回收；不能由一次 `docker run` 推断应用入口全部通过。
- 测量典型构建和大量小文件读写成本，核对资源限制生效，并演练单元重启恢复。

## 回滚

停止新 manager 及其执行容器，确认停止后恢复备份的 endpoint、路径映射和管理单元；使用旧 daemon 的原数据目录与原存储驱动恢复。不要让两套 manager 同时承接写请求，不把新驱动的数据目录交给旧驱动打开，也不通过覆盖用户文件来回滚执行环境。最后重新核对用户文件、Shell 和站点健康。
