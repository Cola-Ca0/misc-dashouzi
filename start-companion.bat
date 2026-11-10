@echo off
rem ASCII only + CRLF: cmd.exe misparses LF-only batch files.
rem Run with no console window; relaunch hidden unless already hidden.
if /i "%~1"=="/hidden" goto main
wscript //nologo "%~dp0launch-hidden.vbs"
exit /b

:main
setlocal
cd /d "%~dp0"

rem bundled Windows tools live next to this folder (bkcrack, steghide)
set "PATH=%~dp0..;%~dp0..\steghide;%PATH%"

where python >nul 2>nul
if errorlevel 1 goto nopython

if exist "companion-token.txt" goto havetoken
python -c "import secrets,pathlib;pathlib.Path('companion-token.txt').write_text(secrets.token_urlsafe(24),encoding='utf-8')"

:havetoken
set /p TOKEN=<companion-token.txt
if "%TOKEN%"=="" goto notoken

echo %TOKEN%| clip >nul 2>nul

rem A bare "C:\path\file.html#frag" makes start look for a file literally
rem named that; it must be a file:// URL for the fragment to survive.
set "PAGE=%~dp0misc-dashouzi.html"
set "PAGE=%PAGE:\=/%"

start "" "file:///%PAGE%#t=%TOKEN%"
rem The page pings every 20s and sends /api/bye on unload, so the server
rem follows the browser's lifetime. The idle limit is only a crash net.
python companion.py --token-file companion-token.txt --exit-when-idle 120 > "%~dp0companion.log" 2>&1
exit /b 0

:notoken
python companion.py --exit-when-idle 120 > "%~dp0companion.log" 2>&1
exit /b 0

:nopython
rem nothing visible to print to, so open a console for this one case
start "" cmd /c "echo python not found in PATH & echo install Python 3 and add it to PATH & pause"
exit /b 1
