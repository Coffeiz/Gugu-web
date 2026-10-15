# PRD-MERMAID-1 Phase 0：运行时验证

## 目标与部署基线

验证 Mermaid PNG 服务端渲染能否复用现有运行时，不新增常驻服务，并明确 IM 输出可用的隔离边界。非集成对照是 devserver 上独立部署的前后端；后端服务由 systemd 管理，不使用 Compose。另一目标是用户使用的集成单容器镜像。

## 验证结果

| 项目 | 独立部署主机 | 集成镜像 |
| --- | --- | --- |
| Node | v22.23.3 | v20.19.2 |
| Python 超时终止 Node 子进程 | 通过，约 255 ms 回收 250 ms 超时子进程 | 通过，约 258 ms 回收 250 ms 超时子进程 |
| Mermaid 静态 PNG | 通过 Mermaid 11.17.2 + Resvg 探针生成有效 PNG；导入约 2.3 秒，单图渲染/编码约 538 ms，RSS 约 226 MiB | 通过 Mermaid 11.17.2 + Resvg 探针生成有效 PNG |
| 网络边界 | 主机有 libseccomp，可在子进程安装 syscall 过滤 | 默认 bridge 网络下 seccomp 使 Node socket 请求返回 `EPERM`，渲染仍成功 |

集成镜像中 flow、sequence、class 三类图共用同一 Node 进程完成渲染与 PNG 编码，批次约 1.5 秒，峰值 RSS 约 162 MiB（增量约 42 MiB）。探针施加 1 CPU、512 MiB 内存和 64 个进程的容器上限。临时 Node 渲染依赖树约 197 MiB；未包含浏览器或 Chromium。前端当前锁定解析版本为 Mermaid 11.17.2。

`isomorphic-mermaid` 探针本身可以运行，但其 package engines 声明 Node >=22，与集成镜像 Node 20 不兼容，因此不直接作为运行时依赖。服务端实现应以 Mermaid 11.17.2 为同一锁定版本，使用项目自有的最小 Node DOM 启动层和 Resvg，并显式验证 Node 20 与 Node 22 两端。

## 决策与未完成边界

- 不使用 Headless Chromium，不新增常驻渲染服务，不改变部署拓扑。
- 后端以短生命周期 Node 子进程执行渲染；Python 调用方负责超时、并发 semaphore 和进程组终止，Node 子进程通过 seccomp 禁网。
- Node 侧必须在栅格化前限制 SVG 输入和目标像素，在 PNG 编码后限制字节数；并发、像素、字节硬限制需随 Phase 3 worker 实现并测试，本次探针不声称这些产品边界已经落地。
- 197 MiB 是当前临时依赖树体积，属于镜像增量风险；Phase 3 锁定生产依赖时应检查可裁剪的构建/映射文件，并复核最终镜像增量，不得通过移除运行所需 Mermaid chunk 进行体积优化。

## 验证范围

所有探针均使用临时依赖/进程，不写业务配置、数据库或用户文件；没有重启、修改或停止 devserver 上的既有服务。完整过程及资源数据仅记录技术结果，不保留用户内容、渲染图源码或 PNG 文件。
