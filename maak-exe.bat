@echo off
echo =========================================
echo  Logitech AV Tester - .exe bouwen
echo =========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo FOUT: Node.js niet gevonden. Installeer via https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Dependencies installeren...
call npm install
if %errorlevel% neq 0 (
  echo FOUT bij npm install
  pause
  exit /b 1
)

echo.
echo [2/3] .exe bouwen (portable)...
call npx electron-builder --win portable
if %errorlevel% neq 0 (
  echo FOUT bij bouwen
  pause
  exit /b 1
)

echo.
echo [3/3] Klaar!
echo De .exe staat in de map: dist\
echo.
explorer dist
pause
