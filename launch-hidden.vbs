' Launch start-companion.bat with no console window.
' wscript.exe is a GUI-subsystem app, so nothing flashes.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & dir & "\start-companion.bat"" /hidden", 0, False
