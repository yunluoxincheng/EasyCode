//! 交互终端底层 IO；会话归属、界面状态和历史策略由 TS Engine 管理。
use std::{collections::HashMap, io::{Read, Write}, sync::{Arc, Mutex, Condvar}, time::Duration};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct TerminalMap(Mutex<HashMap<String, Arc<Entry>>>);
struct Output { text: String, end: usize, exited: bool, process_exited: bool, reader_done: bool, code: Option<u32> }
struct Entry {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    output: Mutex<Output>,
    exited: (Mutex<bool>, Condvar),
    closing: Mutex<()>,
    #[cfg(windows)]
    job: crate::foreground_job::Job,
}
#[derive(Deserialize)]
pub struct Options { cwd: String, cols: u16, rows: u16 }
#[derive(Serialize)]
pub struct Opened { id: String, shell: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame { output: String, end: usize, exited: bool, exit_code: Option<u32> }

fn dimensions(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(2..=500).contains(&rows) { return Err("终端尺寸无效".into()); }
    Ok(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
}

#[cfg(windows)]
fn terminal_settings_json(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut stripped = String::new();
    let (mut index, mut quoted, mut escaped) = (0, false, false);
    while index < chars.len() {
        let c = chars[index];
        if quoted {
            stripped.push(c);
            if escaped { escaped = false; } else if c == '\\' { escaped = true; } else if c == '"' { quoted = false; }
        } else if c == '"' { quoted = true; stripped.push(c); }
        else if c == '/' && chars.get(index + 1) == Some(&'/') {
            while index < chars.len() && chars[index] != '\n' { index += 1; }
            stripped.push('\n'); continue;
        } else if c == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') { index += 1; }
            index += 2; stripped.push(' '); continue;
        } else { stripped.push(c); }
        index += 1;
    }
    let chars: Vec<char> = stripped.chars().collect();
    let mut result = String::new();
    quoted = false; escaped = false;
    for (index, c) in chars.iter().copied().enumerate() {
        if quoted {
            result.push(c);
            if escaped { escaped = false; } else if c == '\\' { escaped = true; } else if c == '"' { quoted = false; }
        } else if c == '"' { quoted = true; result.push(c); }
        else if c == ',' {
            let next = chars[index + 1..].iter().find(|c| !c.is_whitespace());
            if next != Some(&'}') && next != Some(&']') { result.push(c); }
        } else { result.push(c); }
    }
    result
}

#[cfg(windows)]
fn resolve_shell() -> Result<String, String> {
    let shells = crate::detect_available_shells();
    // Windows Terminal 配置是可选来源；只选择 Shell，不执行 Profile 内的启动命令。
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for relative in ["Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json", "Microsoft/Windows Terminal/settings.json"] {
            let path = std::path::Path::new(&local).join(relative);
            if std::fs::metadata(&path).map_or(true, |m| m.len() > 1048576) { continue; }
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&terminal_settings_json(&text)) {
                    if let Some(id) = value["defaultProfile"].as_str() {
                        if let Some(profile) = value["profiles"]["list"].as_array().and_then(|list| list.iter().find(|p| p["guid"].as_str() == Some(id))) {
                            let command = profile["commandline"].as_str().unwrap_or("");
                            let first = if command.starts_with('"') { command[1..].split('"').next().unwrap_or("") }
                                else { command.split_whitespace().next().unwrap_or("") };
                            let name = std::path::Path::new(first).file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
                            for shell in &shells {
                                if shell.available && shell.path.as_ref().map_or(false, |p| {
                                    std::path::Path::new(p).file_name().and_then(|n| n.to_str()).map_or(false, |n| n.eq_ignore_ascii_case(&name))
                                }) { return Ok(shell.path.clone().unwrap()); }
                            }
                            if profile["source"].as_str() == Some("Windows.Terminal.PowershellCore") {
                                if let Some(shell) = shells.iter().find(|s| s.available && s.id == "pwsh") { return Ok(shell.path.clone().unwrap()); }
                            }
                        }
                    }
                }
            }
        }
    }
    for id in ["pwsh", "powershell", "cmd"] {
        if let Some(shell) = shells.iter().find(|s| s.available && s.id == id) {
            if let Some(path) = &shell.path { return Ok(path.clone()); }
        }
    }
    Err("未找到可用的系统 Shell".into())
}
#[cfg(unix)]
fn resolve_shell() -> Result<String, String> {
    Ok(std::env::var("SHELL").ok().filter(|p| std::path::Path::new(p).is_file()).unwrap_or_else(|| "/bin/sh".into()))
}

fn append(entry: &Entry, text: &str) {
    if let Ok(mut output) = entry.output.lock() {
        output.text.push_str(text);
        output.end += text.len();
        if output.text.len() > 262144 {
            let mut start = output.text.len() - 262144;
            while !output.text.is_char_boundary(start) { start += 1; }
            output.text.drain(..start);
        }
    }
}

