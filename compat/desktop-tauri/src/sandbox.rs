use mxc_sdk::v1::{self, ContainerRequest, Containment, FilesystemPolicy, WaitResult};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub fn status() -> Value {
    let support = v1::platform_support();
    json!({ "supported": support.is_supported, "methods": support.available_methods, "checkAvailable": cfg!(windows) && support.is_supported })
}

#[cfg(windows)]
fn validate_host(request: &ContainerRequest) -> Result<(), String> {
    let probe = v1::probe(Some(request)).map_err(|_| "当前主机无法提供所需隔离")?;
    if probe.error.is_some()
        || probe.tier != Some("base-container")
        || probe.needs_dacl_augmentation != Some(false)
    {
        return Err("当前主机未满足已验证的隔离条件，应用不会自动更改系统权限".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn validate_host(_: &ContainerRequest) -> Result<(), String> {
    Err("此原生执行验证当前仅在 Windows 开放".into())
}

// 只执行宿主固定的验证任务，不开放来自渲染进程的任意命令或路径。
pub fn check(directory: &Path) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("此原生执行验证当前仅在 Windows 开放".into());
    }
    let system_root = std::env::var("SystemRoot").map_err(|_| "系统环境不可用")?;
    let interpreter = Path::new(&system_root).join("System32").join("cmd.exe");
    let input = directory.join("input");
    let output = directory.join("output");
    fs::create_dir_all(&input)
        .and_then(|_| fs::create_dir_all(&output))
        .map_err(|_| "无法创建验证目录")?;
    fs::write(input.join("input.txt"), b"gugu-sandbox-check").map_err(|_| "无法准备验证数据")?;
    let request = ContainerRequest {
        containment: Containment::Process,
        filesystem: Some(FilesystemPolicy {
            readonly_paths: vec![
                input.to_string_lossy().into(),
                interpreter.to_string_lossy().into(),
            ],
            readwrite_paths: vec![output.to_string_lossy().into()],
            ..Default::default()
        }),
        working_directory: Some(input.to_string_lossy().into()),
        environment: Some(vec![
            ("SystemRoot".into(), system_root),
            ("LOCALAPPDATA".into(), output.to_string_lossy().into()),
            ("TEMP".into(), output.to_string_lossy().into()),
            ("TMP".into(), output.to_string_lossy().into()),
        ]),
        timeout_ms: Some(10_000),
        ..ContainerRequest::new(format!(
            "\"{}\" /d /c type input.txt > \"{}\"",
            interpreter.display(),
            output.join("result.txt").display()
        ))
    };
    validate_host(&request)?;
    let result =
        v1::run(request, Default::default()).map_err(|_| "原生沙箱执行失败，未回退到宿主执行")?;
    let exited = matches!(result.outcome, WaitResult::Exited(0));
    let verified = exited
        && fs::read(output.join("result.txt"))
            .map(|bytes| bytes == b"gugu-sandbox-check")
            .unwrap_or(false);
    Ok(json!({"passed": verified, "timedOut": matches!(result.outcome, WaitResult::TimedOut)}))
}
