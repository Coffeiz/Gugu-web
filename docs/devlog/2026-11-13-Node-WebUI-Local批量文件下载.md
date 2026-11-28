# Node WebUI Local 批量文件下载

## 范围

接入认证后的 `POST /api/v1/files/batch-download`。PostgreSQL adapter 只读取认证 owner 的有效文件和文件夹；文件夹递归查询限制在 owner 范围，Local 正文通过受路径约束的文件打开器读取，生成保留目录层级的 ZIP。响应维持 `application/zip` 与固定附件名；无选择返回 400，选择中没有可用文件返回 404。实现面向 2.0 Local 存储，不接入 OSS。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- Node 文件域 `tests/files/*.test.ts`：**65/65 通过，0 跳过**；包含隔离 PostgreSQL 与临时 Local 文件目录，检查 owner 隔离、目录层级、正文和错误状态。
- Python 压缩/解压 API 与服务基线：**33 项通过**，串行运行。
- 测试均在 devserver 原生环境执行；未使用 Docker。

## 边界

只迁移批量下载接口。压缩文件创建和解压仍待迁移；尚未在真实用户文件目录验收，未触发 CI，未提交代码。
