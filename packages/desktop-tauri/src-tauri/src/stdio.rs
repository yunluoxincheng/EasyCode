//! 独立 stdin/stdout 的底层进程能力；不解析 MCP 或业务数据。
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager};

struct Entry {
    pid: u32,
    input: Mutex<Option<ChildStdin>>,
    closing: Mutex<()>,
    closed: AtomicBool,
    exited: (Mutex<bool>, Condvar),
    output: (Mutex<(u64, u64)>, Condvar), // sent / acknowledged，限制跨 WebView 队列。
}

#[derive(Default)]
pub struct StdioMap(Mutex<HashMap<String, Arc<Entry>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Frame { Out { data: String, seq: u64 }, Exit }

const BASE_ENV: &[&str] = &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "APPDATA",
    "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP",
    "USERDOMAIN", "USERNAME", "USERPROFILE"];

fn executable(options: &Launch) -> PathBuf {
    let original = PathBuf::from(&options.command);
    #[cfg(windows)]
    {
        let search = options.env.as_ref().and_then(|env| env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")))
            .map(|(_, value)| value.clone()).or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
        let bases = if original.is_absolute() { vec![original.clone()] }
            else if original.components().count() > 1 {
                vec![Path::new(options.cwd.as_deref().unwrap_or(".")).join(&original)]
            } else { std::env::split_paths(&search).map(|dir| dir.join(&original)).collect() };
        for base in bases {
            for ext in if base.extension().is_some() { vec![""] } else { vec![".exe", ".com", ".cmd", ".bat"] } {
                let candidate = PathBuf::from(format!("{}{}", base.to_string_lossy(), ext));
                if candidate.is_file() { return candidate; }
            }
        }
    }
    original
}

#[cfg(unix)]
fn group_alive(pid: u32) -> Result<bool, String> {
    extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
    if unsafe { kill(-(pid as i32), 0) } == 0 { return Ok(true); }
    if std::io::Error::last_os_error().raw_os_error() == Some(3) { Ok(false) }
    else { Err("无法确认 Stdio 进程组状态".into()) }
}

fn close_entry(entry: &Entry) -> Result<(), String> {
    let _guard = entry.closing.lock().map_err(|_| "Stdio 清理锁失败")?;
    if entry.closed.load(Ordering::SeqCst) { return Ok(()); }
    #[cfg(windows)]
    if !*entry.exited.0.lock().map_err(|_| "Stdio 状态锁失败")? {
        crate::kill_process(entry.pid).map_err(|_| "Stdio 进程树终止失败")?;
    }
    #[cfg(unix)]
    {
        extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
        if group_alive(entry.pid)? && unsafe { kill(-(entry.pid as i32), 9) } != 0 &&
            std::io::Error::last_os_error().raw_os_error() != Some(3) {
            return Err("Stdio 进程组终止失败".into());
        }
    }
    // 先终止进程，避免等待被阻塞的 stdin 写入锁造成退出死锁。
    let exited = entry.exited.0.lock().map_err(|_| "Stdio 状态锁失败")?;
    let (exited, _) = entry.exited.1.wait_timeout_while(exited, Duration::from_secs(3), |v| !*v)
        .map_err(|_| "等待 Stdio 退出失败")?;
    if !*exited { return Err("Stdio 退出尚未完成，可重试".into()); }
    drop(exited);
    #[cfg(unix)]
    {
        for _ in 0..50 {
            if !group_alive(entry.pid)? { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        if group_alive(entry.pid)? { return Err("Stdio 进程组尚未消亡，可重试".into()); }
    }
    if let Ok(mut input) = entry.input.try_lock() { input.take(); }
    let _output = entry.output.0.lock().map_err(|_| "Stdio 输出锁失败")?;
    entry.closed.store(true, Ordering::SeqCst);
    entry.output.1.notify_all();
    Ok(())
}

#[tauri::command]
pub async fn stdio_open(app: AppHandle, id: String, options: Launch, on_event: Channel<Frame>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if id.len() > 64 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') ||
            options.command.trim().is_empty() || options.command.len() > 2048 || options.args.len() > 128 ||
            options.env.as_ref().map_or(0, |env| env.len()) > 64 {
            return Err("Stdio 启动配置无效".into());
        }
        let state = app.state::<StdioMap>();
        let mut registry = state.0.lock().map_err(|_| "Stdio 注册锁失败")?;
        if registry.len() >= 16 || registry.contains_key(&id) { return Err("Stdio 进程已存在或数量已满".into()); }
        let mut command = Command::new(executable(&options));
        command.args(&options.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).env_clear();
        for (name, value) in std::env::vars_os() {
            if BASE_ENV.contains(&name.to_string_lossy().to_uppercase().as_str()) { command.env(name, value); }
        }
        if let Some(env) = &options.env { command.envs(env); }
        if let Some(cwd) = &options.cwd { command.current_dir(cwd); }
        crate::hide_window(&mut command);
        #[cfg(unix)]
        { use std::os::unix::process::CommandExt; command.process_group(0); }
        let mut child = command.spawn().map_err(|_| "Stdio 启动失败，请检查命令与工作目录")?;
        let entry = Arc::new(Entry { pid: child.id(), input: Mutex::new(child.stdin.take()),
            closing: Mutex::new(()), closed: AtomicBool::new(false), exited: (Mutex::new(false), Condvar::new()),
            output: (Mutex::new((0, 0)), Condvar::new()) });
        registry.insert(id.clone(), entry.clone());
        drop(registry);
        let mut stdout = child.stdout.take().ok_or("Stdio stdout 不可用")?;
        let mut stderr = child.stderr.take().ok_or("Stdio stderr 不可用")?;
        let output = on_event.clone();
        let reader_entry = entry.clone();
        let reader = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(size) = stdout.read(&mut buffer) {
                if size == 0 { break; }
                let queued = reader_entry.output.0.lock().unwrap();
                let (mut queued, _) = reader_entry.output.1.wait_timeout_while(queued, Duration::from_secs(10),
                    |(sent, ack)| sent.saturating_sub(*ack) >= 8 && !reader_entry.closed.load(Ordering::SeqCst)).unwrap();
                if reader_entry.closed.load(Ordering::SeqCst) { break; }
                if queued.0.saturating_sub(queued.1) >= 8 {
                    drop(queued); let _ = close_entry(&reader_entry); break;
                }
                queued.0 += 1;
                let seq = queued.0;
                drop(queued);
                if output.send(Frame::Out { seq, data: base64::engine::general_purpose::STANDARD.encode(&buffer[..size]) }).is_err() {
                    let _ = close_entry(&reader_entry);
                    break;
                }
            }
        });
        // stderr 独立排空，不将可能含凭据的服务日志发送到 WebView。
        let errors = std::thread::spawn(move || { let _ = std::io::copy(&mut stderr, &mut std::io::sink()); });
        let monitor_app = app.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            if let Ok(mut exited) = entry.exited.0.lock() { *exited = true; entry.exited.1.notify_all(); }
            let cleaned = close_entry(&entry).is_ok();
            let _ = reader.join(); let _ = errors.join();
            if cleaned {
                if let Ok(mut registry) = monitor_app.state::<StdioMap>().0.lock() { registry.remove(&id); }
            }
            let _ = on_event.send(Frame::Exit);
        });
        Ok(())
    }).await.map_err(|_| "Stdio 启动任务失败".to_string())?
}

