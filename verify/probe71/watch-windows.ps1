# Watches the visible top-level windows of one process tree and closes every one that appears (BACKLOG #71, PR #122 Dexter R2-1 / R2-3).
#
#   powershell -NoProfile -File watch-windows.ps1 -Root <pid> -Log <file> -Stop <file>
#
# A native dialog the panel raises (a print dialog, a file chooser, a colour picker, a message box) is a visible top-level window owned by the
# probe's own Electron tree. The probe's main window is show:false and the panels are child views, so the tree has NO visible top-level window
# of its own: anything seen here is a dialog. Each new window is logged as one JSON line (epoch ms, handle, pid, class, title) and closed by its
# HANDLE (WM_CLOSE, re-sent while it stays up), so a dialog can never hang the run. Nothing is ever stopped by process name or id.
# Exits when the -Stop file exists or the root process is gone.
param(
  [Parameter(Mandatory = $true)][int]$Root,
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$Stop,
  [string]$Arm = "",   # until this file exists, every visible window is the BASELINE (the probe's own shown owner window): noted, never closed
  [switch]$All   # diagnostic: also log (never close) windows that are not visible
)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProbeWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string[]> Visible(HashSet<uint> pids, bool all) {
    var found = new List<string[]>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && (all || IsWindowVisible(h))) {
        var t = new StringBuilder(256); var c = new StringBuilder(256);
        GetWindowText(h, t, 256); GetClassName(h, c, 256);
        found.Add(new string[] { h.ToInt64().ToString(), pid.ToString(), c.ToString(), t.ToString(), IsWindowVisible(h) ? "1" : "0" });
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Close(long h) { PostMessage((IntPtr)h, 0x10, IntPtr.Zero, IntPtr.Zero); }
}
"@

function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  [void]$set.Add([uint32]$rootPid)
  do {
    $grew = $false
    foreach ($p in $all) { if ($set.Contains([uint32]$p.ParentProcessId) -and $set.Add([uint32]$p.ProcessId)) { $grew = $true } }
  } while ($grew)
  return , $set
}

$seen = @{}
$base = @{}

while (-not (Test-Path -LiteralPath $Stop)) {
  if (-not (Get-Process -Id $Root -ErrorAction SilentlyContinue)) { break }
  $tree = Get-Tree $Root
  $armed = ($Arm -eq '') -or (Test-Path -LiteralPath $Arm)
  foreach ($w in [ProbeWin]::Visible($tree, [bool]$All)) {
    if (-not $armed) { $base[$w[0]] = $true; continue }
    if ($base.ContainsKey($w[0])) { continue }
    if (-not $seen.ContainsKey($w[0])) {
      $seen[$w[0]] = $true
      $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $line = @{ t = $ms; hwnd = $w[0]; pid = [int]$w[1]; cls = $w[2]; title = $w[3]; visible = ($w[4] -eq "1") } | ConvertTo-Json -Compress
      Add-Content -LiteralPath $Log -Value $line
    }
    if ($w[4] -eq "1") { [ProbeWin]::Close([int64]$w[0]) }
  }
  Start-Sleep -Milliseconds 100
}
