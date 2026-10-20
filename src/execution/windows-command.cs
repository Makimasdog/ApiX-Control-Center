using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

// This supervisor joins its private, non-breakaway job before starting any command.
// The only control protocol is its private stdin; worker stdout uses separate pipes.
public static class ApiXCommandJob {
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
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long a,b;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 static readonly object outputLock=new object();
 static void Emit(string text){lock(outputLock){Console.Out.WriteLine(text);Console.Out.Flush();}}
 static string Encode(string text){return Convert.ToBase64String(Encoding.UTF8.GetBytes(text));}
 static uint Active(IntPtr job){IntPtr p=Marshal.AllocHGlobal(48);try{if(!QueryInformationJobObject(job,1,p,48,IntPtr.Zero))throw new Exception("job query failed "+Marshal.GetLastWin32Error());return (uint)Marshal.ReadInt32(p,40);}finally{Marshal.FreeHGlobal(p);}}
 static string Birth(Process p){return p.StartTime.ToUniversalTime().Ticks.ToString();}
 static uint Living(IntPtr job,int self,int exitedPrimary,bool report){
  int size=8+IntPtr.Size*4096;IntPtr p=Marshal.AllocHGlobal(size);
  try{if(!QueryInformationJobObject(job,3,p,(uint)size,IntPtr.Zero))throw new Exception("job process list unconfirmed");uint count=(uint)Marshal.ReadInt32(p,4),alive=1;
   if(count>4096)throw new Exception("job process list exceeds bound");
   for(int i=0;i<count;i++){int pid=IntPtr.Size==8?(int)Marshal.ReadInt64(p,8+i*8):Marshal.ReadInt32(p,8+i*4);if(pid==self||pid==exitedPrimary)continue;
    IntPtr process=OpenProcess(0x00100000|0x1000,false,pid);
    if(process==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)continue;throw new Exception("job member identity unconfirmed");}
    try{uint state=WaitForSingleObject(process,0);if(state==0)continue;if(state!=258)throw new Exception("job member exit unconfirmed");bool member;if(!IsProcessInJob(process,job,out member))throw new Exception("job membership query failed");if(member&&WaitForSingleObject(process,0)==258){alive++;var image=new StringBuilder(1024);int length=1024;QueryFullProcessImageName(process,0,image,ref length);if(report)Emit("member|"+pid+"|"+Encode(System.IO.Path.GetFileName(image.ToString())));}}finally{CloseHandle(process);}
   }return alive;
  }finally{Marshal.FreeHGlobal(p);}
 }
 static string Quote(string arg){var b=new StringBuilder("\"");int slash=0;foreach(char c in arg){if(c=='\\'){slash++;continue;}if(c=='\"')b.Append('\\',slash*2+1);else b.Append('\\',slash);b.Append(c);slash=0;}b.Append('\\',slash*2);return b.Append('"').ToString();}
 static Task Pump(System.IO.Stream input,string channel){return Task.Run(async()=>{byte[] buf=new byte[4096];int n;while((n=await input.ReadAsync(buf,0,buf.Length))>0)Emit("out|"+channel+"|"+Convert.ToBase64String(buf,0,n));});}
 public static void Run(string name,string exe,string[] args,string cwd,int timeout,System.Collections.IDictionary environment){
  IntPtr job=IntPtr.Zero;Process child=null;
  try{
   job=CreateJobObject(IntPtr.Zero,name);if(job==IntPtr.Zero||Marshal.GetLastWin32Error()==183)throw new Exception("job creation refused");
   Extended limits=new Extended();limits.basic.flags=0x2000;int size=Marshal.SizeOf(typeof(Extended));IntPtr p=Marshal.AllocHGlobal(size);
   try{Marshal.StructureToPtr(limits,p,false);if(!SetInformationJobObject(job,9,p,(uint)size))throw new Exception("job limits refused");}finally{Marshal.FreeHGlobal(p);}
   Process self=Process.GetCurrentProcess();if(!AssignProcessToJobObject(job,self.Handle))throw new Exception("job assignment refused "+Marshal.GetLastWin32Error());
   Emit("job|"+self.Id+"|"+Birth(self));
   if(Console.In.ReadLine()!="go")return;
   var start=new ProcessStartInfo(exe);start.Arguments=String.Join(" ",Array.ConvertAll(args,Quote));start.WorkingDirectory=cwd;start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
   start.EnvironmentVariables.Clear();foreach(System.Collections.DictionaryEntry entry in environment)start.EnvironmentVariables[(string)entry.Key]=(string)entry.Value;
   child=Process.Start(start);child.StandardInput.Close();bool member;if(!IsProcessInJob(child.Handle,job,out member)||!member){child.Kill();throw new Exception("worker job membership unconfirmed");}
   // Fast commands can exit before Process.StartTime is readable. Child PIDs never authorize kills;
   // the already-recorded owner birth and private job are the durable containment identity.
   Emit("started|"+child.Id+"|");var outTask=Pump(child.StandardOutput.BaseStream,"stdout");var errTask=Pump(child.StandardError.BaseStream,"stderr");var watch=Stopwatch.StartNew();var control=Task.Run(()=>Console.In.ReadLine());
   while(true){
    if(child.HasExited){
     // A console host or an ordinary child may still be naturally exiting. Allow a fixed,
     // bounded drain, never terminate remaining work and then report it as successful.
     var drain=Stopwatch.StartNew();uint active=Living(job,self.Id,child.Id,false);
     while(active>1&&drain.ElapsedMilliseconds<250){Thread.Sleep(10);active=Living(job,self.Id,child.Id,false);}
     if(active>1)active=Living(job,self.Id,child.Id,true);
     string reason=active==1?"exit":"descendants_remaining";
     if(active==1&&!Task.WaitAll(new Task[]{outTask,errTask},1000))reason="output_cleanup_unknown";
     Emit("end|"+reason+"|"+child.ExitCode+"|"+active);if(reason=="exit")control.Wait(2000);else Thread.Sleep(2000);return;
    }
    if(control.IsCompleted){Emit("end|aborted||"+Active(job));Thread.Sleep(2000);return;}
    if(watch.ElapsedMilliseconds>=timeout){Emit("end|timeout||"+Active(job));Thread.Sleep(2000);return;}
    Thread.Sleep(10);
   }
  }catch(Exception e){Emit("error|"+Encode(e.Message)+"|"+(child==null?"no_worker":"worker"));}
  finally{if(child!=null)child.Dispose();if(job!=IntPtr.Zero)CloseHandle(job);}
 }
 public static void Inspect(string name,bool terminate,int ownerPid,string ownerBirth){
  IntPtr job=OpenJobObject(0x0004|0x0008,false,name);
  if(job==IntPtr.Zero){int code=Marshal.GetLastWin32Error();if(code!=2){Emit("inspect|unknown");return;}try{Process p=Process.GetProcessById(ownerPid);if(ownerBirth==""||Birth(p)==ownerBirth){Emit("inspect|unknown");return;}}catch(ArgumentException){}Emit("inspect|ended");return;}
  try{
   // Never signal an old PID. The random named job is the only termination target.
   try{var p=Process.GetProcessById(ownerPid);if(Birth(p)!=ownerBirth){Emit("inspect|unknown");return;}}catch{Emit("inspect|unknown");return;}
   if(terminate&&!TerminateJobObject(job,137)){Emit("inspect|unknown");return;}
   var clock=Stopwatch.StartNew();do{uint count=Active(job);if(count==0){Emit("inspect|ended");return;}if(!terminate){Emit("inspect|active");return;}Thread.Sleep(10);}while(clock.ElapsedMilliseconds<1000);
   Emit("inspect|unknown");
  }finally{CloseHandle(job);}
 }
}
