[CmdletBinding()]
param(
    [ValidateRange(100,3000)][int]$TimeoutMs = 1000,
    [switch]$IncludeConsole,
    [switch]$DefinitionsOnly
)
$ErrorActionPreference = 'Stop'
# Bounded initial notifications only. No window, message pump, input, display
# wake request, execution-state change or power-setting modification is used.
if (-not ('EgoDisplayPowerRead' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class EgoDisplayPowerRead {
 [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate uint PowerCallback(IntPtr context,uint type,IntPtr setting);
 [StructLayout(LayoutKind.Sequential)] struct Subscription { public IntPtr callback,context; }
 [DllImport("powrprof.dll")] static extern uint PowerSettingRegisterNotification(ref Guid setting,uint flags,IntPtr recipient,out IntPtr registration);
 [DllImport("powrprof.dll")] static extern uint PowerSettingUnregisterNotification(IntPtr registration);
 sealed class Observation {
  public Guid guid;
  public int value=-1,callbacks=0,invalid=0;
  public long utcTicks=0;
  public PowerCallback callback;
  public IntPtr subscription;
 }
 // These bounded diagnostics permit at most eight registrations. Keep the
 // delegate/subscription storage rooted until process exit, even after unregister,
 // so an in-flight native callback can never outlive its managed function pointer.
 static readonly List<Observation> Roots=new List<Observation>();
 static int observations=0;
 public static object Read(string name,string setting,int timeoutMs) {return Observe(name,setting,timeoutMs,false);}
 public static object WaitForOn(string name,string setting,int timeoutMs) {return Observe(name,setting,timeoutMs,true);}
 static object Observe(string name,string setting,int timeoutMs,bool waitForOn) {
  if(timeoutMs<100||timeoutMs>3000||Interlocked.Increment(ref observations)>8)throw new ArgumentOutOfRangeException("timeoutMs");
  var item=new Observation{guid=new Guid(setting)};
  item.callback=delegate(IntPtr context,uint type,IntPtr data) {
   try {
    Interlocked.Increment(ref item.callbacks);
    if(type!=0x8013||data==IntPtr.Zero||(Guid)Marshal.PtrToStructure(data,typeof(Guid))!=item.guid||Marshal.ReadInt32(data,16)!=4){Interlocked.Increment(ref item.invalid);return 0;}
    int value=Marshal.ReadInt32(data,20);
    if(value<0||value>2){Interlocked.Increment(ref item.invalid);return 0;}
    Interlocked.Exchange(ref item.utcTicks,DateTime.UtcNow.Ticks);
    Interlocked.Exchange(ref item.value,value);
   } catch {Interlocked.Increment(ref item.invalid);}
   return 0;
  };
  var subscription=new Subscription{callback=Marshal.GetFunctionPointerForDelegate(item.callback),context=IntPtr.Zero};
  item.subscription=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Subscription)));
  Marshal.StructureToPtr(subscription,item.subscription,false);
  lock(Roots)Roots.Add(item);
  IntPtr registration=IntPtr.Zero;uint registrationStatus=UInt32.MaxValue,unregisterStatus=UInt32.MaxValue;
  var started=DateTime.UtcNow;var until=Environment.TickCount+timeoutMs;
  try {
   registrationStatus=PowerSettingRegisterNotification(ref item.guid,2,item.subscription,out registration);
   while(registrationStatus==0&&(waitForOn?Volatile.Read(ref item.value)!=1:Volatile.Read(ref item.value)<0)&&unchecked(Environment.TickCount-until)<0)Thread.Sleep(10);
  } finally {
   if(registration!=IntPtr.Zero)unregisterStatus=PowerSettingUnregisterNotification(registration);
   GC.KeepAlive(item.callback);
  }
  int current=Volatile.Read(ref item.value);long ticks=Interlocked.Read(ref item.utcTicks);
  return new Dictionary<string,object>{{"name",name},{"guid",setting},{"scope","Initial read-only power notification; no wake or settings change."},{"startedAt",started.ToString("o")},{"finishedAt",DateTime.UtcNow.ToString("o")},{"timeoutMs",timeoutMs},{"registerStatus",registrationStatus},{"unregisterStatus",registration!=IntPtr.Zero?(object)unregisterStatus:null},{"initialNotificationReceived",current>=0},{"state",current>=0?(object)current:null},{"stateName",current==0?"off":current==1?"on":current==2?"dim":"unknown"},{"observedAt",ticks!=0?new DateTime(ticks,DateTimeKind.Utc).ToString("o"):null},{"callbackCount",Volatile.Read(ref item.callbacks)},{"invalidCallbackCount",Volatile.Read(ref item.invalid)}};
 }
}
'@
}
if ($DefinitionsOnly) { return }
$Result = [ordered]@{
    schemaVersion = 1
    capturedAt = [DateTime]::UtcNow.ToString('o')
    collectorPid = $PID
    collectorSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
    sessionDisplay = [EgoDisplayPowerRead]::Read('session-display', '2b84c20e-ad23-4ddf-93db-05ffbd7efca5', $TimeoutMs)
}
if ($IncludeConsole) {
    $Result.consoleDisplay = [EgoDisplayPowerRead]::Read('console-display', '6fe69556-704a-47a0-8f24-c28d936fda47', $TimeoutMs)
}
$Result | ConvertTo-Json -Depth 8
