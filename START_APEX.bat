@echo off
title APEX server
cd /d "%~dp0"
echo.
echo ===== APEX INTELLIGENCE =====
echo.

echo %~dp0 | findstr /i "\\Temp\\" >nul
if not errorlevel 1 (
  echo [PROBLEM] You are running this from INSIDE the zip file.
  echo Close this window, right-click the zip, choose "Extract All", then open the extracted folder and run START_APEX.bat again.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [PROBLEM] Node.js is not installed.
  echo Install the LTS version from https://nodejs.org/ , restart the computer, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [PROBLEM] The .env file does not exist yet.
  echo Double-click SETUP_KEY.bat first, paste your key, then run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting server... keep this window OPEN.
echo Open Chrome and type exactly:  http://localhost:3000
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
echo.
echo Server stopped. Scroll up to read any error message.
pause
