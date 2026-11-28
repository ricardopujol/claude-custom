' Jiandu Home launcher (documentation/DESIGN_PROJECT_HUB.md H3): opens Jiandu Home with no console window.
' If Jiandu already runs, that Jiandu shows its Home (there is one Home per Jiandu); no folder is asked for.
' It replaces the folder dialog of %LOCALAPPDATA%\Jiandu\open-jiandu.vbs; the Desktop and Start menu Jiandu.lnk run that file.
'
' Which install it starts: the one this file sits in (<install>\scripts\open-jiandu-home.vbs), when run from a checkout; else the
' INSTALL below (the file was copied to %LOCALAPPDATA%\Jiandu, where the shortcuts point).
Option Explicit
Const INSTALL = "C:\Users\Ricardo Pujol\VibeCode\claude-custom\dev"
Dim fso, here, launcher, ws
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
launcher = fso.BuildPath(here, "bin\claude-custom.js")
If Not fso.FileExists(launcher) Then launcher = fso.BuildPath(INSTALL, "bin\claude-custom.js")
Set ws = CreateObject("WScript.Shell")
' 0 = no console window; False = do not wait.
ws.Run "node """ & launcher & """ --home", 0, False
