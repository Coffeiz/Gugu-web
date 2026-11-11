pub mod core_host;
pub mod sandbox;

#[cfg(feature = "desktop")]
pub fn run() {
    use core_host::CoreHost;
    use serde_json::Value;
    use std::sync::Arc;
    use tauri::Manager;
    use tokio::sync::Mutex;

    type SharedCore = Arc<Mutex<CoreHost>>;

    #[tauri::command]
    async fn core_request(
        core: tauri::State<'_, SharedCore>,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        core.lock().await.request(&method, params).await
    }

    #[tauri::command]
    async fn sandbox_status() -> Result<Value, String> {
        tauri::async_runtime::spawn_blocking(sandbox::status)
            .await
            .map_err(|_| "沙箱探测失败".into())
    }

    #[tauri::command]
    async fn sandbox_check(app: tauri::AppHandle) -> Result<Value, String> {
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(|_| "验证目录不可用")?
            .join("sandbox-check");
        tauri::async_runtime::spawn_blocking(move || sandbox::check(&directory))
            .await
            .map_err(|_| "沙箱验证失败")?
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .setup(|app| {
            let database = app.path().app_data_dir()?.join("core.db");
            #[cfg(debug_assertions)]
            let resource_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/core-sidecar");
            #[cfg(not(debug_assertions))]
            let resource_root = app.path().resource_dir()?.join("core-sidecar");
            let (node, entry) = core_host::artifact_paths(&resource_root).map_err(std::io::Error::other)?;
            let host = tauri::async_runtime::block_on(CoreHost::launch(&node, &entry, &database))
                .map_err(std::io::Error::other)?;
            app.manage(Arc::new(Mutex::new(host)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_request,
            sandbox_status,
            sandbox_check
        ])
        .run(tauri::generate_context!())
        .expect("桌面应用启动失败");
}
