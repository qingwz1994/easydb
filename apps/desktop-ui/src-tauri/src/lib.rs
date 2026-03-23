use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// 全局持有内核子进程，应用退出时自动杀掉
static KERNEL_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// 查找 Java 可执行文件路径
/// 优先使用内嵌的 JRE，其次尝试系统 java
fn find_java(resource_dir: &std::path::Path) -> Option<PathBuf> {
    let java_name = if cfg!(target_os = "windows") { "java.exe" } else { "java" };

    // 1. 内嵌 JRE：resources/jre/bin/java
    let embedded = resource_dir.join("jre").join("bin").join(java_name);
    log::info!("Checking embedded JRE at: {:?} (exists: {})", embedded, embedded.exists());
    if embedded.exists() {
        return Some(embedded);
    }

    // 2. 可能在 resources/ 子目录下：resources/resources/jre/bin/java
    let nested = resource_dir.join("resources").join("jre").join("bin").join(java_name);
    log::info!("Checking nested JRE at: {:?} (exists: {})", nested, nested.exists());
    if nested.exists() {
        return Some(nested);
    }

    // 3. 系统 java（开发模式 fallback）
    log::info!("Embedded JRE not found, trying system java...");
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
    // 可能的路径
    let paths = [
        resource_dir.join("easydb-kernel.jar"),
        resource_dir.join("resources").join("easydb-kernel.jar"),
    ];
    for p in &paths {
        log::info!("Checking kernel JAR at: {:?} (exists: {})", p, p.exists());
        if p.exists() {
            return Some(p.clone());
        }
    }
    None
}

/// 检查内核是否已启动（通过 TCP 端口连接）
fn wait_for_kernel_ready(port: u16, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(
            &addr.parse().unwrap(),
            Duration::from_secs(1),
        ).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

/// 关闭内核进程
fn shutdown_kernel() {
    if let Ok(mut guard) = KERNEL_PROCESS.lock() {
        if let Some(ref mut child) = *guard {
            log::info!("Shutting down kernel process...");
            let _ = child.kill();
            let _ = child.wait();
            log::info!("Kernel process terminated.");
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
            log::info!("Resource dir: {:?}", resource_dir);

            // 收集 resource_dir 下的内容
            let mut debug_info = format!("Resource dir:\n{}\n\nContents:\n", resource_dir.display());
            if let Ok(entries) = std::fs::read_dir(&resource_dir) {
                for entry in entries.flatten() {
                    let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    debug_info.push_str(&format!("  {} {}\n",
                        if is_dir { "[DIR]" } else { "[FILE]" },
                        entry.file_name().to_string_lossy()));
                }
            } else {
                debug_info.push_str("  (cannot read directory)\n");
            }

            // 检查 resources/ 子目录
            let sub = resource_dir.join("resources");
            if sub.exists() {
                debug_info.push_str(&format!("\nresources/ subdir:\n"));
                if let Ok(entries) = std::fs::read_dir(&sub) {
                    for entry in entries.flatten() {
                        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                        debug_info.push_str(&format!("  {} {}\n",
                            if is_dir { "[DIR]" } else { "[FILE]" },
                            entry.file_name().to_string_lossy()));
                    }
                }
            }

            // 临时调试弹窗（确认路径后删除）
            rfd::MessageDialog::new()
                .set_title("EasyDB Debug - Resource Paths")
                .set_description(&debug_info)
                .set_level(rfd::MessageLevel::Info)
                .show();

            // 查找 Kernel JAR
            let jar_path = match find_kernel_jar(&resource_dir) {
                Some(p) => p,
                None => {
                    log::warn!("Kernel JAR not found, assuming dev mode");
                    return Ok(());
                }
            };

            log::info!("Starting kernel from: {:?}", jar_path);

            // 查找 Java 可执行文件
            let java_path = match find_java(&resource_dir) {
                Some(p) => p,
                None => {
                    log::error!("No Java runtime found!");
                    rfd::MessageDialog::new()
                        .set_title("EasyDB - 启动错误")
                        .set_description(
                            "未找到 Java 运行环境，请联系技术支持。"
                        )
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                    return Ok(());
                }
            };

            log::info!("Using Java: {:?}", java_path);

            // 启动内核进程
            match Command::new(&java_path)
                .arg("-jar")
                .arg(&jar_path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    log::info!("Kernel process started, PID: {}", child.id());
                    *KERNEL_PROCESS.lock().unwrap() = Some(child);

                    // 等待内核就绪（最多 30 秒）
                    log::info!("Waiting for kernel to be ready on port 18080...");
                    if wait_for_kernel_ready(18080, Duration::from_secs(30)) {
                        log::info!("Kernel is ready!");
                    } else {
                        log::warn!("Kernel health check timed out after 30s");
                    }
                }
                Err(e) => {
                    log::error!("Failed to start kernel: {:?}", e);
                    rfd::MessageDialog::new()
                        .set_title("EasyDB - 启动错误")
                        .set_description(&format!(
                            "内核启动失败：{}\n\n请联系技术支持。", e
                        ))
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                }
            }

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
