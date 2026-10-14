@echo off
chcp 65001 >nul
setlocal
REM ==========================================================================
REM  CREAR UN MODPACK NUEVO (se hace una sola vez por modpack)
REM ==========================================================================
call "%~dp0axol-config.bat"

echo.
echo  ID del modpack: minusculas y guiones, sin espacios ni acentos.
echo  Ejemplos: voragos-2   fuente-del-azar   skyblock-axol
set /p "ID=ID del modpack: "
set /p "MC=Version de Minecraft (ej: 1.21.1): "
set /p "LOADER=Loader (escribe fabric o forge): "
set /p "LV=Version del loader (Enter = latest): "
if "%LV%"=="" set "LV=latest"

pushd "%NEBULA_DIR%" || (echo No encuentro Nebula en %NEBULA_DIR% & pause & exit /b 1)
call npm run start -- g server %ID% %MC% --%LOADER% %LV%
set "ERR=%errorlevel%"
popd
if not "%ERR%"=="0" (
    echo ERROR: Nebula no pudo crear el modpack.
    pause
    exit /b 1
)

mkdir "%~dp0servers\%ID%-%MC%\branding" 2>nul
echo.
echo ===========================================================
echo  Modpack creado en: servers\%ID%-%MC%
echo.
echo  Ahora:
echo   1. Pon los .jar en  servers\%ID%-%MC%\%LOADER%mods\required
echo   2. Pon icono.png    en servers\%ID%-%MC%\
echo   3. Pon logo.png y fondo.jpg en servers\%ID%-%MC%\branding\
echo   4. Edita servers\%ID%-%MC%\servermeta.json (nombre, descripcion)
echo   5. Ejecuta publicar.bat
echo ===========================================================
start "" "%~dp0servers\%ID%-%MC%"
pause