fn get(app: &AppHandle, id: &str) -> Result<Arc<Entry>, String> {
    app.state::<TerminalMap>().0.lock().map_err(|_| "终端注册锁失败")?.get(id).cloned().ok_or_else(|| "终端不存在或已结束".into())
}

#[tauri::command]
pub async fn terminal_open(app: AppHandle, options: Options) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let size = dimensions(options.cols, options.rows)?;
        if options.cwd.len() > 4096 || !std::path::Path::new(&options.cwd).is_dir() { return Err("终端工作目录无效".into()); }
        let shell = resolve_shell()?;
        // 注册锁覆盖创建过程，限制并发启动数，失败不登记半成品。
        let state = app.state::<TerminalMap>();
        let mut entries = state.0.lock().map_err(|_| "终端注册锁失败")?;
        if entries.len() >= 8 { return Err("终端数量已满".into()); }
        let pair = native_pty_system().openpty(size).map_err(|_| "创建 PTY 失败")?;
        #[cfg(windows)]
        let mut command = {
            let mut c = CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()));
            c.args(["/d", "/q"]);
            c
        };
        #[cfg(unix)]
        let mut command = { let mut c = CommandBuilder::new(&shell); c.arg("-l"); c };
        command.cwd(&options.cwd);
        command.env("TERM", "xterm-256color");
        let mut reader = pair.master.try_clone_reader().map_err(|_| "读取 PTY 失败")?;
        let mut writer = pair.master.take_writer().map_err(|_| "写入 PTY 失败")?;
        let mut child = pair.slave.spawn_command(command).map_err(|_| "启动终端失败")?;
        #[cfg(windows)]
        let job = match child.as_raw_handle().ok_or_else(|| "终端进程句柄不可用".to_string())
            .and_then(|handle| crate::foreground_job::Job::attach(handle as _)) {
            Ok(job) => job,
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); }
        };
        #[cfg(windows)]
        {
            // /d 禁用 cmd AutoRun；只有 Job 已登记后才启动用户配置的 Shell。
            let args = if shell.to_lowercase().ends_with("cmd.exe") { "/d" } else if shell.to_lowercase().contains("powershell") || shell.to_lowercase().contains("pwsh") { "-NoLogo" } else { "-l" };
            if writer.write_all(format!("@\"{}\" {} & exit\r", shell, args).as_bytes()).and_then(|_| writer.flush()).is_err() {
                let _ = job.terminate(); let _ = child.wait(); return Err("终端 Shell 启动失败".into());
            }
        }
        drop(pair.slave);
        let entry = Arc::new(Entry {
            master: Mutex::new(Some(pair.master)), writer: Mutex::new(Some(writer)),
            output: Mutex::new(Output { text: String::new(), end: 0, exited: false, process_exited: false, reader_done: false, code: None }),
            exited: (Mutex::new(false), Condvar::new()), closing: Mutex::new(()),
            #[cfg(windows)] job,
        });
        let id = format!("pty-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "系统时间无效")?.as_nanos());
        entries.insert(id.clone(), entry.clone());
        let out = entry.clone();
        std::thread::spawn(move || {
            let mut pending = Vec::new();
            let mut buffer = [0u8; 8192];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 { break; }
                pending.extend_from_slice(&buffer[..count]);
                loop {
                    match std::str::from_utf8(&pending) {
                        Ok(text) => { append(&out, text); pending.clear(); break; }
                        Err(error) => {
                            let valid = error.valid_up_to();
                            append(&out, &String::from_utf8_lossy(&pending[..valid]));
                            pending.drain(..valid);
                            if let Some(invalid) = error.error_len() { append(&out, "\u{fffd}"); pending.drain(..invalid); }
                            else { break; }
                        }
                    }
                }
            }
            if !pending.is_empty() { append(&out, &String::from_utf8_lossy(&pending)); }
            if let Ok(mut output) = out.output.lock() { output.reader_done = true; output.exited = output.process_exited; }
        });
        let wait = entry.clone();
        std::thread::spawn(move || {
            let status = child.wait().ok().map(|s| s.exit_code());
            #[cfg(windows)]
            let _ = wait.job.terminate();
            if let Ok(mut output) = wait.output.lock() { output.process_exited = true; output.exited = output.reader_done; output.code = status; }
            if let Ok(mut exited) = wait.exited.0.lock() { *exited = true; wait.exited.1.notify_all(); }
        });
        Ok(Opened { id, shell })
    }).await.map_err(|_| "终端创建任务失败".to_string())?
}

