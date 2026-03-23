use std::net::TcpStream;
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// 全局持有内核子进程，应用退出时自动杀掉
static KERNEL_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

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
            let jar_path = resource_dir.join("easydb-kernel.jar");

            if jar_path.exists() {
                log::info!("Starting kernel from: {:?}", jar_path);

                // 启动内核进程
                match Command::new("java")
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
                        if e.kind() == std::io::ErrorKind::NotFound {
                            rfd::MessageDialog::new()
                                .set_title("EasyDB - 启动错误")
                                .set_description(
                                    "未找到 Java 运行环境。\n\n\
                                    请安装 JDK 21 或更高版本：\n\
                                    https://adoptium.net/\n\n\
                                    安装后重启 EasyDB。"
                                )
                                .set_level(rfd::MessageLevel::Error)
                                .show();
                        }
                    }
                }
            } else {
                log::warn!("Kernel JAR not found at {:?}, assuming dev mode", jar_path);
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
