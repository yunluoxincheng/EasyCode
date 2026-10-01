#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! EasyCode Tauri 壳 —— Rust 侧只做宿主能力：
//! 文件系统 / 子进程 / 数据目录 / 文件夹选择 / HTTP 流式代理（SSE）。
//! 业务逻辑全部在 WebView 内的 @easycode/core + @easycode/engine。

use std::collections::HashMap;
use std::io::{Read, Write};
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

/// 后台任务注册表（TODOS #37）：id -> 元数据。WebView 重载后 proc_list 恢复接管；
/// 应用退出时 kill_all_spawned 清场，杜绝孤儿 dev server 占端口。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnedInfo {
    id: String,
    pid: u32,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    started_ms: u64,
    alive: bool,
}

#[derive(Default)]
struct SpawnMap(Mutex<HashMap<String, SpawnedInfo>>);

/// 流式增量解码器（TODOS #37）：默认按 UTF-8 增量解出完整片段（跨块的不完整序列留待下一块）；
/// 一旦出现确定非法的 UTF-8 字节（如 GBK 输出），整个流确定性切换为 ANSI 代码页解码——
/// 与 proc_run 的整缓冲判定语义一致，避免按 UTF-8 非法长度逐字节碎解 GBK 双字节字符。
/// ANSI 模式下保留末尾可能不完整的多字节 lead 字节（GBK/Big5 lead 均 ≥ 0x81）到下一块。
struct StreamDecoder {
    buf: Vec<u8>,
    /// true = 已判定为 ANSI 代码页流（CP_ACP，如简体中文 Windows 的 GBK/CP936）
    ansi_mode: bool,
}

impl StreamDecoder {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
            ansi_mode: false,
        }
    }

    fn feed(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        if self.buf.len() < 1 << 20 {
            self.buf.extend_from_slice(chunk);
        } else {
            // 异常防护：残存缓冲异常膨胀时直接 lossy 丢弃，保证不解内存
            out.push(String::from_utf8_lossy(&self.buf).into_owned());
            self.buf.clear();
            out.push(String::from_utf8_lossy(chunk).into_owned());
            return;
        }
        loop {
            if self.ansi_mode {
                self.feed_ansi(out);
                return;
            }
            if self.buf.is_empty() {
                return;
            }
            match std::str::from_utf8(&self.buf) {
                Ok(s) => {
                    out.push(s.to_string());
                    self.buf.clear();
                    return;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        // valid_up_to 保证前缀合法
                        let s = std::str::from_utf8(&self.buf[..valid]).unwrap_or_default();
                        out.push(s.to_string());
                        self.buf.drain(..valid);
                        continue;
                    }
                    match e.error_len() {
                        None => return, // 不完整的 UTF-8 序列：留待下一块（也可能本是 ANSI 多字节的前半）
                        Some(_) => {
                            // 确定非法：整流切换 ANSI 代码页模式（不再按 UTF-8 非法长度碎解）
                            self.ansi_mode = true;
                            self.feed_ansi(out);
                            return;
                        }
                    }
                }
            }
        }
    }

    /// ANSI 代码页流式解码：按真实 ACP 的 DBCS 语义成对消费 lead+trail，
    /// 末尾孤立 lead 保留到下一块（trail 字节数值落在 lead 区间也不会误判，
    /// 因为它已作为前一 lead 的 trail 被消费）。非 DBCS 代码页整段解码、无持有。
    fn feed_ansi(&mut self, out: &mut Vec<String>) {
        #[cfg(windows)]
        {
            let cp = get_acp();
            // DBCS 扫描：返回可安全解码的前缀长度（孤立 lead 之前）
            let mut i = 0usize;
            while i < self.buf.len() {
                if is_dbcs_lead_byte(cp, self.buf[i]) {
                    if i + 1 < self.buf.len() {
                        i += 2; // lead + trail 成对消费
                    } else {
                        break; // 末尾孤立 lead：留待下一块
                    }
                } else {
                    i += 1;
                }
            }
            if i > 0 {
                let decoded = decode_output(&self.buf[..i]);
                out.push(decoded);
                self.buf.drain(..i);
            }
            return;
        }
        #[cfg(not(windows))]
        {
            // 非 Windows 无 DBCS 语义（decode_output 退路是逐字节 lossy，与配对无关），整段解码
            if !self.buf.is_empty() {
                let decoded = decode_output(&self.buf);
                out.push(decoded);
                self.buf.clear();
            }
        }
    }

    /// 流结束：冲刷残余字节（不完整序列按 ACP/lossy 兜底）
    fn flush(&mut self, out: &mut Vec<String>) {
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            out.push(decode_output(&rest));
        }
    }
}

