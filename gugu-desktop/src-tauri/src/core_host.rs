use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
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
    )
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
    pub async fn launch(python: &Path, database: &Path) -> Result<Self, String> {
        let mut command = Command::new(python);
        command
            .args(["-m", "gugu_desktop_host", "--database"])
            .arg(database)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env("PYTHONUTF8", "1");
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "Core 未能启动，请检查桌面 Python 宿主安装")?;
        let input = child.stdin.take().ok_or("Core 输入管道不可用")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("Core 输出管道不可用")?);
        let ready = tokio::time::timeout(Duration::from_secs(15), read_frame(&mut output))
            .await
            .map_err(|_| "Core 启动超时")??;
        if ready.get("v") != Some(&json!(1))
            || ready.get("event").and_then(Value::as_str) != Some("ready")
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
        let mut frame = serde_json::to_vec(
            &json!({"v":1, "id":self.sequence, "method":method, "params":params}),
        )
        .map_err(|_| "桌面请求编码失败")?;
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
                self.healthy = false;
                let _ = self.child.kill().await;
                return Err("Core 通信中断，请重启后读取已保存数据".into());
            }
        };
        if response.get("v") != Some(&json!(1)) || response.get("id") != Some(&json!(self.sequence))
        {
            self.healthy = false;
            let _ = self.child.kill().await;
            return Err("Core 协议不匹配".into());
        }
        if let Some(error) = response.get("error") {
            return Err(match error.get("code").and_then(Value::as_str) {
                Some("conflict") => "项目已变化，请刷新后重试",
                Some("not_found") => "数据不存在",
                Some("invalid_request") => "请求无效，请检查输入",
                _ => "本地数据操作失败",
            }
            .into());
        }
        response
            .get("result")
            .cloned()
            .ok_or("Core 响应缺少结果".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
