use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

const MAX_FRAME: usize = 65_536;

pub fn allowed_method(method: &str) -> bool {
    matches!(
        method,
        "core.info"
            | "projects.list"
            | "projects.create"
            | "projects.rename"
            | "clients.list"
            | "clients.create"
            | "operations.get"
    )
}

// 资源完整性用于发现制品错配/损坏；发布签名由平台安装制品提供。
pub fn artifact_paths(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root = root
        .canonicalize()
        .map_err(|_| "Node 制品不存在，请先装配匹配的桌面运行时")?;
    let bytes = fs::read(root.join("manifest.json")).map_err(|_| "Node 制品清单不可用")?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| "Node 制品清单无效")?;
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let architecture = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "unsupported"
    };
    let version = manifest["nodeVersion"]
        .as_str()
        .ok_or("Node 制品缺少运行时版本")?
        .split('.')
        .map(str::parse::<u16>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Node 运行时版本无效")?;
    if version.len() != 3 || version[0] != 26 || version[1] < 13 {
        return Err("Node 制品不在已验证的 LTS 范围内".into());
    }
    if manifest["platform"] != platform
        || manifest["arch"] != architecture
        || manifest["protocol"] != 2
        || manifest["schema"] != 3
        || manifest["coreVersion"] != "0.2.0"
    {
        return Err("Node 制品与当前宿主、协议或数据版本不匹配".into());
    }
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let entry = "host/dist/runtime/stdio.js";
    if manifest["executable"] != executable || manifest["entry"] != entry {
        return Err("Node 制品入口无效".into());
    }
    let files = manifest["files"]
        .as_object()
        .ok_or("Node 制品缺少文件校验清单")?;
    if !files.contains_key(executable)
        || !files.contains_key(entry)
        || !files.contains_key("host/dist/runtime/worker.js")
    {
        return Err("Node 制品缺少必要运行文件".into());
    }
    for (name, expected) in files {
        let relative = Path::new(name);
        if !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err("Node 制品包含非法资源路径".into());
        }
        let path = root
            .join(relative)
            .canonicalize()
            .map_err(|_| "Node 制品文件缺失")?;
        if !path.starts_with(&root) {
            return Err("Node 制品资源越界".into());
        }
        let mut file = fs::File::open(path).map_err(|_| "Node 制品无法读取")?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 65_536];
        loop {
            let count = file.read(&mut buffer).map_err(|_| "Node 制品无法读取")?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let digest = format!("{:x}", hasher.finalize());
        if expected.as_str() != Some(&digest) {
            return Err("Node 制品完整性验证失败".into());
        }
    }
    Ok((root.join(executable), root.join(entry)))
}

pub struct CoreHost {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
    healthy: bool,
}

async fn read_frame(output: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let mut bounded = output.take((MAX_FRAME + 1) as u64);
    bounded
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| "Core 管道读取失败")?;
    if bytes.len() > MAX_FRAME || !bytes.ends_with(b"\n") {
        return Err("Core 响应超出协议限制或进程已退出".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Core 返回了无效协议".into())
}

impl CoreHost {
    async fn stop_after_protocol_failure(
        &mut self,
        message: &str,
        operation_id: Option<&str>,
    ) -> String {
        self.healthy = false;
        let _ = self.child.kill().await;
        operation_failure(message, operation_id)
    }

    pub async fn launch(node: &Path, entry: &Path, database: &Path) -> Result<Self, String> {
        let mut command = Command::new(node);
        command
            .arg(entry)
            .arg("--database")
            .arg(database)
            .args(["--protocol", "2"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "Core 未能启动，请检查桌面 Node 制品")?;
        let input = child.stdin.take().ok_or("Core 输入管道不可用")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("Core 输出管道不可用")?);
        let ready = tokio::time::timeout(Duration::from_secs(15), read_frame(&mut output))
            .await
            .map_err(|_| "Core 启动超时")??;
        if ready
            .get("error")
            .and_then(|value| value.get("code"))
            .and_then(Value::as_str)
            == Some("schema_upgrade_required")
        {
            return Err("数据库需要显式备份升级，请先运行 Core migrate".into());
        }
        if ready.get("v") != Some(&json!(2))
            || ready.get("event").and_then(Value::as_str) != Some("ready")
            || ready.get("schema").and_then(Value::as_str) != Some("3")
        {
            return Err("Core 数据库无法打开，请检查版本与权限".into());
        }
        Ok(Self {
            child,
            input,
            output,
            sequence: 0,
            healthy: true,
        })
    }

    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if !allowed_method(method) || !params.is_object() {
            return Err("此桌面能力不可用".into());
        }
        if !self.healthy {
            return Err("Core 已停止，请重新启动应用".into());
        }
        self.sequence += 1;
        let mut request = json!({"v":2, "id":self.sequence, "method":method, "params":params});
        let operation_id = if matches!(
            method,
            "projects.create" | "projects.rename" | "clients.create"
        ) {
            let id = uuid::Uuid::new_v4().to_string();
            request["operation_id"] = json!(id);
            Some(id)
        } else {
            None
        };
        let mut frame = serde_json::to_vec(&request).map_err(|_| "桌面请求编码失败")?;
        if frame.len() > MAX_FRAME / 2 {
            return Err("桌面请求超出长度限制".into());
        }
        frame.push(b'\n');
        let operation = async {
            self.input
                .write_all(&frame)
                .await
                .map_err(|_| "Core 管道写入失败".to_string())?;
            self.input
                .flush()
                .await
                .map_err(|_| "Core 管道写入失败".to_string())?;
            read_frame(&mut self.output).await
        };
        let response = match tokio::time::timeout(Duration::from_secs(15), operation).await {
            Ok(Ok(value)) => value,
            _ => {
                return Err(self
                    .stop_after_protocol_failure(
                        "Core 通信中断，请重启应用",
                        operation_id.as_deref(),
                    )
                    .await);
            }
        };
        if response.get("v") != Some(&json!(2)) || response.get("id") != Some(&json!(self.sequence))
        {
            return Err(self
                .stop_after_protocol_failure("Core 协议不匹配，请重启应用", operation_id.as_deref())
                .await);
        }
        match (response.get("result"), response.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) if error.get("code").and_then(Value::as_str).is_some() => {
                Err(match error.get("code").and_then(Value::as_str) {
                    Some("conflict") => "项目已变化，请刷新后重试".into(),
                    Some("not_found") => "数据不存在".into(),
                    Some("invalid_request") => "请求无效，请检查输入".into(),
                    // 存储失败或结果过大不代表写入未提交，保留恢复所需的操作标识。
                    _ => operation_failure("本地数据操作结果未确认", operation_id.as_deref()),
                })
            }
            _ => Err(self
                .stop_after_protocol_failure(
                    "Core 响应结构无效，请重启应用",
                    operation_id.as_deref(),
                )
                .await),
        }
    }
}

