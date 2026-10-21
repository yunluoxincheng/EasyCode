import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import crossSpawn from 'cross-spawn';

// 常驻监督进程仅持有 Job 和原始标准句柄，不解析/转码服务流。
// 子进程以 suspended 创建，加入禁止 breakaway 的 Job 后才运行，消除启动器抢先退出的窗口。
const SUPERVISOR = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EasyCodeStdioJob {
 [StructLayout(LayoutKind.Sequential)] struct Limits { public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong R1,R2,R3,R4,R5,R6; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr Reserved2,Input,Output,Error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended info,uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 public static void Run(string command,uint ownerPid) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null); ProcessInfo pi=new ProcessInfo();
  if(job==IntPtr.Zero) throw new Exception();
  IntPtr owner=IntPtr.Zero;
  try {
   owner=OpenProcess(0x00100000,false,ownerPid); if(owner==IntPtr.Zero) throw new Exception();
   var limits=new Extended(); limits.Basic.Flags=0x2000;
   if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Exception();
   var si=new Startup(); si.Size=(uint)Marshal.SizeOf(si); si.Flags=0x100;
   si.Input=GetStdHandle(-10); si.Output=GetStdHandle(-11); si.Error=GetStdHandle(-12);
   if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref si,out pi)) throw new Exception();
   if(!AssignProcessToJobObject(job,pi.Process) || ResumeThread(pi.Thread)==0xffffffff) { TerminateProcess(pi.Process,1); throw new Exception(); }
   while(true) {
    uint ownerState=WaitForSingleObject(owner,0);
    if(ownerState==0) break;
    if(ownerState==0xffffffff) throw new Exception();
    Accounting info;
    if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Exception();
    if(info.Active==0) break;
    System.Threading.Thread.Sleep(25);
   }
  } finally {
   if(owner!=IntPtr.Zero) CloseHandle(owner);
   if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread);
   if(pi.Process!=IntPtr.Zero) CloseHandle(pi.Process);
   CloseHandle(job);
  }
 }
}
'@
$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__EASYCODE_COMMAND__'))
[EasyCodeStdioJob]::Run($command,__EASYCODE_OWNER__)
exit 0
} catch { exit 1 }
`;

function quote(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function spawnWindowsJob(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
  // cross-spawn 7 的现有解析器保留 npx.cmd / shebang 与转义语义；不把用户命令拼进 PowerShell 源码。
  const parse = (crossSpawn as typeof crossSpawn & { _parse: (command: string, args: string[], options: SpawnOptionsWithoutStdio) =>
    { command: string; args: string[]; options: SpawnOptionsWithoutStdio } })._parse;
  const parsed = parse(command, args, options);
  const line = [quote(parsed.command), ...parsed.args.map((arg) => parsed.options.windowsVerbatimArguments ? arg : quote(arg))].join(' ');
  const script = SUPERVISOR.replace('__EASYCODE_COMMAND__', Buffer.from(line, 'utf8').toString('base64'))
    .replace('__EASYCODE_OWNER__', String(process.pid));
  return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
  });
}
