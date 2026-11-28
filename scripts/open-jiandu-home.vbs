' Jiandu Home launcher (documentation/DESIGN_PROJECT_HUB.md H3): opens Jiandu Home with no console window.
' If Jiandu already runs, that Jiandu shows its Home (there is one Home per Jiandu); no folder is asked for.
' It replaces the folder dialog of %LOCALAPPDATA%\Jiandu\open-jiandu.vbs; the Desktop and Start menu Jiandu.lnk run that file.
'
' Which install it starts: the one this file sits in (<install>\scripts\open-jiandu-home.vbs), when run from a checkout; else the
' dev checkout under this user's own folder (the file was copied to %LOCALAPPDATA%\Jiandu, where the shortcuts point). No user folder
' is written here, so the same file works on every machine (PR #263 Miguel Y4). A launcher that is in neither place says so.
Option Explicit
Dim fso, here, launcher, ws, install
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
install = ws.ExpandEnvironmentStrings("%USERPROFILE%\VibeCode\claude-custom\dev")
here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
launcher = fso.BuildPath(here, "bin\claude-custom.js")
If Not fso.FileExists(launcher) Then launcher = fso.BuildPath(install, "bin\claude-custom.js")
If Not fso.FileExists(launcher) Then
  MsgBox "Jiandu Home could not start: there is no launcher at " & launcher & ".", vbExclamation, "Jiandu Home"
  WScript.Quit 1
End If
' 0 = no console window; False = do not wait.
ws.Run "node """ & launcher & """ --home", 0, False
