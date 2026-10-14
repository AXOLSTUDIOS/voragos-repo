@echo off
chcp 65001 >nul
setlocal
REM ==========================================================================
REM  ANALIZAR MODS
REM  Doble clic: analiza la carpeta de mods de Voragos 2.
REM  O arrastra cualquier carpeta de mods encima de este archivo.
REM ==========================================================================
where node >nul 2>nul || for /d %%D in ("%~d0\AxolDev\tools\node-v*") do set "PATH=%%D;%PATH%"
where node >nul 2>nul || (
    echo No encuentro Node.js. Ejecuta primero INSTALAR.bat del kit.
    pause
    exit /b 1
)
node "%~dp0analizar-mods.js" %*
echo.
pause
