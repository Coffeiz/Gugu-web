# Desktop 脚本目录

桌面脚本按生命周期和用途归类，`package.json` 中的 npm 命令保持稳定，内部入口使用对应目录：

- `build/`：Main/Preload、Core sidecar、图标等构建与资源装配脚本。
- `dev/`：开发启动、PTY 准备和浏览器预览。
- `package/`：桌面应用制品装配及 electron-builder 调用。
- `verify/`：smoke、probe 和临时环境验证脚本。
- `update/`：更新源目录的清单生成与同步。

脚本的相对路径以仓库根目录或桌面应用目录为基准时，应显式计算路径，避免依赖从哪个目录启动。根目录 `scripts/` 下的仓库级维护工具不属于本目录。