#[cfg(test)]
mod stream_decoder_tests {
    use super::*;

    #[test]
    fn utf8_multibyte_across_chunks() {
        let mut d = StreamDecoder::new();
        let mut out = Vec::new();
        // "你" = E4 BD A0，"好" = E5 A5 BD；在"你"的第二字节后切块
        d.feed(&[0xE4, 0xBD], &mut out);
        assert!(out.is_empty(), "不完整序列应等待下一块");
        d.feed(&[0xA0, 0xE5, 0xA5, 0xBD, 0x0A], &mut out);
        d.flush(&mut out);
        assert_eq!(out.join(""), "你好\n");
    }

    #[test]
    fn utf8_ascii_passthrough() {
        let mut d = StreamDecoder::new();
        let mut out = Vec::new();
        d.feed(b"ready in 233 ms\n", &mut out);
        d.flush(&mut out);
        assert_eq!(out.join(""), "ready in 233 ms\n");
    }

    #[test]
    fn dbcs_complete_char_at_chunk_end_is_not_split() {
        // GBK "中" = D6 D0，chunk 恰好结束在完整双字节字符之后：
        // trail 字节 D0 数值同样落在 lead 区间，但不得被误判为下一字符的 lead
        let mut d = StreamDecoder::new();
        let mut out = Vec::new();
        d.feed(&[0xD6, 0xD0], &mut out);
        // 立即整段解码（旧实现会保留 D0、单独碎解 D6）
        assert_eq!(out.len(), 1, "完整 DBCS 字符应成对消费: {:?}", out);
        d.feed(&[0xCE, 0xC4], &mut out);
        d.flush(&mut out);
        #[cfg(windows)]
        {
            extern "system" {
                fn GetACP() -> u32;
            }
            if unsafe { GetACP() } == 936 {
                assert_eq!(out.join(""), "中文");
            }
        }
    }

    #[test]
    fn ansi_stream_switches_wholesale_without_per_byte_split() {
        // GBK "你好" = C4 E3 BA C3：首块只有 lead 字节 C4 时不得立即碎解
        let mut d = StreamDecoder::new();
        let mut out = Vec::new();
        d.feed(&[0xC4], &mut out);
        assert!(out.is_empty(), "单 lead 字节应观望而非逐字节碎解");
        d.feed(&[0xE3, 0xBA, 0xC3, 0x0D, 0x0A], &mut out);
        d.flush(&mut out);
        // 关键回归断言：整段切换 ANSI 模式后一次性解码，不产生逐字节碎片
        assert_eq!(out.len(), 1, "应整段解码而非按 UTF-8 非法长度碎解: {:?}", out);
        // 同流后续块继续走 ANSI 模式且按 lead 字节持有跨块边界
        let mut out2 = Vec::new();
        // GBK "中文" = D6 D0 CE C4：先到 D6 D0 CE，C4 留待下一块
        d.feed(&[0xD6, 0xD0, 0xCE], &mut out2);
        d.feed(&[0xC4, 0x21], &mut out2);
        d.flush(&mut out2);
        // 多个传输段是正常的（JS 侧拼行），但字符本身不得被碎解
        assert!(!out2.is_empty());
        // 精确字符断言仅在实际 GBK 代码页（CP936）机器上成立；
        // ACP=65001（系统 UTF-8）等环境退路是 lossy，但结构上保证 lead 字节跨块持有
        #[cfg(windows)]
        {
            extern "system" {
                fn GetACP() -> u32;
            }
            if unsafe { GetACP() } == 936 {
                assert_eq!(out.join(""), "你好\r\n");
                assert_eq!(out2.join(""), "中文!");
            }
        }
    }
}

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

/// 当前 ANSI 代码页（简体中文 Windows 通常为 936/GBK；开启系统 UTF-8 时为 65001）
#[cfg(windows)]
fn get_acp() -> u32 {
    extern "system" {
        fn GetACP() -> u32;
    }
    unsafe { GetACP() }
}

