using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

// =============================================================================
// windows-command.cs - C# Job Object 监督器：Windows 进程组管理的核心实现
//
// 所属层级：执行层（src/execution/）
// 核心功能：
//   - 创建私有 Windows Job Object，将自身和 worker 进程纳入同一进程组
//   - 通过命名 Job Object（Local\ApiX-Command-<operationId>）实现跨进程身份识别
//   - 两阶段启动协议：先报告自身身份（job 消息），等待 'go' 指令后才启动 worker
//   - 成员追踪：枚举 Job Object 中的所有进程，验证成员身份并报告
//   - 安全终止：通过 TerminateJobObject 一次性终止整个进程组
// 依赖关系：
//   - 被 [→ 见 src/execution/windows-command.ps1] 通过 Add-Type 动态编译加载
//   - 依赖 kernel32.dll 的 Job Object API 实现进程组管理
// =============================================================================

// 监督器使用私有、不可逃逸的 Job Object 来管理进程组，所有命令在启动前必须先加入该 Job。
// 唯一的控制通道是监督器的 stdin；worker 的 stdout/stderr 通过独立管道输出。
public static class ApiXCommandJob {
 // -----------------------------------------------------------------------------
 // P/Invoke 声明：导入 kernel32.dll 中的 Job Object 相关 API
 // -----------------------------------------------------------------------------
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,IntPtr info,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder name,ref int size);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

 // -----------------------------------------------------------------------------
 // Job Object 信息结构体（对应 Windows API 的 JOBOBJECT_* 结构）
 // -----------------------------------------------------------------------------
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long a,b;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}

 /// outputLock - 保护 stdout 输出的线程安全锁，防止并发写入导致消息交错
 static readonly object outputLock=new object();

 /// Emit - 向 stdout 输出一行协议消息（线程安全）
 static void Emit(string text){lock(outputLock){Console.Out.WriteLine(text);Console.Out.Flush();}}

 /// Encode - 将字符串编码为 Base64（用于在协议消息中安全传输二进制/特殊字符数据）
 static string Encode(string text){return Convert.ToBase64String(Encoding.UTF8.GetBytes(text));}

 ///
 /// Active - 查询 Job Object 中当前活跃的进程数量
 /// @param job - Job Object 句柄
 /// @returns 活跃进程数（包含监督进程自身）
 /// 设计意图：以信息类 1 查询 48 字节的基本计数信息，
 ///   按此处结构布局从偏移 40 读取活跃进程计数
 ///
 static uint Active(IntPtr job){IntPtr p=Marshal.AllocHGlobal(48);try{if(!QueryInformationJobObject(job,1,p,48,IntPtr.Zero))throw new Exception("job query failed "+Marshal.GetLastWin32Error());return (uint)Marshal.ReadInt32(p,40);}finally{Marshal.FreeHGlobal(p);}}

 ///
 /// Birth - 获取进程的"出生时间戳"（UTC Ticks），用于唯一标识一个进程实例
 /// @param p - Process 对象
 /// @returns 进程启动时间的 UTC Ticks 字符串表示
 /// 设计意图：PID 可能被操作系统复用，但 PID + StartTime 的组合在合理时间窗口内是唯一的。
 ///   这是防止"向旧进程发送信号"的关键安全机制。
 ///
 static string Birth(Process p){return p.StartTime.ToUniversalTime().Ticks.ToString();}

 ///
 /// Living - 枚举并统计 Job Object 中仍在运行的进程数量
 /// @param job - Job Object 句柄
 /// @param self - 监督进程自身的 PID（统计时排除）
 /// @param exitedPrimary - 已退出的主 worker PID（统计时排除）
 /// @param report - 是否向 stdout 报告成员信息（member 消息）
 /// @returns 活跃进程数（包含监督进程自身，所以 1 表示只有监督进程）
 /// 设计意图：
 ///   - 使用信息类 3 获取进程 ID 列表
 ///   - 对每个 PID 调用 OpenProcess + WaitForSingleObject 检查是否仍在运行
 ///   - 通过 IsProcessInJob 验证进程确实属于本 Job Object（防止 PID 复用误判）
 ///   - report=true 时输出 member|<pid>|<base64_name> 消息，供 Node.js 侧追踪
 ///   - 进程列表上限 4096 个，超出则抛出异常（防止内存溢出）
 ///
 static uint Living(IntPtr job,int self,int exitedPrimary,bool report){
  int size=8+IntPtr.Size*4096;IntPtr p=Marshal.AllocHGlobal(size);
  try{if(!QueryInformationJobObject(job,3,p,(uint)size,IntPtr.Zero))throw new Exception("job process list unconfirmed");uint count=(uint)Marshal.ReadInt32(p,4),alive=1;
   if(count>4096)throw new Exception("job process list exceeds bound");
   for(int i=0;i<count;i++){int pid=IntPtr.Size==8?(int)Marshal.ReadInt64(p,8+i*8):Marshal.ReadInt32(p,8+i*4);if(pid==self||pid==exitedPrimary)continue;
    // 以 0x00100000 | 0x1000 的访问掩码打开进程，用于等待退出和查询身份
    IntPtr process=OpenProcess(0x00100000|0x1000,false,pid);
    if(process==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)continue;throw new Exception("job member identity unconfirmed");}
    try{
     // WaitForSingleObject(handle, 0) 返回 0 = 已退出，258 (WAIT_TIMEOUT) = 仍在运行
     uint state=WaitForSingleObject(process,0);if(state==0)continue;if(state!=258)throw new Exception("job member exit unconfirmed");
     // 二次验证：确认进程确实属于本 Job Object
     bool member;if(!IsProcessInJob(process,job,out member))throw new Exception("job membership query failed");
     if(member&&WaitForSingleObject(process,0)==258){alive++;var image=new StringBuilder(1024);int length=1024;QueryFullProcessImageName(process,0,image,ref length);if(report)Emit("member|"+pid+"|"+Encode(System.IO.Path.GetFileName(image.ToString())));}}finally{CloseHandle(process);}
   }return alive;
  }finally{Marshal.FreeHGlobal(p);}
 }

 ///
 /// Quote - 按 Windows 命令行规则对参数进行引号转义
 /// @param arg - 原始参数
 /// @returns 用双引号包裹的安全参数字符串
 /// 设计意图：实现标准的 MSVC 参数转义规则——反斜杠在双引号前需要加倍，
 ///   双引号本身用 \" 转义，确保参数不会被 cmd.exe 或 CreateProcess 错误解析
 ///
 static string Quote(string arg){var b=new StringBuilder("\"");int slash=0;foreach(char c in arg){if(c=='\\'){slash++;continue;}if(c=='\"')b.Append('\\',slash*2+1);else b.Append('\\',slash);b.Append(c);slash=0;}b.Append('\\',slash*2);return b.Append('"').ToString();}

 ///
 /// Pump - 异步转发流数据为协议消息
 /// @param input - 要读取的流（worker 的 stdout 或 stderr）
 /// @param channel - 通道名称（"stdout" 或 "stderr"）
 /// @returns 异步任务，持续读取直到流关闭
 /// 设计意图：每次读取最多 4096 字节，编码为 Base64 后以 out|<channel>|<base64> 格式输出
 ///
 static Task Pump(System.IO.Stream input,string channel){return Task.Run(async()=>{byte[] buf=new byte[4096];int n;while((n=await input.ReadAsync(buf,0,buf.Length))>0)Emit("out|"+channel+"|"+Convert.ToBase64String(buf,0,n));});}

 ///
 /// Run - 监督执行模式：在 Job Object 内启动并监控一条外部命令
 /// @param name - Job Object 名称（格式：Local\ApiX-Command-<operationId>）
 /// @param exe - 要执行的可执行文件路径
 /// @param args - 命令行参数数组
 /// @param cwd - 工作目录
 /// @param timeout - 超时毫秒数（0 表示不限制）
 /// @param environment - 传递给 worker 的环境变量
 /// 执行流程：
 ///   1. 创建私有 Job Object 并设置限制标志（0x2000 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE）
 ///   2. 将自身（监督进程）加入 Job Object
 ///   3. 输出 job|<pid>|<birth> 消息，通知 Node.js 侧监督进程已就绪
 ///   4. 等待 stdin 收到 'go' 指令（两阶段启动协议）
 ///   5. 启动 worker 进程并验证其已加入 Job Object
 ///   6. 输出 started|<pid>| 消息
 ///   7. 进入主循环：监控 worker 退出、控制指令、超时三种事件
 ///   8. worker 退出后进行 drain 等待（最多 250ms），确保子进程也有时间退出
 ///   9. 输出 end|<reason>|<exitCode>|<active> 消息
 /// 安全要点：
 ///   - Job Object 名称包含随机 UUID，不可被猜测或冲突
 ///   - worker 启动后立即验证 IsProcessInJob，失败则 kill worker 并报错
 ///   - 只有 Job Object 本身是终止目标，PID 不用于终止操作
 ///
 public static void Run(string name,string exe,string[] args,string cwd,int timeout,System.Collections.IDictionary environment){
  IntPtr job=IntPtr.Zero;Process child=null;
  try{
   // 第一步：创建命名 Job Object；错误码 183（ERROR_ALREADY_EXISTS）表示名称冲突
   job=CreateJobObject(IntPtr.Zero,name);if(job==IntPtr.Zero||Marshal.GetLastWin32Error()==183)throw new Exception("job creation refused");
   // 设置 Job Object 限制：JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000)
   // 确保当监督进程退出（Job Object 句柄关闭）时，所有成员进程被自动终止
   Extended limits=new Extended();limits.basic.flags=0x2000;int size=Marshal.SizeOf(typeof(Extended));IntPtr p=Marshal.AllocHGlobal(size);
   try{Marshal.StructureToPtr(limits,p,false);if(!SetInformationJobObject(job,9,p,(uint)size))throw new Exception("job limits refused");}finally{Marshal.FreeHGlobal(p);}
   // 将监督进程自身加入 Job Object（后续 worker 作为子进程会自动继承）
   Process self=Process.GetCurrentProcess();if(!AssignProcessToJobObject(job,self.Handle))throw new Exception("job assignment refused "+Marshal.GetLastWin32Error());
   // 协议消息：报告监督进程身份（PID + 启动时间戳）
   Emit("job|"+self.Id+"|"+Birth(self));
   // 两阶段启动：等待 Node.js 侧发送 'go' 指令后才启动 worker
   // 如果收到其他指令（如 'cancel'），直接返回不启动 worker
   if(Console.In.ReadLine()!="go")return;
   // 构建 worker 进程的启动配置
   var start=new ProcessStartInfo(exe);start.Arguments=String.Join(" ",Array.ConvertAll(args,Quote));start.WorkingDirectory=cwd;start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
   // 清空并设置 worker 的环境变量（使用 Node.js 传入的 env，而非监督进程的环境）
   start.EnvironmentVariables.Clear();foreach(System.Collections.DictionaryEntry entry in environment)start.EnvironmentVariables[(string)entry.Key]=(string)entry.Value;
   // 启动 worker 进程并立即关闭其 stdin（worker 不需要标准输入）
   child=Process.Start(start);child.StandardInput.Close();
   // 安全关键：验证 worker 确实属于本 Job Object，否则立即 kill 并报错
   bool member;if(!IsProcessInJob(child.Handle,job,out member)||!member){child.Kill();throw new Exception("worker job membership unconfirmed");}
   // 快速退出的命令可能在 Process.StartTime 可读之前就已结束。
   // 子进程 PID 永远不用于终止操作；已记录的 owner birth 和私有 Job Object 才是持久的容器身份。
   Emit("started|"+child.Id+"|");
   // 启动异步输出转发任务：将 worker 的 stdout/stderr 转为 out| 协议消息
   var outTask=Pump(child.StandardOutput.BaseStream,"stdout");var errTask=Pump(child.StandardError.BaseStream,"stderr");
   var watch=Stopwatch.StartNew();
   // 异步监听 stdin 控制指令（'cancel' 表示外部取消）
   var control=Task.Run(()=>Console.In.ReadLine());
   // 主循环：每 10ms 检查一次三种终止条件
   while(true){
    if(child.HasExited){
     // worker 已退出，但 Job Object 中可能还有孙进程（worker 创建的子进程）
     // 允许最多 250ms 的 drain 时间让孙进程自然退出
     var drain=Stopwatch.StartNew();uint active=Living(job,self.Id,child.Id,false);
     while(active>1&&drain.ElapsedMilliseconds<250){Thread.Sleep(10);active=Living(job,self.Id,child.Id,false);}
     // drain 后仍有残留进程：报告一次（带 member 消息），然后以 descendants_remaining 原因结束
     if(active>1)active=Living(job,self.Id,child.Id,true);
     string reason=active==1?"exit":"descendants_remaining";
     // 等待输出转发任务完成（最多 1 秒）；超时则报告 output_cleanup_unknown
     if(active==1&&!Task.WaitAll(new Task[]{outTask,errTask},1000))reason="output_cleanup_unknown";
     Emit("end|"+reason+"|"+child.ExitCode+"|"+active);
     // 等待控制指令（exit 原因给 2 秒，其他给固定 2 秒休眠）确保 Node.js 侧有时间处理
     if(reason=="exit")control.Wait(2000);else Thread.Sleep(2000);return;
    }
    // 控制指令到达（'cancel'）：中止命令
    if(control.IsCompleted){Emit("end|aborted||"+Active(job));Thread.Sleep(2000);return;}
    // 超时：执行时间超过设定限制
    if(timeout>0&&watch.ElapsedMilliseconds>=timeout){Emit("end|timeout||"+Active(job));Thread.Sleep(2000);return;}
    Thread.Sleep(10);
   }
  }catch(Exception e){
   // 错误消息：source 为 'no_worker' 表示 worker 未启动，'worker' 表示 worker 相关错误
   Emit("error|"+Encode(e.Message)+"|"+(child==null?"no_worker":"worker"));
  }
  finally{if(child!=null)child.Dispose();if(job!=IntPtr.Zero)CloseHandle(job);}
 }

 ///
 /// Inspect - 检查模式：查询 Job Object 的状态（是否仍有活跃进程）
 /// @param name - Job Object 名称
 /// @param terminate - 是否在检查后终止 Job Object 中的所有进程
 /// @param ownerPid - 监督进程的 PID（用于身份校验）
 /// @param ownerBirth - 监督进程的启动时间戳（防止 PID 复用误判）
 /// 输出协议：
 ///   inspect|ended   - Job Object 不存在或所有进程已退出
 ///   inspect|active  - Job Object 存在且仍有活跃进程（仅非 terminate 模式）
 ///   inspect|unknown - 无法判断状态（如 PID 校验失败、终止超时等）
 /// 安全设计：
 ///   - 绝不向旧 PID 发送信号：通过 Birth() 校验 PID 对应的进程是否仍是原始监督进程
 ///   - 终止目标是 Job Object 本身（而非特定 PID），这是唯一安全的终止方式
 ///   - terminate 模式下等待最多 1 秒确认所有进程退出
 ///
 public static void Inspect(string name,bool terminate,int ownerPid,string ownerBirth){
  // 以 0x0004 | 0x0008 的访问掩码打开已存在的 Job Object，用于查询和终止
  IntPtr job=OpenJobObject(0x0004|0x0008,false,name);
  if(job==IntPtr.Zero){
   int code=Marshal.GetLastWin32Error();
   // 错误码 2（ERROR_FILE_NOT_FOUND）表示 Job Object 不存在
   if(code!=2){Emit("inspect|unknown");return;}
   // Job Object 不存在：检查 ownerPid 对应的进程是否也已退出
   try{Process p=Process.GetProcessById(ownerPid);if(ownerBirth==""||Birth(p)==ownerBirth){Emit("inspect|unknown");return;}}catch(ArgumentException){}
   // PID 不存在或 birth 不匹配 → 进程确已退出
   Emit("inspect|ended");return;
  }
  try{
   // 绝不向旧 PID 发送信号：随机命名的 Job Object 是唯一的终止目标
   try{var p=Process.GetProcessById(ownerPid);if(Birth(p)!=ownerBirth){Emit("inspect|unknown");return;}}catch{Emit("inspect|unknown");return;}
   // terminate=true 时终止 Job Object 中的所有进程（退出码 137 = SIGKILL 惯例）
   if(terminate&&!TerminateJobObject(job,137)){Emit("inspect|unknown");return;}
   // 等待并轮询：terminate 模式下等待最多 1 秒确认进程全部退出；非 terminate 模式立即返回状态
   var clock=Stopwatch.StartNew();do{uint count=Active(job);if(count==0){Emit("inspect|ended");return;}if(!terminate){Emit("inspect|active");return;}Thread.Sleep(10);}while(clock.ElapsedMilliseconds<1000);
   // 1 秒后仍有进程存活 → 状态未知
   Emit("inspect|unknown");
  }finally{CloseHandle(job);}
 }
}
