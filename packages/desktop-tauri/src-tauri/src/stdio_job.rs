//! Windows Stdio 的 Job 生命周期。先挂起创建，加入 Job 后恢复，禁止后代逃离。
use std::{mem::{size_of, zeroed}, os::windows::{io::AsRawHandle, process::CommandExt}, process::{Child, Command}, ptr::null_mut, time::Duration};
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE}, System::{
    Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD},
    JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
    Threading::{OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
}};

pub struct Job(HANDLE);
// Job 句柄由本结构独占；Win32 Job API 允许跨线程调用，关闭由 Entry 的清理锁串行化。
unsafe impl Send for Job {}
unsafe impl Sync for Job {}
impl Drop for Job { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }

impl Job {
    /// PTY 使用无 AutoRun 的 cmd 引导进程；登记 Job 后才允许启动用户 Shell。
    pub fn attach(process: HANDLE) -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(null_mut(), std::ptr::null());
            if handle.is_null() { return Err("创建终端 Job 失败".into()); }
            let job = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
                &info as *const _ as _, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 ||
                AssignProcessToJobObject(handle, process) == 0 {
                return Err("无法将终端引导进程加入 Job".into());
            }
            Ok(job)
        }
    }
    pub fn spawn(command: &mut Command) -> Result<(Child, Self), String> {
        unsafe {
            let handle = CreateJobObjectW(null_mut(), std::ptr::null());
            if handle.is_null() { return Err("创建 Stdio Job 失败".into()); }
            let job = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
                &info as *const _ as _, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
                return Err("配置 Stdio Job 失败".into());
            }
            command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
            let mut child = command.spawn().map_err(|_| "Stdio 启动失败，请检查命令与工作目录")?;
            if AssignProcessToJobObject(handle, child.as_raw_handle()) == 0 {
                let _ = child.kill(); let _ = child.wait();
                return Err("无法将 Stdio 进程加入 Job，已终止启动".into());
            }
            if let Err(error) = resume(child.id()) {
                let _ = job.terminate(); let _ = child.wait(); return Err(error);
            }
            Ok((child, job))
        }
    }

    pub fn terminate(&self) -> Result<(), String> {
        unsafe {
            if TerminateJobObject(self.0, 1) == 0 { return Err("Stdio Job 终止失败，可重试".into()); }
            for _ in 0..150 {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                if QueryInformationJobObject(self.0, JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _, size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, null_mut()) == 0 {
                    return Err("查询 Stdio Job 状态失败".into());
                }
                if info.ActiveProcesses == 0 { return Ok(()); }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err("Stdio Job 后代尚未退出，可重试".into())
        }
    }
}

unsafe fn resume(pid: u32) -> Result<(), String> {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if snapshot == INVALID_HANDLE_VALUE { return Err("枚举 Stdio 启动线程失败".into()); }
    let mut thread: THREADENTRY32 = zeroed();
    thread.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut found = Thread32First(snapshot, &mut thread) != 0;
    let mut resumed = false;
    while found {
        if thread.th32OwnerProcessID == pid {
            let handle = OpenThread(THREAD_SUSPEND_RESUME, 0, thread.th32ThreadID);
            if !handle.is_null() { resumed = ResumeThread(handle) != u32::MAX; CloseHandle(handle); }
            break;
        }
        found = Thread32Next(snapshot, &mut thread) != 0;
    }
    CloseHandle(snapshot);
    if resumed { Ok(()) } else { Err("恢复 Stdio 启动线程失败，已终止 Job".into()) }
}