/// DBCS lead 字节判定（Win32 IsDBCSLeadByteEx）：按真实代码页的 lead 区间判定，
/// trail 字节即便数值落在 lead 区间也不会被误判（它由前导 lead 的配对逻辑消费）
#[cfg(windows)]
fn is_dbcs_lead_byte(cp: u32, byte: u8) -> bool {
    extern "system" {
        fn IsDBCSLeadByteEx(CodePage: u16, TestChar: u8) -> i32;
    }
    unsafe { IsDBCSLeadByteEx(cp as u16, byte) != 0 }
}

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
fn fs_append(path: String, data: String) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(data.as_bytes()).map_err(|e| e.to_string())
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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    id: String,
    name: String,
    path: Option<String>,
    available: bool,
}

/// 智能解码子进程输出：优先合法 UTF-8；在 Windows 下若含非法字节，按系统当前 ANSI 代码页 (CP_ACP/GBK) 转码，杜绝乱码。
fn decode_output(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    #[cfg(windows)]
    {
        extern "system" {
            fn MultiByteToWideChar(
                CodePage: u32,
                dwFlags: u32,
                lpMultiByteStr: *const u8,
                cbMultiByte: i32,
                lpWideCharStr: *mut u16,
                cchWideChar: i32,
            ) -> i32;
        }
        if !bytes.is_empty() {
            let len = unsafe {
                MultiByteToWideChar(
                    0, // CP_ACP (系统当前 ANSI 代码页，如简体中文 Windows 下为 936/GBK)
                    0,
                    bytes.as_ptr(),
                    bytes.len() as i32,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if len > 0 {
                let mut wide_buf = vec![0u16; len as usize];
                let converted = unsafe {
                    MultiByteToWideChar(
                        0,
                        0,
                        bytes.as_ptr(),
                        bytes.len() as i32,
                        wide_buf.as_mut_ptr(),
                        len,
                    )
                };
                if converted > 0 {
                    return String::from_utf16_lossy(&wide_buf);
                }
            }
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(windows)]
fn probe_where(bin: &str) -> Option<String> {
    let mut c = Command::new("cmd");
    c.args(["/C", "where", bin]);
    hide_window(&mut c);
    if let Ok(o) = c.output() {
        if o.status.success() {
            let out = String::from_utf8_lossy(&o.stdout);
            if let Some(first_line) = out.lines().next() {
                let trimmed = first_line.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

/// 探测当前系统可用的 Shell
fn detect_available_shells() -> Vec<ShellInfo> {
    #[cfg(windows)]
    {
        let mut list = Vec::new();

        // 1. pwsh (PowerShell 7)
        let pwsh_path = probe_where("pwsh").or_else(|| {
            let candidates = [
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                r"C:\Program Files\PowerShell\7-preview\pwsh.exe",
            ];
            candidates.iter().find(|p| std::path::Path::new(p).exists()).map(|s| s.to_string())
        });
        list.push(ShellInfo {
            id: "pwsh".into(),
            name: "PowerShell 7".into(),
            available: pwsh_path.is_some(),
            path: pwsh_path,
        });

        // 2. git-bash (Git Bash)
        let git_bash_path = {
            let candidates = [
                r"C:\Program Files\Git\bin\bash.exe",
                r"C:\Program Files\Git\usr\bin\bash.exe",
                r"C:\Program Files (x86)\Git\bin\bash.exe",
            ];
            let mut found = candidates.iter().find(|p| std::path::Path::new(p).exists()).map(|s| s.to_string());
            if found.is_none() {
                if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                    let local_path = format!(r"{}\Programs\Git\bin\bash.exe", local_app_data);
                    if std::path::Path::new(&local_path).exists() {
                        found = Some(local_path);
                    }
                }
            }
            if found.is_none() {
                if let Some(p) = probe_where("bash") {
                    if p.to_lowercase().contains("git") {
                        found = Some(p);
                    }
                }
            }
            found
        };
        list.push(ShellInfo {
            id: "git-bash".into(),
            name: "Git Bash".into(),
            available: git_bash_path.is_some(),
            path: git_bash_path,
        });

        // 3. powershell (Windows PowerShell 5.1)
        let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let ps_path = format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", sys_root);
        let ps_avail = std::path::Path::new(&ps_path).exists();
        list.push(ShellInfo {
            id: "powershell".into(),
            name: "Windows PowerShell".into(),
            available: ps_avail,
            path: if ps_avail { Some(ps_path) } else { None },
        });

        // 4. cmd (Command Prompt)
        let cmd_path = format!(r"{}\System32\cmd.exe", sys_root);
        let cmd_avail = std::path::Path::new(&cmd_path).exists();
        list.push(ShellInfo {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            available: cmd_avail,
            path: if cmd_avail { Some(cmd_path) } else { None },
        });

        list
    }
    #[cfg(not(windows))]
    {
        vec![
            ShellInfo {
                id: "sh".into(),
                name: "POSIX sh".into(),
                path: Some("/bin/sh".into()),
                available: true,
            },
            ShellInfo {
                id: "bash".into(),
                name: "Bash".into(),
                path: Some("/bin/bash".into()),
                available: std::path::Path::new("/bin/bash").exists(),
            },
        ]
    }
}

#[cfg(windows)]
fn resolve_windows_shell(
    requested: Option<&str>,
    shells: &[ShellInfo],
) -> (String, Vec<String>) {
    // 优先级：pwsh -> git-bash -> powershell -> cmd
    let target_id = match requested {
        Some("pwsh") => "pwsh",
        Some("git-bash") => "git-bash",
        Some("powershell") => "powershell",
        Some("cmd") => "cmd",
        _ => {
            if shells.iter().any(|s| s.id == "pwsh" && s.available) {
                "pwsh"
            } else if shells.iter().any(|s| s.id == "git-bash" && s.available) {
                "git-bash"
            } else if shells.iter().any(|s| s.id == "powershell" && s.available) {
                "powershell"
            } else {
                "cmd"
            }
        }
    };

    let shell_info = shells.iter().find(|s| s.id == target_id);
    let bin = shell_info
        .and_then(|s| s.path.as_ref())
        .cloned()
        .unwrap_or_else(|| match target_id {
            "pwsh" => "pwsh.exe".into(),
            "git-bash" => "bash.exe".into(),
            "powershell" => "powershell.exe".into(),
            _ => "cmd.exe".into(),
        });

    let args = match target_id {
        "git-bash" => vec!["-c".to_string()],
        "pwsh" => vec!["-NoProfile".to_string(), "-NonInteractive".to_string(), "-Command".to_string()],
        "powershell" => vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-Command".to_string(),
        ],
        _ => vec!["/C".to_string()],
    };

    (bin, args)
}

#[tauri::command]
fn proc_detect_shells() -> Vec<ShellInfo> {
    detect_available_shells()
}

/// 按请求的 shell（或自动探测结果）构造执行命令的 shell 进程（proc_run / proc_spawn 共用）
fn make_shell_command(command: &str, cwd: Option<&str>, shell: Option<&str>) -> Command {
    #[cfg(windows)]
    let mut cmd = {
        let shells = detect_available_shells();
        let (bin, shell_args) = resolve_windows_shell(shell, &shells);
        let mut c = Command::new(bin);
        for a in shell_args {
            c.arg(a);
        }
        c.arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let bin = match shell {
            Some("bash") => "bash",
            _ => "sh",
        };
        let mut c = Command::new(bin);
        c.arg("-c").arg(command);
        // Unix 下让 shell 成为独立进程组长（pgid = pid）：终止时对整组发信号，
        // 才能连同 `sh -c "pnpm dev"` 拉起的 node/vite 后代一起终止
        use std::os::unix::process::CommandExt;
        c.process_group(0);
        c
    };
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    cmd
}

/// 终止进程：Windows 树杀整棵进程树；Unix 优先按进程组杀（命令以独立进程组启动，
/// 组长 pid 即 pgid），非组长（历史记录）回退单杀。
/// 返回值语义：Ok = 进程已消亡（或本就不存在）；Err = 进程可能仍在运行（如权限失败）。
/// 设计取舍：Tauri 侧直接强杀（SIGKILL / taskkill /F），无 TERM 宽限——与 Windows 侧
/// 一致的确定性语义；graceful 终止由 Node 宿主（TERM → 3s → KILL）承担。
fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_window(&mut cmd);
        let output = cmd
            .output()
            .map_err(|e| format!("执行 taskkill 失败: {}", e))?;
        if !output.status.success() && process_exists(pid) {
            return Err(format!(
                "taskkill 退出码 {:?}，进程 {} 可能仍在运行",
                output.status.code(),
                pid
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let group_killed = Command::new("kill")
            .arg("-9")
            .arg(format!("-{}", pid))
            .output()
            .map_err(|e| format!("执行 kill 失败: {}", e))?;
        if !group_killed.status.success() {
            // 非组长或权限失败：单杀回退，仍失败则以探活结果定性
            let single = Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .output()
                .map_err(|e| format!("执行 kill 失败: {}", e))?;
            if !single.status.success() && process_exists(pid) {
                return Err(format!("kill 失败，进程 {} 可能仍在运行", pid));
            }
        }
        Ok(())
    }
}

/// 探测进程是否仍存在（区分「kill 报错但目标已消亡」与真失败）
#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {}", pid), "/NH"]);
    hide_window(&mut cmd);
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn process_exists(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn proc_run(
    state: tauri::State<'_, PidMap>,
    id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    shell: Option<String>,
) -> Result<serde_json::Value, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000));

    let mut cmd = make_shell_command(&command, cwd.as_deref(), shell.as_deref());
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

    let stdout = decode_output(&out_handle.join().unwrap_or_default());
    let mut stderr = decode_output(&err_handle.join().unwrap_or_default());
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
    // 先查后杀：确认终止成功才移除登记——kill 失败保留句柄，重试语义才成立
    let pid = state.0.lock().unwrap().get(&id).copied();
    if let Some(pid) = pid {
        kill_process(pid)?;
        state.0.lock().unwrap().remove(&id);
    }
    Ok(())
}

/// 启动长期运行的后台进程（TODOS #37）：立即返回 id/pid；
/// stdout+stderr 合流经流式解码后以 {"t":"out"} 帧推送，退出时补发 {"t":"exit"} 帧。
#[tauri::command]
async fn proc_spawn(
    app: AppHandle,
    spawns: tauri::State<'_, SpawnMap>,
    pids: tauri::State<'_, PidMap>,
    id: String,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut cmd = make_shell_command(&command, cwd.as_deref(), shell.as_deref());
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    hide_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("启动后台进程失败: {}", e))?;
    let pid = child.id();
    let started_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    spawns.0.lock().unwrap().insert(
        id.clone(),
        SpawnedInfo {
            id: id.clone(),
            pid,
            command: command.clone(),
            cwd: cwd.clone(),
            shell: shell.clone(),
            started_ms,
            alive: true,
        },
    );
    pids.0.lock().unwrap().insert(id.clone(), pid);

    let send_frame = |ch: &Channel<serde_json::Value>, frame: serde_json::Value| {
        // WebView 已重载/关闭时发送失败属预期，静默即可
        let _ = ch.send(frame);
    };

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let ch_out = on_event.clone();
    let out_handle = std::thread::spawn(move || {
        let mut decoder = StreamDecoder::new();
        let mut buf = [0u8; 8192];
        if let Some(p) = stdout_pipe.as_mut() {
            loop {
                match p.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut frags: Vec<String> = Vec::new();
                        decoder.feed(&buf[..n], &mut frags);
                        for f in frags {
                            send_frame(&ch_out, serde_json::json!({ "t": "out", "d": f }));
                        }
                    }
                    Err(_) => break,
                }
            }
            let mut tail: Vec<String> = Vec::new();
            decoder.flush(&mut tail);
            for f in tail {
                send_frame(&ch_out, serde_json::json!({ "t": "out", "d": f }));
            }
        }
    });
    let ch_err = on_event.clone();
    let err_handle = std::thread::spawn(move || {
        let mut decoder = StreamDecoder::new();
        let mut buf = [0u8; 8192];
        if let Some(p) = stderr_pipe.as_mut() {
            loop {
                match p.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut frags: Vec<String> = Vec::new();
                        decoder.feed(&buf[..n], &mut frags);
                        for f in frags {
                            send_frame(&ch_err, serde_json::json!({ "t": "out", "d": f }));
                        }
                    }
                    Err(_) => break,
                }
            }
            let mut tail: Vec<String> = Vec::new();
            decoder.flush(&mut tail);
            for f in tail {
                send_frame(&ch_err, serde_json::json!({ "t": "out", "d": f }));
            }
        }
    });

    // 等待进程退出：标记注册表失活并通知 WebView
    let app_handle = app.clone();
    let task_id = id.clone();
    let ch_exit = on_event;
    std::thread::spawn(move || {
        let _ = out_handle.join();
        let _ = err_handle.join();
        let code = match child.wait() {
            Ok(status) => status.code(),
            Err(_) => None,
        };
        if let Some(e) = app_handle
            .state::<SpawnMap>()
            .0
            .lock()
            .unwrap()
            .get_mut(&task_id)
        {
            e.alive = false;
        }
        app_handle.state::<PidMap>().0.lock().unwrap().remove(&task_id);
        send_frame(
            &ch_exit,
            serde_json::json!({ "t": "exit", "code": code }),
        );
    });

    Ok(serde_json::json!({ "id": id, "pid": pid }))
}

