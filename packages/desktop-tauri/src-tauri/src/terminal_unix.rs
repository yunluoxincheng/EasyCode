//! 调用方必须持有尚未 wait/reap 的 Child；该 PID 在清理完成前不会被系统复用。
use std::{collections::HashSet, process::Command, time::Duration};

pub fn observe_exit(pid: u32) -> Result<Option<u32>, String> {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
            return Ok(Some(unsafe { if info.si_code == libc::CLD_EXITED { info.si_status() as u32 }
                else { 128 + info.si_status() as u32 } }));
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err("无法观察终端退出且保留进程身份".into());
        }
    }
}

fn groups(pid: u32) -> Result<HashSet<i32>, String> {
    let output = Command::new("ps").args(["-ax", "-o", "pid=,stat="])
        .env("COLUMNS", "120").env("LINES", "40").output().map_err(|_| "查询终端会话失败")?;
    if !output.status.success() { return Err("查询终端会话失败".into()); }
    let mut groups = HashSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let member = match fields.next().and_then(|s| s.parse::<i32>().ok()) { Some(p) if p > 0 => p, _ => continue };
        if fields.next().map_or(true, |state| state.starts_with('Z')) { continue; }
        let session = unsafe { libc::getsid(member) };
        if session == -1 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { continue; }
            return Err("无法确认终端会话成员".into());
        }
        if session == pid as i32 {
            let group = unsafe { libc::getpgid(member) };
            if group > 0 { groups.insert(group); }
            else if std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) { return Err("无法确认终端作业组".into()); }
        }
    }
    Ok(groups)
}

fn signal(group: i32, value: i32) -> Result<(), String> {
    if group <= 1 { return Err("拒绝向系统或广播目标发送终端信号".into()); }
    if unsafe { libc::kill(-group, value) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { Ok(()) }
    else { Err("终端作业组结束失败，可重试".into()) }
}

fn empty(pid: u32) -> Result<bool, String> {
    for _ in 0..30 {
        if groups(pid)?.is_empty() { return Ok(true); }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(false)
}

pub fn close_session(pid: u32) -> Result<(), String> {
    for group in groups(pid)? { signal(group, libc::SIGTERM)?; }
    if empty(pid)? { return Ok(()); }
    for group in groups(pid)? { signal(group, libc::SIGKILL)?; }
    if empty(pid)? { Ok(()) } else { Err("终端会话仍有存活作业，可重试".into()) }
}
