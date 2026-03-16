use std::process::Command;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 启动 Kotlin 内核 JAR
            let resource_dir = app.path().resource_dir()
                .expect("failed to get resource dir");
            let jar_path = resource_dir.join("easydb-kernel.jar");

            if jar_path.exists() {
                log::info!("Starting kernel from: {:?}", jar_path);
                std::thread::spawn(move || {
                    let status = Command::new("java")
                        .arg("-jar")
                        .arg(&jar_path)
                        .status();
                    match status {
                        Ok(s) => log::info!("Kernel exited with: {:?}", s),
                        Err(e) => log::error!("Failed to start kernel: {:?}", e),
                    }
                });
            } else {
                log::warn!("Kernel JAR not found at {:?}, assuming dev mode (kernel started separately)", jar_path);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
