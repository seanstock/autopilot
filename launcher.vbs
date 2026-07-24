' Autopilot launcher: starts the daemon (if down) and opens the UI, with no
' console window flash. Point Desktop / Start Menu shortcuts at this file.
' Self-locating: works from wherever the repo is checked out.
Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run """node.exe"" """ & here & "\autopilot.js""", 0, False
