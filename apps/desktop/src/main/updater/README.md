# 桌面客户端更新

## 职责

- `index.ts` 管理检查、下载、进度、失败与安装状态，防止重复操作。
- `electron.ts` 适配 electron-updater、系统代理和下载进度。下载完成后，由主进程弹窗确认安装。
- 桌面主进程使用同一条退出流程关闭网关、提醒和本地宿主，再交给安装器重启。用户可以推迟安装以等待正在执行的任务完成。
- Renderer 通过桌面 preload 的 `guguDesktopUpdate` 读取状态、订阅状态变化和发起操作。它无法提供更新源、下载路径或跳过安装确认。

## 首版分发

GHCR 是更新制品的发布源，HTTPS 静态目录是客户端读取的更新源。每个系统和架构单独使用一个稳定渠道，例如 `stable-darwin-arm64`。GHCR 的 OCI 标签由发布脚本更新，HTTPS 镜像由同步脚本更新。客户端使用 Electron Builder 生成的清单和平台签名校验。

1. 在对应平台设置 `GUGU_DESKTOP_UPDATE_URL` 为 HTTPS 静态站点的更新根地址。macOS 设置 `GUGU_DESKTOP_MAC_SIGN_IDENTITY`，并配置 Apple 公证凭据。Windows 设置 `GUGU_DESKTOP_WIN_PUBLISHER`，并配置签名证书。签名及公证凭据按发布环境的安全配置注入。
2. 从仓库根目录执行 `pnpm --filter gugu-desktop build --mac --arm64`，或使用 `--win --x64`。启用更新源时，产物写到 `apps/desktop/release/<平台>-<架构>`。构建包含应用内 `app-update.yml` 及发布端的 `latest-mac.yml` 或 `latest.yml`。
3. 使用 ORAS 安全登录 GHCR 后发布。现有安装包和同版本的更新制品应保持不可变。
4. 在静态服务的部署环境运行同步。服务需要支持 HEAD 和 HTTP Range。清单文件应配置短缓存或重新验证，版本化文件可以配置长缓存。把同步设为发布流程的部署步骤，同一目标目录的同步任务应串行执行。

```sh
node apps/desktop/scripts/update-feed.mjs publish ghcr.io/<组织>/<包> darwin-arm64 apps/desktop/release/darwin-arm64
node apps/desktop/scripts/update-feed.mjs sync ghcr.io/<组织>/<包> darwin-arm64 <静态站点更新根目录>
```

发布先上传版本制品，之后更新 GHCR 稳定标签。同步先完整下载并校验 SHA-512，再复制版本化文件，最后原子替换客户端清单。旧的安装制品会保留，供差分下载和排查。私有 GHCR 包只需在同步服务器上配置读取凭据。

## 验收

- 用签名的已安装旧版检查更新，验证下载、进度、暂缓安装、重新打开设置后继续安装及重启版本。
- 验证设备 ID、SQLite、窗口状态和本地文件数据仍可读。需要迁移的版本须另行验收数据兼容性。
- 验证断网、制品校验失败和不支持更新的开发包。客户端禁止自动降级，停止分发后使用更高版本修复；应用回退前检查数据兼容性。
