use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 全局持有内核子进程，应用退出时自动杀掉
static KERNEL_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// Windows 路径规范化：去掉 UNC 前缀 \\?\
/// Java 无法处理 \\?\ 开头的路径
fn normalize_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("\\\\?\\") {
        PathBuf::from(&s[4..])
    } else {
        path.to_path_buf()
    }
}

/// 查找 Java 可执行文件路径
fn find_java(resource_dir: &Path) -> Option<PathBuf> {
    let java_name = if cfg!(target_os = "windows") { "java.exe" } else { "java" };

    // 1. resources/jre/bin/java（打包后实际路径）
    let nested = resource_dir.join("resources").join("jre").join("bin").join(java_name);
    if nested.exists() { return Some(normalize_path(&nested)); }

    // 2. jre/bin/java
    let direct = resource_dir.join("jre").join("bin").join(java_name);
    if direct.exists() { return Some(normalize_path(&direct)); }

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
fn find_kernel_jar(resource_dir: &Path) -> Option<PathBuf> {
    let paths = [
        resource_dir.join("resources").join("easydb-kernel.jar"),
        resource_dir.join("easydb-kernel.jar"),
    ];
    for p in &paths {
        if p.exists() { return Some(normalize_path(p)); }
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
                let jar_path = match find_kernel_jar(&resource_dir) {
                    Some(p) => p,
                    None => return, // dev mode
                };

                let java_path = match find_java(&resource_dir) {
                    Some(p) => p,
                    None => {
                        eprintln!("ERROR: Java not found in {:?}", resource_dir);
                        return;
                    }
                };

                // 内核日志写到 resource_dir 旁边，方便诊断
                let log_dir = normalize_path(&resource_dir);
                let log_path = log_dir.join("kernel.log");
                let (stdout_cfg, stderr_cfg): (Stdio, Stdio) = match File::create(&log_path) {
                    Ok(f) => {
                        let f2 = f.try_clone().unwrap_or_else(|_| File::create(&log_path).unwrap());
                        (Stdio::from(f), Stdio::from(f2))
                    }
                    Err(_) => (Stdio::null(), Stdio::null()),
                };

                eprintln!("Starting kernel: java={:?} jar={:?} log={:?}", java_path, jar_path, log_path);

                let mut cmd = Command::new(&java_path);
                cmd.arg("-jar")
                    .arg(&jar_path)
                    .stdout(stdout_cfg)
                    .stderr(stderr_cfg);

                // Windows: 隐藏控制台窗口
                #[cfg(target_os = "windows")]
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

                match cmd.spawn()
                {
                    Ok(child) => {
                        eprintln!("Kernel started, PID: {}", child.id());
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
