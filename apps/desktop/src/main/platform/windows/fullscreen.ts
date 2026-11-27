import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Rectangle } from 'electron'

// 只读取前台窗口的几何范围，不读取窗口标题或内容。
const probe = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundFullscreen {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct Monitor { public int Size; public Rect Area,Work; public int Flags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr monitor, ref Monitor info);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static string Read(uint own) {
    var hwnd=GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(hwnd,out pid);
    if(hwnd==IntPtr.Zero || pid==own) return "-";
    Rect r;
    var m=new Monitor { Size=Marshal.SizeOf(typeof(Monitor)) };
    if(!GetWindowRect(hwnd,out r) || !GetMonitorInfo(MonitorFromWindow(hwnd,2),ref m)) return "-";
    var a=m.Area;
    if(Math.Abs(r.L-a.L)>2 || Math.Abs(r.T-a.T)>2 || Math.Abs(r.R-a.R)>2 || Math.Abs(r.B-a.B)>2) return "-";
    return String.Join(",",a.L,a.T,a.R-a.L,a.B-a.T);
  }
}
'@
[void][ForegroundFullscreen]::SetThreadDpiAwarenessContext([IntPtr](-4))
$previous = ''
while ($true) {
  $next = [ForegroundFullscreen]::Read(OWNER_PID)
  if ($next -ne $previous) { [Console]::WriteLine($next); $previous = $next }
  Start-Sleep -Milliseconds 160
}
`

export function watchWindowsFullscreen(onChange: (bounds?: Rectangle) => void) {
  const command = Buffer.from(probe.replace('OWNER_PID', String(process.pid)), 'utf16le').toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const [x, y, width, height] = line.split(',').map(Number)
    if (x === undefined || y === undefined || width === undefined || height === undefined ||
      ![x, y, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0) onChange()
    else onChange({ x, y, width, height })
  })
  child.on('error', () => onChange())
  child.on('exit', () => onChange())
  return () => {
    lines.close()
    child.kill()
  }
}
