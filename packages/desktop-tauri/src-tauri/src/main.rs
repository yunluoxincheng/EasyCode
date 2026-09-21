#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! EasyCode Tauri 壳 —— Rust 侧只做宿主能力：
//! 文件系统 / 子进程 / 数据目录 / 文件夹选择 / HTTP 流式代理（SSE）。
//! 业务逻辑全部在 WebView 内的 @easycode/core + @easycode/engine。

use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_PIPE: u64 = 400_000;
const MAX_STR: usize = 200_000;

/// 运行中子进程注册表：id -> pid，供中止信号杀进程
#[derive(Default)]
struct PidMap(Mutex<HashMap<String, u32>>);

/// 运行中 HTTP 请求的取消句柄：id -> oneshot sender。
#[derive(Default)]
struct HttpAbortMap(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

fn is_private_http_target(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let Ok(ip) = host.parse::<IpAddr>() else {
        return false;
    };
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

fn truncate(s: &str) -> String {
    if s.len() > MAX_STR {
        let mut end = MAX_STR;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n…[输出已截断]", &s[..end])
    } else {
        s.to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dirent {
    name: String,
    is_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatOut {
    is_directory: bool,
    size: u64,
    mtime_ms: u64,
}

#[derive(Serialize)]
struct HostInfo {
    sep: String,
    data_dir: String,
}

#[tauri::command]
fn host_info(app: AppHandle) -> Result<HostInfo, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(HostInfo {
        sep: std::path::MAIN_SEPARATOR.to_string(),
        data_dir: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn fs_read(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err(format!("疑似二进制文件，无法以文本读取: {}", path));
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
fn fs_write(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_mkdir(path: String, recursive: Option<bool>) -> Result<(), String> {
    let r = if recursive.unwrap_or(false) {
        std::fs::create_dir_all(&path)
    } else {
        std::fs::create_dir(&path)
    };
    r.map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_readdir(path: String) -> Result<Vec<Dirent>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        out.push(Dirent {
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
        });
    }
    Ok(out)
}

#[tauri::command]
fn fs_stat(path: String) -> Result<Option<StatOut>, String> {
    match std::fs::metadata(&path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Ok(Some(StatOut {
                is_directory: m.is_dir(),
                size: m.len(),
                mtime_ms: mtime,
            }))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn fs_unlink(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) => std::fs::remove_dir(&path).map_err(|_| e.to_string()),
    }
}

#[tauri::command]
async fn proc_run(
    state: tauri::State<'_, PidMap>,
    id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000));

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&command);
        c
    };
    if let Some(dir) = cwd.as_deref() {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    hide_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("启动命令失败: {}", e))?;
    let pid = child.id();
    state.0.lock().unwrap().insert(id.clone(), pid);

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = stdout_pipe.as_mut() {
            let _ = p.take(MAX_PIPE).read_to_end(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.take(MAX_PIPE).read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let mut code: Option<i32> = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                code = st.code();
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
            Err(e) => {
                state.0.lock().unwrap().remove(&id);
                return Err(format!("等待命令失败: {}", e));
            }
        }
    }
    state.0.lock().unwrap().remove(&id);

    let stdout = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).to_string();
    let mut stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).to_string();
    if timed_out {
        stderr.push_str(&format!(
            "\n[EasyCode] 命令超时（{}s），已终止。",
            timeout.as_secs()
        ));
    }
    Ok(serde_json::json!({
        "code": code,
        "stdout": truncate(&stdout),
        "stderr": truncate(&stderr),
    }))
}

#[tauri::command]
fn proc_kill(state: tauri::State<'_, PidMap>, id: String) -> Result<(), String> {
    if let Some(pid) = state.0.lock().unwrap().remove(&id) {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/T", "/F"]);
            c
        } else {
            let mut c = Command::new("kill");
            c.arg("-9").arg(pid.to_string());
            c
        };
        hide_window(&mut cmd);
        let _ = cmd.output();
    }
    Ok(())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

/// 用系统文件管理器打开路径（文件夹或文件）
#[tauri::command]
async fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

/// 探测 PATH 中的 code 命令（VS Code CLI）。返回是否找到。
fn probe_vscode() -> bool {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", "where", "code"]);
        hide_window(&mut c);
        matches!(c.output(), Ok(o) if o.status.success() && !o.stdout.is_empty())
    }
    #[cfg(not(windows))]
    {
        matches!(Command::new("which").arg("code").output(), Ok(o) if o.status.success() && !o.stdout.is_empty())
    }
}

/// 用 VS Code 打开目录（探测 code 命令，未安装时报错）
#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    if !probe_vscode() {
        return Err("未检测到 VS Code，请先安装并在 PATH 中注册 code 命令".into());
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", "code", &path]);
        hide_window(&mut c);
        c.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        Command::new("code")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 发送系统通知。
/// Windows 直接用 winrt toast：挂 on_activated 回调，用户点击通知时唤起主窗口；
/// 其他平台走 notification 插件（无点击回调）。
#[tauri::command]
async fn send_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        // 与 tauri-plugin-notification 同策略：仅安装版（exe 不在 target/debug|release）使用应用 AUMID，
        // dev 构建回退 PowerShell AUMID（否则 toast 拒发）
        let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
        let dev = exe
            .parent()
            .map(|d| {
                let s = d.display().to_string();
                s.ends_with("\\target\\debug") || s.ends_with("\\target\\release")
            })
            .unwrap_or(true);
        let aumid = if dev {
            Toast::POWERSHELL_APP_ID.to_string()
        } else {
            app.config().identifier.clone()
        };
        let handle = app.clone();
        Toast::new(&aumid)
            .title(&title)
            .text1(&body)
            .on_activated(move |_| {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Frame {
    S { c: u16 },
    D { d: String },
    X { m: String },
    E,
}

/// HTTP 流式代理：LLM API 请求经 reqwest 发出，响应体逐块 base64 回传，
/// 绕过 WebView CORS 且保留 SSE 流式语义。请求体/头由 core 的 Provider 构造。
#[tauri::command]
async fn http_stream(
    id: String,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    on_event: Channel<Frame>,
    aborts: State<'_, HttpAbortMap>,
) -> Result<(), String> {
    let mut builder = reqwest::Client::builder();
    if is_private_http_target(&url) {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client.request(m, &url);
    for (k, v) in &headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        rb = rb.body(b);
    }

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut map = aborts.0.lock().map_err(|e| e.to_string())?;
        if let Some(previous) = map.insert(id.clone(), cancel_tx) {
            let _ = previous.send(());
        }
    }

    let resp = tokio::select! {
        result = rb.send() => {
            match result {
                Ok(r) => r,
                Err(e) => {
                    let _ = aborts.0.lock().map(|mut map| map.remove(&id));
                    let _ = on_event.send(Frame::X { m: format!("请求失败: {}", e) });
                    return Ok(());
                }
            }
        }
        _ = &mut cancel_rx => {
            let _ = aborts.0.lock().map(|mut map| map.remove(&id));
            return Ok(());
        }
    };
    let _ = on_event.send(Frame::S { c: resp.status().as_u16() });

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut chunks = 0usize;
    let mut total = 0usize;
    loop {
        let next = tokio::select! {
            chunk = stream.next() => chunk,
            _ = &mut cancel_rx => {
                let _ = on_event.send(Frame::X { m: "请求已取消".to_string() });
                break;
            }
        };
        let Some(chunk) = next else {
            break;
        };
        match chunk {
            Ok(bytes) => {
                chunks += 1;
                total += bytes.len();
                let d = base64::engine::general_purpose::STANDARD.encode(&bytes);
                if on_event.send(Frame::D { d }).is_err() {
                    eprintln!("[http_stream] channel send failed, aborting");
                    break;
                }
            }
            Err(e) => {
                let _ = on_event.send(Frame::X { m: format!("连接中断: {}", e) });
                break;
            }
        }
    }
    let _ = aborts.0.lock().map(|mut map| map.remove(&id));
    let _ = on_event.send(Frame::E);
    eprintln!("[http_stream] done url={} chunks={} total={}B", url, chunks, total);
    Ok(())
}

#[tauri::command]
fn http_stream_cancel(id: String, aborts: State<'_, HttpAbortMap>) -> Result<(), String> {
    if let Some(tx) = aborts.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PidMap::default())
        .manage(HttpAbortMap::default())
        .invoke_handler(tauri::generate_handler![
            host_info,
            fs_read,
            fs_write,
            fs_mkdir,
            fs_readdir,
            fs_stat,
            fs_unlink,
            proc_run,
            proc_kill,
            pick_folder,
            open_path,
            open_in_vscode,
            send_notification,
            http_stream,
            http_stream_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