fn operation_failure(message: &str, operation_id: Option<&str>) -> String {
    match operation_id {
        Some(id) => format!("{message}。操作标识 {id}。请查询操作收据或读取已保存数据，勿重复提交"),
        None => message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn uncertain_writes_keep_recovery_id_and_invalid_frames_stop_the_host() {
        let root =
            std::env::var("GUGU_DESKTOP_TEST_SIDECAR").expect("测试需显式提供本轮装配的 Node 制品");
        let (node, _) = artifact_paths(Path::new(&root)).expect("制品完整性应通过");
        let directory = tempfile::tempdir().expect("临时目录应可用");
        let responses = [
            ("({v:2,id:request.id+1,result:{}})", true),
            ("({v:2,id:request.id})", true),
            (
                "({v:2,id:request.id,result:{},error:{code:'conflict'}})",
                true,
            ),
            (
                "({v:2,id:request.id,error:{code:'storage_error',message:'合成敏感异常'}})",
                false,
            ),
            (
                "({v:2,id:request.id,error:{code:'result_too_large'}})",
                false,
            ),
        ];
        for (index, (response, fatal)) in responses.iter().enumerate() {
            let entry = directory.path().join(format!("fault-{index}.mjs"));
            let script = r#"
                import { createInterface } from 'node:readline';
                console.log(JSON.stringify({v:2,event:'ready',schema:'3'}));
                for await (const line of createInterface({input:process.stdin})) {
                    const request = JSON.parse(line);
                    const response = request.method === 'core.info'
                        ? {v:2,id:request.id,result:{storage:'sqlite'}} : RESPONSE;
                    console.log(JSON.stringify(response));
                }
            "#
            .replace("RESPONSE", response);
            fs::write(&entry, script).expect("合成协议进程应可写入临时目录");
            let mut host = CoreHost::launch(&node, &entry, &directory.path().join("unused.db"))
                .await
                .expect("合成进程应启动");
            let error = host
                .request("projects.create", json!({"name":"合成计划"}))
                .await
                .expect_err("不确定写入应明确报告错误");
            assert!(
                error
                    .split(|character: char| !character.is_ascii_hexdigit() && character != '-')
                    .any(|word| uuid::Uuid::parse_str(word).is_ok()),
                "错误必须保留可查询的操作 UUID"
            );
            assert!(!error.contains("合成敏感异常"));
            let followup = host.request("core.info", json!({})).await;
            assert_eq!(
                followup.is_err(),
                *fatal,
                "协议损坏后必须停止，合法错误帧仍可继续查询"
            );
            let _ = host.child.kill().await;
            let _ = host.child.wait().await;
        }
    }

    #[test]
    fn refuses_host_execution_and_identity_operations() {
        for method in [
            "shell.run",
            "fs.read",
            "users.login",
            "projects.delete",
            "",
            "../core.info",
        ] {
            assert!(!allowed_method(method));
        }
        assert!(allowed_method("projects.create"));
        assert!(allowed_method("operations.get"));
    }

    #[tokio::test]
    async fn bundled_node_creates_and_reloads_through_private_pipe() {
        let root =
            std::env::var("GUGU_DESKTOP_TEST_SIDECAR").expect("测试需显式提供本轮装配的 Node 制品");
        let (node, entry) = artifact_paths(Path::new(&root)).expect("制品完整性应通过");
        let directory = tempfile::tempdir().expect("临时目录应可用");
        let database = directory.path().join("core.db");
        {
            let mut host = CoreHost::launch(&node, &entry, &database)
                .await
                .expect("Node Core 应启动");
            let result = host
                .request("projects.create", json!({"name":"Rust 管道计划"}))
                .await
                .expect("项目应提交");
            assert_eq!(result["version"], 1);
            assert!(host.request("shell.run", json!({})).await.is_err());
            host.child.kill().await.expect("测试进程应结束");
            let _ = host.child.wait().await;
        }
        let mut restored = CoreHost::launch(&node, &entry, &database)
            .await
            .expect("应重开原数据库");
        let rows = restored
            .request("projects.list", json!({}))
            .await
            .expect("应读取已提交数据");
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["name"], "Rust 管道计划");
        restored.child.kill().await.expect("测试进程应结束");
        let _ = restored.child.wait().await;
    }
}
