# Gugu RAG Tantivy Sidecar

这是 Rust 词法检索 sidecar。进程只通过 stdin/stdout 接收 JSONL，不监听网络端口，避免暴露检索服务。

## 构建与运行

```bash
cargo test --manifest-path rust/rag-sidecar/Cargo.toml
cargo build --release --manifest-path rust/rag-sidecar/Cargo.toml
rust/target/release/gugu-rag-sidecar /var/lib/gugu/rag-index

## 运行时制品

业务环境不安装 Rust，也不在启动或请求路径执行 `cargo build`。发布流水线
在 Linux/Docker 中以 `x86_64-unknown-linux-musl` 构建并验收稳定二进制，
再把对应制品放入镜像或项目的 `backend/bin/gugu-rag-sidecar`。Python client
启用 sidecar 且未配置自定义命令时只消费这个固定路径；文件不存在时进入既有
回退，不会尝试自行编译。ARM 支持作为后续独立制品增加。
```

不传目录时使用内存索引；传入目录后使用 Tantivy 持久化目录。Python 侧会先用 `ping` 检查磁盘上的 revision；revision 一致时直接复用，变化时才发送 `replace`。索引目录不得提交 Git，也不得直接放入用户可下载的文件库。

## JSONL 协议

### 健康检查

```json
{"op":"ping"}
```

### 全量投影

`replace` 是首阶段唯一写入接口。Python 侧应在数据库事务成功后发送，并使用数据库 revision；sidecar 只在 commit 和 reader reload 完成后返回成功。

```json
{"op":"replace","revision":"r1","documents":[{"id":"chunk-1","text":"预分词后的文本","owner_user_id":"user-1","source_type":"project","scope_type":"owner","scope_id":"","document_version":"v1"}]}
```

### 查询

查询必须携带 owner 和 revision。sidecar 只返回候选 ID、分数和版本，不返回正文；Python 侧负责权限复核和业务表回查。

```json
{"op":"search","revision":"r1","query":"项目 计划","limit":10,"owner_user_id":"user-1","source_types":["project"],"scope_type":"owner","scope_id":""}
```

revision 不一致、进程退出、超时或协议错误都必须由调用方回退 ILIKE，不能把 sidecar 错误伪装成“无搜索结果”。