#[tauri::command]
pub fn terminal_read(app: AppHandle, id: String, cursor: usize) -> Result<Frame, String> {
    let entry = get(&app, &id)?;
    let out = entry.output.lock().map_err(|_| "终端输出锁失败")?;
    let start = out.end - out.text.len();
    let mut offset = cursor.max(start).min(out.end) - start;
    while !out.text.is_char_boundary(offset) { offset += 1; }
    Ok(Frame { output: out.text[offset..].into(), end: out.end, exited: out.exited, exit_code: out.code })
}

#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    if data.len() > 65536 { return Err("终端输入超过限制".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let entry = get(&app, &id)?;
        let mut writer = entry.writer.lock().map_err(|_| "终端写入锁失败")?;
        let writer = writer.as_mut().ok_or("终端已关闭")?;
        writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).map_err(|_| "终端写入失败".into())
    }).await.map_err(|_| "终端写入任务失败".to_string())?
}

#[tauri::command]
pub fn terminal_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let size = dimensions(cols, rows)?;
    let entry = get(&app, &id)?;
    let master = entry.master.lock().map_err(|_| "终端尺寸锁失败")?;
    master.as_ref().ok_or("终端已关闭")?.resize(size).map_err(|_| "终端尺寸更新失败".into())
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) -> Result<bool, String> {
    extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
    if unsafe { kill(-(pid as i32), signal) } == 0 { return Ok(true); }
    if std::io::Error::last_os_error().raw_os_error() == Some(3) { Ok(false) }
    else { Err("终端进程组操作失败".into()) }
}

fn close_entry(entry: &Entry) -> Result<(), String> {
    let _guard = entry.closing.lock().map_err(|_| "终端清理锁失败")?;
    #[cfg(windows)]
    entry.job.terminate()?;
    #[cfg(unix)]
    {
        // 查询该控制终端的全部作业组，包括后台作业；不对已退出且可能被复用的旧 PID 发信号。
        let tty = entry.master.lock().map_err(|_| "终端状态锁失败")?.as_ref().and_then(|m| m.tty_name());
        let groups = if let Some(tty) = tty {
            let output = std::process::Command::new("ps").arg("-t").arg(tty).args(["-o", "pgid="]).output().map_err(|_| "查询终端作业组失败")?;
            if !output.status.success() && !(output.status.code() == Some(1) && output.stderr.is_empty()) { return Err("查询终端作业组失败，可重试".into()); }
            let mut groups: Vec<u32> = String::from_utf8_lossy(&output.stdout).split_whitespace().filter_map(|s| s.parse::<u32>().ok()).filter(|pid| *pid > 0).collect();
            groups.sort_unstable(); groups.dedup(); groups
        } else { Vec::new() };
        for pid in &groups { signal_group(*pid, 15)?; }
        for _ in 0..30 {
            if groups.iter().all(|pid| matches!(signal_group(*pid, 0), Ok(false))) { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
        for pid in &groups { if signal_group(*pid, 0)? { signal_group(*pid, 9)?; } }
        for _ in 0..30 {
            if groups.iter().all(|pid| matches!(signal_group(*pid, 0), Ok(false))) { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
        for pid in groups { if signal_group(pid, 0)? { return Err("终端进程组尚未退出，可重试".into()); } }
    }
    let exited = entry.exited.0.lock().map_err(|_| "终端退出锁失败")?;
    let (exited, _) = entry.exited.1.wait_timeout_while(exited, Duration::from_secs(5), |v| !*v).map_err(|_| "终端退出等待失败")?;
    if !*exited { return Err("终端退出未完成，可重试".into()); }
    if let Ok(mut writer) = entry.writer.try_lock() { writer.take(); }
    entry.master.lock().map_err(|_| "终端释放锁失败")?.take();
    Ok(())
}

#[tauri::command]
pub async fn terminal_close(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = app.state::<TerminalMap>().0.lock().map_err(|_| "终端注册锁失败")?.get(&id).cloned();
        if let Some(entry) = entry {
            close_entry(&entry)?;
            app.state::<TerminalMap>().0.lock().map_err(|_| "终端注册锁失败")?.remove(&id);
        }
        Ok(())
    }).await.map_err(|_| "终端清理任务失败".to_string())?
}

pub fn cleanup(app: &AppHandle) {
    let entries: Vec<_> = app.state::<TerminalMap>().0.lock().map(|m| m.iter().map(|(id, entry)| (id.clone(), entry.clone())).collect()).unwrap_or_default();
    for (id, entry) in entries {
        if close_entry(&entry).is_ok() { if let Ok(mut map) = app.state::<TerminalMap>().0.lock() { map.remove(&id); } }
    }
}
#[tauri::command]
pub async fn terminal_reset(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup(&app);
        if app.state::<TerminalMap>().0.lock().map_err(|_| "终端注册锁失败")?.is_empty() { Ok(()) }
        else { Err("旧终端清理失败，可重试".into()) }
    }).await.map_err(|_| "终端重载清理失败".to_string())?
}
