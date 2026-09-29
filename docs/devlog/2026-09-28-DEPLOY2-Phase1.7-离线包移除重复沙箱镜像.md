# PRD-DEPLOY-2 Phase 1.7：离线包移除重复沙箱镜像

## 问题

候选 app 已把经过验证的 sandbox 与 egress runtime 归档和 manifest 封装进镜像，但离线 Compose 发布包仍重复保存这两份镜像，并另外输出外部 runtime manifest，增加下载体积与导入步骤。

## 修复

- 离线 Compose bundle builder 默认只保存 app 和可选 SearXNG 镜像，移除单独 runtime manifest 生成及 Python 运行依赖。
- 发布 workflow 不再拉取、tag 或附带单独的 `gugu-sandbox`、Squid 镜像和外置 bundle manifest。
- 离线 app 首启仍由镜像内 `EmbeddedBundleRuntime` 校验 runtime 归档摘要和 image ID，并只从内置归档导入缺失镜像。
- 补充 mock Docker 端到端 builder 测试，确认实际 inspect/save 集合没有 sandbox 或 Squid。

## 验证

- 定向发布脚本 Node 测试：16 项通过，包含 mock Docker 对 builder 实际 inspect/save 镜像集合的校验。
- builder `bash -n`、三份 Compose 与 release workflow YAML 解析、`git diff --check` 通过。
- 完整 `docker compose config` 仍受本机缺少 Compose 插件限制，Phase 1.6 已记录；未触发 CI。
- 未触发 GitHub CI；按仓库约定由用户决定何时授权触发。
