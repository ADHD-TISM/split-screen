@echo off
rem Builds SplitScreen.exe in this folder. Needs Node.js 20.12 or later (22 or 24 LTS recommended).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules\postject call npm ci || (echo npm ci failed. & pause & exit /b 1)
if not exist node_modules\resedit call npm ci || (echo npm ci failed. & pause & exit /b 1)
node build-exe.mjs || (echo Build failed. & pause & exit /b 1)
pause
