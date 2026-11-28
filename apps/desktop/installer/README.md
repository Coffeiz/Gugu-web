# Desktop 安装器

安装器专属文件集中在这里：

- `windows/cli-install.nsh`：Windows NSIS 安装时注册/清理 CLI 命令。
- `windows/build.ts`：SEA Windows 安装包的 NSIS 模板定制和 electron-builder 装配。

通用 Electron 打包流程仍由 `../scripts/package/package.ts` 调用；平台专属安装逻辑留在对应平台目录。`electron-builder.yml` 引用本目录中的 NSIS include。