/// 列出宿主侧登记的后台任务（WebView 重载后恢复接管用）
#[tauri::command]
fn proc_list(state: tauri::State<'_, SpawnMap>) -> Vec<SpawnedInfo> {
    let mut list: Vec<SpawnedInfo> = state.0.lock().unwrap().values().cloned().collect();
    list.sort_by(|a, b| a.started_ms.cmp(&b.started_ms));
    list
}

/// 本地服务端口探活（TODOS #37）：对 http(s) URL 的 host:port 发起 TCP 连接，
/// 协议无关、不受 WebView CORS 限制。
#[tauri::command]
async fn net_probe(url: String, timeout_ms: Option<u64>) -> Result<bool, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Ok(false);
    }
    let Some(host) = parsed.host_str() else {
        return Ok(false);
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1_600).clamp(100, 5_000));
    let addr = if host.contains(':') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    };
    let ok = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        match addr.to_socket_addrs() {
            Ok(mut addrs) => match addrs.next() {
                Some(a) => std::net::TcpStream::connect_timeout(&a, timeout).is_ok(),
                None => false,
            },
            Err(_) => false,
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(ok)
}

/// 应用退出时终止所有仍在运行的后台任务（树杀整棵进程树，杜绝孤儿端口）
fn kill_all_spawned(app: &AppHandle) {
    let targets: Vec<(String, u32)> = {
        let map = app.state::<SpawnMap>();
        let collected: Vec<(String, u32)> = map
            .0
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.alive)
            .map(|e| (e.id.clone(), e.pid))
            .collect();
        collected
    };
    for (id, pid) in targets {
        // 应用退出属尽力而为清场：单任务失败不阻断其余
        let _ = kill_process(pid);
        if let Some(e) = app.state::<SpawnMap>().0.lock().unwrap().get_mut(&id) {
            e.alive = false;
        }
    }
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

