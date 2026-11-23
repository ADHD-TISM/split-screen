@echo off
title Split Screen
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
set OPEN_BROWSER=1
node server.js
pause
