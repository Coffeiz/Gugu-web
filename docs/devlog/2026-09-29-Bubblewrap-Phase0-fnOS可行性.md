# 单容器 Bubblewrap Phase 0：fnOS 默认安全配置未通过

## 结论

Phase 0 默认单容器硬门未通过，不进入 Phase 1。fnOS 宿主机允许非特权 user namespace，但 Docker 默认安全配置下，容器内 Bubblewrap 无法创建 namespace。只添加 `CAP_SYS_ADMIN` 仍未能完成挂载 smoke；关闭 seccomp 的诊断容器也在 mount propagation 处失败。没有验证到满足 PRD 安全要求、且能通过 fnOS 单容器部署入口配置的最小权限组合。

因此不能把“镜像内安装 bwrap”描述为开箱可用；也不能把 `privileged`、`seccomp=unconfined` 或宿主 Docker Socket 当成通过方案。Phase 1 暂停，需先决定是否接受专门的容器安全配置/部署入口，或改变运行架构。

## 环境与现有服务

- fnOS 主机架构：x86_64；系统：Debian 12 (bookworm)；内核：`6.18.18.c1032-trim`。
- Docker Engine：`28.5.2`；Docker 根目录：`/vol1/docker`。
- `docker info` 报告安全选项为 AppArmor、builtin seccomp、cgroup namespace。
- 正在使用的 Gugu 容器均为普通 bridge 网络、`Privileged=false`、没有额外 `CapAdd`、未指定自定义 `SecurityOpt`，AppArmor profile 为 `docker-default`。测试未停止、重建或修改这些容器。
- 宿主机 `user.max_user_namespaces=63085`；`unshare -Ur true` 以登录用户运行成功。`kernel.unprivileged_userns_clone` 文件在该内核上不存在。

## 测试制品

- 测试镜像：`coffeiz/bubblewrap-phase0:20260929-r2`，目标架构 `linux/amd64`。
- 基础镜像：`debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a`。
- Bubblewrap：Debian Trixie `0.12.0-1~deb13u1`；`/usr/bin/bwrap` mode `0755`，`getcap` 无输出（没有 setuid 位或 file capability）。
- 发行包经 Tsinghua Debian mirror 获取，APT Release 签名校验保持开启；构建未下载未校验的运行时脚本。
- smoke 镜像只包含 Bubblewrap、基础 coreutils/passwd 和探针目录；默认用户 UID 10001。smoke 验证 user/PID/IPC/UTS/network namespace、只读 rootfs、临时 tmpfs 和单一路径 bind mount。
- 测试镜像 archive：devserver `~/gugu-web-fnos-single-sandbox-phase0-r2-20260929.tar`，未压缩 Docker archive，大小约 29 MiB，SHA-256：`9bf2c47f48a8144e51ed6a86f78b1111cc8086e65c1b5ea80a5a1e0456d2086b`。
- BuildKit manifest-list digest：`sha256:7910291c329ab91156e83ada4aadba5238f9882d87042cf91aeb93cb28e4cf93`；fnOS 导入后 image config ID：`sha256:5cc96ff3651774f27590ef46e3840e8b99624c241898912aa1f8f80b14152bcb`。

## 实测结果

| fnOS Docker 创建选项 | 结果 | 说明 |
|---|---|---|
| 默认安全配置，镜像默认 UID 10001，bridge 网络 | 失败 | `No permissions to create a new namespace`。容器使用 `--rm`，没有挂载宿主数据或 Docker Socket。 |
| 默认安全配置，覆盖为 UID 0 | 失败 | 同样无法创建 namespace；与 Gugu 单容器当前默认 root 身份一致。 |
| `--security-opt seccomp=unconfined`，无额外 capability，`--network none` | 失败 | 错误推进到 `Failed to make / slave: Permission denied`；只用于诊断，不接受为部署选项。 |
| `--cap-add SYS_ADMIN`，builtin seccomp 与默认 AppArmor，root，`--network none` | 失败 | 同样在 mount propagation 处被拒绝；只添加此 capability 不是充分条件。 |

所有临时 smoke 容器使用 `--rm` 自动移除。内核日志查询没有找到与测试时间对应的 `apparmor DENIED` 或 seccomp audit 记录，因此无法只靠现有审计日志把 mount 拒绝精确归因到 AppArmor 还是其他内核/daemon 策略；测试可确认的是默认组合不工作、单加 `SYS_ADMIN` 也不工作。测试镜像和归档留在 fnOS/devserver 供复核，没有清理 Docker cache、其他镜像或用户数据。

## 阶段判定

- `DEPLOY2-001`：执行完成但验收失败；默认 fnOS 单容器不能运行 Bubblewrap，且尚无经验证的、符合 PRD 的最小安全配置。
- `DEPLOY2-002`：仅确认了候选基础发行版和 Bubblewrap 包版本；批准的生产 Shell rootfs 尚未确定，不能标记完成。
- 不启动 Phase 1。继续实现执行器不能改变宿主容器的 seccomp/AppArmor 策略，容易产出安装成功但实际不可运行的镜像。
- 若要继续，需要先确认可行部署入口是否支持 Bubblewrap 所需的精确 seccomp/AppArmor 策略，且不要求整个 Gugu app 获得 `SYS_ADMIN`、关闭 seccomp/AppArmor 或使用 privileged。若只能依赖这些宽权限，则需重新评审 PRD 和产品安全边界。