/// 用系统默认浏览器打开 URL（TODOS #44 预览面板「外部浏览器打开」兜底）
#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
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

#[derive(Default)]
struct CloseToTrayState(Mutex<bool>);

#[tauri::command]
fn set_close_to_tray(enabled: bool, state: State<'_, CloseToTrayState>) -> Result<(), String> {
    let mut lock = state.0.lock().map_err(|e| e.to_string())?;
    *lock = enabled;
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
        .manage(SpawnMap::default())
        .manage(HttpAbortMap::default())
        .manage(CloseToTrayState(Mutex::new(true))) // 默认开启关闭最小化到托盘
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出 EasyCode", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            if let Some(icon) = app.default_window_icon() {
                let _ = TrayIconBuilder::with_id("main-tray")
                    .icon(icon.clone())
                    .tooltip("EasyCode")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(w) = tray.app_handle().get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let enabled = window
                    .app_handle()
                    .try_state::<CloseToTrayState>()
                    .and_then(|s| s.0.lock().ok().map(|l| *l))
                    .unwrap_or(true);
                if enabled {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            host_info,
            fs_read,
            fs_write,
            fs_append,
            fs_mkdir,
            fs_readdir,
            fs_stat,
            fs_unlink,
            proc_run,
            proc_kill,
            proc_spawn,
            proc_list,
            net_probe,
            pick_folder,
            open_path,
            open_url,
            open_in_vscode,
            proc_detect_shells,
            send_notification,
            http_stream,
            http_stream_cancel,
            set_close_to_tray
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 应用退出（托盘退出 / 窗口退出）时清场后台任务，杜绝孤儿进程占端口（TODOS #37）
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                kill_all_spawned(app_handle);
            }
        });
}
