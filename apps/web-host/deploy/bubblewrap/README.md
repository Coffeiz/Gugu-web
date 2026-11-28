# Web Host 的 Linux 沙盒

Linux Web Host 使用 Bubblewrap、独立的只读运行根和 systemd 用户 scope。Agent Shell、网页单次命令和交互式终端共享目录授权。沙盒默认断网。Windows 桌面继续使用 MXC。

部署要求包括 cgroup v2、可用的 systemd 用户服务，以及支持 `--bind-fd`、`--ro-bind-fd`、`--disable-userns` 的 Bubblewrap。Web Host 应以专用非 root 账号运行。确保该账号对应的 systemd 用户服务在 Web Host 启动时可用，并能为 scope 设置 CPU、内存、交换空间及进程数上限。容器内运行时也要实际满足这些前置条件。

在原生 Linux 部署机上安装支持 `--bind-fd`、`--ro-bind-fd`、`--disable-userns` 的 `/usr/bin/bwrap`，以及 `debootstrap`、`debian-archive-keyring`、C 编译器和 C 库头文件。管理员从检出的仓库运行一次安装器：

```sh
sudo sh apps/web-host/deploy/bubblewrap/install.sh
```

安装器用签名校验后的 Debian 软件包构建独立运行根，并编译安装 PTY 启动器。新运行根构建成功后才放入标准目录。重复执行会保留已识别的运行根。替换旧运行根前先停止使用它的服务。首次启动前创建业务所需的用户工作区及个人、项目文件目录。

在开启 AppArmor 非特权用户命名空间限制的系统上，可使用发行版的 Bubblewrap 配置，或由管理员审核并安装本目录的可执行文件专用配置。先确认 `/usr/bin/bwrap` 没有绑定另一份 AppArmor 配置。确认后从仓库根目录安装并加载配置，保留系统全局限制。

```sh
sudo install -m 0644 apps/web-host/deploy/bubblewrap/apparmor.profile /etc/apparmor.d/gugu-bubblewrap
sudo apparmor_parser -r /etc/apparmor.d/gugu-bubblewrap
```

Linux Web Host 默认探测 `/var/lib/gugu-sandbox/rootfs`，默认断网，终端策略默认为「自动」。自定义根目录可用 `GUGU_BUBBLEWRAP_ROOTFS` 覆盖，显式留空可关闭这条运行路径。旧部署已保存的 `egress` 策略需要改成 `none`。就绪检查会在临时工作区实际运行命令和 PTY。

Agent 的 `scope=system` 默认关闭。只有管理员设置 `AGENT__SHELL_SYSTEM_ENABLED=true`、当前用户开启对应偏好，并确认本次命令后，才会以 Web Host 服务账号权限在服务所在环境运行。这项权限只适合有权访问该服务账号可读数据的受信任用户。用户交互式终端继续运行在 Bubblewrap 中。

在该服务账号下验证真实 Linux 后端。测试只会使用临时工作目录。

```sh
corepack pnpm --filter @gugu/sandbox build
GUGU_BUBBLEWRAP_TEST_ROOTFS=/var/lib/gugu-sandbox/rootfs \
  node --test packages/sandbox/tests/linux/isolated-execution.test.mjs
```
