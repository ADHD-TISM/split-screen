@echo off
rem Builds SplitScreen.apk into the split-screen folder. Needs Java 17 and the Android SDK.
cd /d "%~dp0"
rem Java on this PC needs a short folder for its internal pipes, or Gradle fails with
rem "Unable to establish loopback connection".
if not exist "%USERPROFILE%\.gradle\udstmp" mkdir "%USERPROFILE%\.gradle\udstmp"
set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=%USERPROFILE%\.gradle\udstmp
if not exist local.properties echo sdk.dir=%LOCALAPPDATA:\=\\%\\Android\\Sdk> local.properties
call gradlew.bat assembleRelease --no-daemon || (echo Build failed. & pause & exit /b 1)
copy /y app\build\outputs\apk\release\app-release.apk ..\SplitScreen.apk >nul
echo.
echo Built: %~dp0..\SplitScreen.apk
pause
