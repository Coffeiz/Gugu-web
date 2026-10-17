# bindfs 透明转接 ACL 实验修复

这是 Linux / FUSE 3 的隔离验证材料，不是应用默认依赖或自动生产安装入口。仅支持不变换 UID、GID、权限的单线程透明转接。生产仍需完成文件同步、并发符号链接、生命周期和 Shell/PTY/MCP 的联合验收。

## 根因与修复

1. bindfs 默认没有协商 `FUSE_CAP_POSIX_ACL`，即使能读取 ACL xattr，内核仍只按 mode 位判断，导致命名用户的授权被拒绝。
2. 仅加 ACL 协商还不够：需同时请求 `FUSE_CAP_DONT_MASK`，避免创建请求被提前应用 umask，裁掉默认 ACL。
3. 在单线程的 create、mkdir、mknod 回调中临时使用调用者 umask，再恢复管理进程原值，让底层文件系统正确区分默认 ACL 继承与普通 umask。
4. 实验模式拒绝除 `-r`、`-f` 外的选项，禁止 UID/GID/权限变换及多线程，避免与本修复未经验证的语义混用。内核缺少 ACL 能力时拒绝启动，不降级。

这不是给用户文件 chmod/chown 放宽权限，也不能通过升级到未修改的 bindfs 1.18.3 自动解决。

## 固定来源

- 上游：[bindfs 1.18.3 源码包](https://bindfs.org/downloads/bindfs-1.18.3.tar.gz)
- 源码包 SHA-256：`178a723d7039bae3ab1cef2fc93e5e8693c4184f52519c0e9a1deee93b838df1`
- 实验库：libfuse 3.14.0。构建时使用匹配的 FUSE 3 开发头文件，不能退回 FUSE 2。
- 补丁：`bindfs-1.18.3-acl.patch`，在该源码包根目录用 `patch -p1` 应用。
- 上游代码采用 GPL-2.0-or-later；分发修改后的程序时保留原许可证并遵循其源码提供要求。不提交实验二进制。

示例构建顺序：先在解压的未修改源码中执行 `./configure --with-fuse3 && make`，保存 baseline 二进制；应用补丁后再构建并另存 patched 二进制。两者应使用同一编译器、源版本和 FUSE 库，避免把版本差异误判成修复效果。只有显式设置 `GUGU_BINDFS_ACL_PASSTHROUGH=1` 才启用实验逻辑。

## 隔离回归

不得挂载真实用户数据，不替换系统 bindfs，不重启现有 Docker。使用 `mktemp -d /tmp/gugu-acl-lab.XXXXXX` 新建目录，在独立 RootlessKit 用户/挂载命名空间中准备：

- `source/`：全新的合成目录。
- `baseline/`：未修改的 bindfs 1.18.3 视图。
- `patched/`：开启实验模式的修正版视图。
- `readonly/`：相同修正版加 `-r` 的视图。

来源先绑定到管理命名空间内的中性别名，再让三个 bindfs 挂载该别名；不把物理实验目录作为文件系统名称。挂载进程单线程运行，不传权限变换选项。命名空间 root 必须映射为宿主非 root UID，实验父目录必须允许合成执行 UID 穿越。

在该子命名空间内执行 `python3 <仓库根目录>/scripts/ops/sandbox-acl/verify.py <实验目录>`。脚本拒绝非临时实验目录和宿主 root 命名空间；每次需全新的合成测试子目录，不覆盖上次用例或真实数据。工具依赖 Python 3、setpriv、setfacl、getfacl。

覆盖行为：

- 原版拒绝、修正版与直接目录相同地允许 ACL 授权写入。
- 未授权用户拒绝、只读用户可读不可写、命名组授权。
- ACL mask 限制与恢复；来源目录外部撤销/恢复授权，撤销时保留原 mask。
- 属主经转接修改 ACL，非属主实际提权请求被拒绝。不要用写回完全相同的 ACL 测试提权，工具可能判断为无需修改。
- 普通 umask、文件属主、文件/目录/FIFO 的默认 ACL 继承与直接目录一致。
- 只读视图不可写。

目录写权限测试必须真正新建文件；仅覆盖已有文件检查的是文件自身权限，不能当作目录创建权限的回归。

完成后停止实验容器和 daemon、卸载各 FUSE 视图并退出命名空间；确认没有实验进程、挂载或打开文件，再按实际已核对的临时路径清理。不要对用户数据、现有 Docker 数据目录或宽泛临时目录运行递归删除。

## 已验证与剩余边界

devserver 的独立命名空间对照和独立 Rootless Docker 容器验证通过；无生产配置变更。该结果只消除了已复现的 ACL 阻断，不代表完整路径隐私生产方案已验收，也不支持任意 bindfs 变换或其他版本组合。

参考：[上游 ACL 问题](https://github.com/mpartel/bindfs/issues/91)、[FUSE 3.14 能力协议](https://github.com/libfuse/libfuse/blob/fuse-3.14.0/include/fuse_common.h)。
