# 许可证清单与检查

Gugu-web 使用 Apache-2.0 发布，同时维护前端 npm 依赖和后端 Python 依赖的第三方许可证清单。

## 生成清单

在仓库根目录执行：

```bash
cd frontend
npm run licenses:generate
```

脚本会生成：

- `licenses/frontend.json`：从根 `pnpm-lock.yaml` 的 `frontend` workspace importer 读取前端依赖。
- `licenses/backend.json`：从当前 `backend/.venv` 的 Python 包元数据读取后端依赖。
- `licenses/manifest.json`：跨项目汇总索引。
- `licenses/THIRD-PARTY-NOTICES.md`：可随发行物提供的声明清单。
- `frontend/public/licenses.json`：供前端许可证页面读取的静态数据。

后端清单必须在目标 Python 环境安装完成后生成。它记录的是当前环境实际安装的版本，不应在未安装完整依赖的开发机上作为发布清单使用。

## 合规检查

```bash
cd frontend
npm run licenses:check
```

策略位于 `licenses/policy.json`：

- `blockedPatterns`：直接阻断检查的许可证模式。
- `reviewLicenses`：需要人工确认的许可证或未知许可证。
- `exceptions`：经过记录和批准的具体依赖例外，不得用于掩盖未调查的条目。

当前检查不会自动修改依赖，也不会替代发布前的许可证审查。遇到 `Unknown` 或 GPL 系列许可证时，应先确认依赖是否进入生产运行时，再决定替换、隔离或记录例外。

## NOTICE 的关系

根目录 `NOTICE` 保留项目许可证和手工补充的内嵌资源声明；具体依赖版本清单以生成的 `THIRD-PARTY-NOTICES.md` 为准。修改依赖后重新生成清单，禁止手动编辑生成文件。
