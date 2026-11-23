# Split Screen tray icon. Started by server.js in tray mode (SplitScreen.exe).
# Values come from environment variables, never from text pasted into this script:
#   SPLITSCREEN_PORT, SPLITSCREEN_PID, SPLITSCREEN_EXE, SPLITSCREEN_LOG,
#   SPLITSCREEN_AUTOSTART (1 = offer Start with Windows), SPLITSCREEN_QUIET (1 = no start balloon)
# Exit codes (server.js depends on them):
#   10 = the user chose Quit Split Screen: Split Screen stops.
#   3  = setup failed (blocked PowerShell, missing WinForms): Split Screen keeps running.
#   0  = Split Screen told the tray to close (its stdin ended), or Split Screen is gone.

# Setup: stop at the 1st error, so a broken tray reports failure instead of exiting 0.
$ProgressPreference = 'SilentlyContinue'   # keep stderr plain text (no progress records)
# UTF-8 output, so a reason in another language reaches splitscreen.log intact. Refused on a
# locked-down PC; the reason then may lose accented letters, which is acceptable.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try {
  $ErrorActionPreference = 'Stop'
  $Port    = [int]$env:SPLITSCREEN_PORT
  $NodePid = [int]$env:SPLITSCREEN_PID
  $ExePath = $env:SPLITSCREEN_EXE
  $LogPath = $env:SPLITSCREEN_LOG
  $control = "http://127.0.0.1:$Port/"
  $node = Get-Process -Id $NodePid
  [void]$node.Handle   # opens and keeps a handle, so a reused PID cannot fool HasExited below

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $icon = New-Object System.Windows.Forms.NotifyIcon
  try { $icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($ExePath) }
  catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
  $icon.Text = "Split Screen - port $Port"

  # The TV address, read live from Split Screen (the PC's address can change after sleep).
  function Get-TvUrl {
    try {
      $info = Invoke-RestMethod -Uri "${control}api/info" -TimeoutSec 2
      if ($info.ips -and $info.ips.Count -gt 0) { return "http://$($info.ips[0]):$($info.port)/tv" }
    } catch { }
    return "http://<PC address>:$Port/tv"
  }

  # A double-click sends 2 clicks: open the page only once per second.
  $script:lastOpen = [DateTime]::MinValue
  function Open-Control {
    if (([DateTime]::Now - $script:lastOpen).TotalMilliseconds -lt 1000) { return }
    $script:lastOpen = [DateTime]::Now
    Start-Process $control
  }

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $open = $menu.Items.Add('Open control page')
  $open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
  $open.add_Click({ Open-Control })
  $copy = $menu.Items.Add('Copy TV address')
  $copy.add_Click({
    $url = Get-TvUrl
    try {
      [System.Windows.Forms.Clipboard]::SetText($url)
      $icon.ShowBalloonTip(3000, 'Split Screen', "Copied: $url", [System.Windows.Forms.ToolTipIcon]::Info)
    } catch {
      $icon.ShowBalloonTip(5000, 'Split Screen', "Could not copy. The TV address is: $url", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
  })
  $log = $menu.Items.Add('Show log')
  $log.add_Click({ Start-Process notepad.exe -ArgumentList "`"$LogPath`"" })

  # Start with Windows: a value in this user's Run key (no admin rights needed). Windows
  # then starts SplitScreen.exe at sign-in with --startup, which skips opening the browser.
  # Offered only for SplitScreen.exe (SPLITSCREEN_AUTOSTART=1), not for `node server.js`.
  # >>> autostart
  if ($env:SPLITSCREEN_AUTOSTART -eq '1') {
    $script:runKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    # Task Manager > Startup apps keeps its own on/off switch here (1st byte odd = disabled).
    $script:saKey   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
    $script:runName = 'Split Screen'
    $script:runCmd  = '"' + $ExePath + '" --startup'
    function Get-RunValue {
      try { return (Get-ItemProperty -Path $script:runKey -Name $script:runName -ErrorAction Stop).($script:runName) }
      catch { return $null }
    }
    function Test-DisabledInTaskManager {
      try {
        $b = (Get-ItemProperty -Path $script:saKey -Name $script:runName -ErrorAction Stop).($script:runName)
        return ($b -and $b.Count -gt 0 -and ($b[0] % 2) -eq 1)
      } catch { return $false }   # no switch value: enabled
    }
    # On = Windows will really start it: the Run value exists and Task Manager has not disabled it.
    function Get-Autostart { return [bool](Get-RunValue) -and -not (Test-DisabledInTaskManager) }

    # SplitScreen.exe was moved (the old file is gone): point the entry at its new place.
    # Another copy started from elsewhere leaves the entry alone.
    # Guarded as a whole: a hand-edited value with characters like | < > makes Test-Path
    # throw, which must not stop the tray from starting.
    try {
      $current = Get-RunValue
      if ($current -and $current -ne $script:runCmd -and $current -match '^"([^"]+)"' -and -not (Test-Path -LiteralPath $Matches[1])) {
        Set-ItemProperty -Path $script:runKey -Name $script:runName -Value $script:runCmd
      }
    } catch { }

    $auto = $menu.Items.Add('Start with Windows')
    $menu.add_Opening({ $auto.Checked = Get-Autostart })
    $auto.add_Click({
      try {
        if (Get-Autostart) {
          Remove-ItemProperty -Path $script:runKey -Name $script:runName -ErrorAction Stop
          Remove-ItemProperty -Path $script:saKey -Name $script:runName -ErrorAction SilentlyContinue
          $icon.ShowBalloonTip(3000, 'Split Screen', 'Split Screen will no longer start with Windows.', [System.Windows.Forms.ToolTipIcon]::Info)
        } else {
          Set-ItemProperty -Path $script:runKey -Name $script:runName -Value $script:runCmd -ErrorAction Stop
          # Turning it on here is the latest choice: clear a Task Manager disable too.
          Remove-ItemProperty -Path $script:saKey -Name $script:runName -ErrorAction SilentlyContinue
          $icon.ShowBalloonTip(3000, 'Split Screen', 'Split Screen will start in the tray when you sign in to Windows.', [System.Windows.Forms.ToolTipIcon]::Info)
        }
      } catch {
        $icon.ShowBalloonTip(5000, 'Split Screen', "Could not change Start with Windows: $($_.Exception.Message)", [System.Windows.Forms.ToolTipIcon]::Warning)
      }
    })
  }
  # <<< autostart
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $quit = $menu.Items.Add('Quit Split Screen')
  $quit.add_Click({ $script:exitCode = 10; [System.Windows.Forms.Application]::Exit() })
  $icon.ContextMenuStrip = $menu
  $icon.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Control } })

  # Split Screen closes our stdin when it stops (Stop Split Screen, an error): then remove the icon.
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object byte[] 1
  $script:stdinRead = $stdin.ReadAsync($buffer, 0, 1)

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 500
  $timer.add_Tick({
    if ($script:stdinRead.IsCompleted -or $node.HasExited) { [System.Windows.Forms.Application]::Exit() }
  })

  $icon.Visible = $true
  # No balloon when Windows started Split Screen at sign-in (the network may not even be up yet).
  if ($env:SPLITSCREEN_QUIET -ne '1') {
    $icon.ShowBalloonTip(5000, 'Split Screen is running',
      "On the TV: $(Get-TvUrl)`nRight-click this icon to quit.", [System.Windows.Forms.ToolTipIcon]::Info)
  }
  $timer.Start()
} catch {
  # Tell Split Screen why (it writes this to splitscreen.log), and leave no icon behind.
  # Only cmdlets and plain strings here: they also work on a locked-down PC
  # (Constrained Language Mode), where .NET method calls are refused.
  $ErrorActionPreference = 'Continue'
  Write-Output ('Tray setup failed: ' + $_)   # plain text on stdout
  if ($icon) { try { $icon.Visible = $false; $icon.Dispose() } catch { } }
  exit 3
}

# Running: an error inside a click must not end the tray or show a .NET error dialog.
$ErrorActionPreference = 'Continue'
$script:exitCode = 0
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$icon.Visible = $false
$icon.Dispose()
exit $script:exitCode
