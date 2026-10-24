//! 交互终端底层 IO；会话归属、界面状态和历史策略由 TS Engine 管理。
use std::{collections::HashMap, io::{Read, Write}, sync::{Arc, Mutex, Condvar}, time::Duration};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};

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
    #[cfg(unix)]
    child: Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>,
    #[cfg(unix)]
    pid: u32,
    #[cfg(unix)]
    identity_valid: AtomicBool,
    #[cfg(unix)]
    reaping: AtomicBool,
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
        #[cfg(unix)]
        let pid = child.process_id().ok_or("终端 PID 不可用")?;
        let entry = Arc::new(Entry {
            master: Mutex::new(Some(pair.master)), writer: Mutex::new(Some(writer)),
            output: Mutex::new(Output { text: String::new(), end: 0, exited: false, process_exited: false, reader_done: false, code: None }),
            exited: (Mutex::new(false), Condvar::new()), closing: Mutex::new(()),
            #[cfg(windows)] job,
            #[cfg(unix)] pid,
            #[cfg(unix)] child: Mutex::new(Some(child)),
            #[cfg(unix)] identity_valid: AtomicBool::new(true),
            #[cfg(unix)] reaping: AtomicBool::new(false),
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
            #[cfg(windows)]
            let status = child.wait().ok().map(|s| s.exit_code());
            #[cfg(unix)]
            let status = match crate::terminal_unix::observe_exit(pid) {
                Ok(status) => status,
                Err(_) => { if !wait.reaping.load(Ordering::SeqCst) { wait.identity_valid.store(false, Ordering::SeqCst); } None }
            };
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

fn close_entry(entry: &Entry) -> Result<(), String> {
    let _guard = entry.closing.lock().map_err(|_| "终端清理锁失败")?;
    #[cfg(windows)]
    entry.job.terminate()?;
    #[cfg(unix)]
    {
        let mut child = entry.child.lock().map_err(|_| "终端子进程锁失败")?;
        // 清理失败保留未回收 Child，重试仍持有原始会话身份。
        if let Some(owned) = child.as_mut() {
            if !entry.identity_valid.load(Ordering::SeqCst) { return Err("终端进程身份已失效，拒绝使用过期 PID".into()); }
            crate::terminal_unix::close_session(entry.pid)?;
            entry.reaping.store(true, Ordering::SeqCst);
            owned.wait().map_err(|_| "终端子进程回收失败")?;
            child.take();
        }
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

#[cfg(all(test, unix))]
pub fn assert_natural_exit_cleanup() {
    fn quote(text: &str) -> String { format!("'{}'", text.replace('\'', "'\\''")) }
    let file = std::env::temp_dir().join(format!("easycode-pty-{}-{}.pid", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let path = quote(&file.to_string_lossy());
    let script = format!("printf '%s' \"$$\" > {}; exec sleep 300", path);
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", &format!("nohup sh -c {} >/dev/null 2>&1 & i=0; while [ ! -s {} ] && [ \"$i\" -lt 500 ]; do i=$((i+1)); sleep 0.01; done; test -s {}", quote(&script), path, path)]);
    let pair = native_pty_system().openpty(PtySize { cols: 90, rows: 20, pixel_width: 0, pixel_height: 0 }).unwrap();
    let child = pair.slave.spawn_command(command).unwrap();
    let pid = child.process_id().unwrap();
    drop(pair.slave);
    let writer = pair.master.take_writer().unwrap();
    let entry = Entry { master: Mutex::new(Some(pair.master)), writer: Mutex::new(Some(writer)),
        output: Mutex::new(Output { text: String::new(), end: 0, exited: true, process_exited: true, reader_done: true, code: Some(0) }),
        exited: (Mutex::new(true), Condvar::new()), closing: Mutex::new(()), pid,
        child: Mutex::new(Some(child)), identity_valid: AtomicBool::new(true), reaping: AtomicBool::new(false) };
    struct Guard<'a>(&'a Entry, &'a std::path::Path);
    impl Drop for Guard<'_> { fn drop(&mut self) { let _ = close_entry(self.0); let _ = std::fs::remove_file(self.1); } }
    let _guard = Guard(&entry, &file);
    assert_eq!(crate::terminal_unix::observe_exit(pid).unwrap(), Some(0));
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "unreaped Shell PID must remain reserved");
    let background: i32 = std::fs::read_to_string(&file).unwrap().parse().unwrap();
    assert_eq!(unsafe { libc::getsid(background) }, pid as i32, "nohup child remains in the owned session");
    close_entry(&entry).unwrap();
    assert!(entry.child.lock().unwrap().is_none());
    let status = std::process::Command::new("ps").args(["-p", &background.to_string(), "-o", "stat="]).output().unwrap();
    assert!(!status.status.success() || String::from_utf8_lossy(&status.stdout).trim().starts_with('Z'), "nohup process must no longer run");
}
#[tauri::command]
pub async fn terminal_reset(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup(&app);
        if app.state::<TerminalMap>().0.lock().map_err(|_| "终端注册锁失败")?.is_empty() { Ok(()) }
        else { Err("旧终端清理失败，可重试".into()) }
    }).await.map_err(|_| "终端重载清理失败".to_string())?
}
