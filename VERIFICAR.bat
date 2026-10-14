@echo off
chcp 65001 >nul
setlocal
REM Comprueba que todos los archivos del modpack se puedan descargar.
call "%~dp0axol-config.bat"
node "%~dp0verificar-urls.js" %*
echo.
pause