#[tauri::command]
pub fn stdio_ack(app: AppHandle, id: String, seq: u64) -> Result<(), String> {
    let entry = app.state::<StdioMap>().0.lock().map_err(|_| "Stdio 注册锁失败")?.get(&id).cloned();
    if let Some(entry) = entry {
        let mut output = entry.output.0.lock().map_err(|_| "Stdio 输出锁失败")?;
        if seq > output.0 { return Err("Stdio 确认序号无效".into()); }
        output.1 = output.1.max(seq);
        entry.output.1.notify_all();
    }
    Ok(())
}

#[tauri::command]
pub async fn stdio_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    if data.len() > 1_048_576 { return Err("Stdio 消息超限".into()); }
    let entry = app.state::<StdioMap>().0.lock().map_err(|_| "Stdio 注册锁失败")?.get(&id).cloned().ok_or("Stdio 连接不存在")?;
    tauri::async_runtime::spawn_blocking(move || {
        if entry.closed.load(Ordering::SeqCst) { return Err("Stdio 连接已关闭".into()); }
        let mut input = entry.input.lock().map_err(|_| "Stdio 输入锁失败")?;
        input.as_mut().ok_or("Stdio 输入已关闭")?.write_all(data.as_bytes()).map_err(|_| "Stdio 写入失败".to_string())
    }).await.map_err(|_| "Stdio 写入任务失败".to_string())?
}

#[tauri::command]
pub async fn stdio_close(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = app.state::<StdioMap>().0.lock().map_err(|_| "Stdio 注册锁失败")?.get(&id).cloned();
        if let Some(entry) = entry {
            close_entry(&entry)?;
            app.state::<StdioMap>().0.lock().map_err(|_| "Stdio 注册锁失败")?.remove(&id);
        }
        Ok(())
    }).await.map_err(|_| "Stdio 清理任务失败".to_string())?
}

pub fn cleanup(app: &AppHandle) {
    let entries: Vec<_> = app.state::<StdioMap>().0.lock().map(|m| m.values().cloned().collect()).unwrap_or_default();
    let workers: Vec<_> = entries.into_iter().map(|entry| std::thread::spawn(move || { let _ = close_entry(&entry); })).collect();
    for worker in workers { let _ = worker.join(); }
}

/// 新 WebView 引擎接管前清理旧代管道；不把清理失败当作成功遗忘。
#[tauri::command]
pub async fn stdio_reset(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup(&app);
        let state = app.state::<StdioMap>();
        let mut entries = state.0.lock().map_err(|_| "Stdio 注册锁失败")?;
        entries.retain(|_, entry| !entry.closed.load(Ordering::SeqCst));
        if entries.is_empty() { Ok(()) } else { Err("旧 Stdio 进程清理失败，可重试".into()) }
    }).await.map_err(|_| "Stdio 重载清理失败".to_string())?
}
