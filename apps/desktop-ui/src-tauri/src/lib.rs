use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// 全局持有内核子进程，应用退出时自动杀掉
static KERNEL_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// 查找 Java 可执行文件路径
fn find_java(resource_dir: &std::path::Path) -> Option<PathBuf> {
    let java_name = if cfg!(target_os = "windows") { "java.exe" } else { "java" };

    // 1. resources/jre/bin/java
    let nested = resource_dir.join("resources").join("jre").join("bin").join(java_name);
    if nested.exists() { return Some(nested); }

    // 2. jre/bin/java
    let direct = resource_dir.join("jre").join("bin").join(java_name);
    if direct.exists() { return Some(direct); }

    // 3. 系统 java（开发模式 fallback）
    if Command::new("java").arg("-version")
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().is_ok()
    {
        return Some(PathBuf::from("java"));
    }

    None
}

/// 查找 Kernel JAR 路径
fn find_kernel_jar(resource_dir: &std::path::Path) -> Option<PathBuf> {
    let paths = [
        resource_dir.join("resources").join("easydb-kernel.jar"),
        resource_dir.join("easydb-kernel.jar"),
    ];
    for p in &paths {
        if p.exists() { return Some(p.clone()); }
    }
    None
}

/// 关闭内核进程
fn shutdown_kernel() {
    if let Ok(mut guard) = KERNEL_PROCESS.lock() {
        if let Some(ref mut child) = *guard {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let resource_dir = app.path().resource_dir()
                .expect("failed to get resource dir");

            // 在后台线程启动内核（不阻塞 UI）
            std::thread::spawn(move || {
                // 查找 Kernel JAR
                let jar_path = match find_kernel_jar(&resource_dir) {
                    Some(p) => p,
                    None => return, // dev mode
                };

                // 查找 Java
                let java_path = match find_java(&resource_dir) {
                    Some(p) => p,
                    None => {
                        eprintln!("ERROR: Java not found!");
                        return;
                    }
                };

                // 启动内核进程
                match Command::new(&java_path)
                    .arg("-jar")
                    .arg(&jar_path)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(child) => {
                        *KERNEL_PROCESS.lock().unwrap() = Some(child);
                    }
                    Err(e) => {
                        eprintln!("Failed to start kernel: {:?}", e);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            shutdown_kernel();
        }
    });
}
