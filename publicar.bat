@echo off
chcp 65001 >nul
setlocal
REM ==========================================================================
REM  PUBLICAR CAMBIOS DE LOS MODPACKS
REM  1) Nebula escanea servers\ y genera distribution.json (con hashes MD5).
REM  2) Los .jar se suben al Release "mods" de GitHub (solo los nuevos o cambiados).
REM  3) distribution.json, configs e imagenes se suben a GitHub Pages.
REM  Los launchers de los jugadores detectan el cambio y muestran ACTUALIZAR.
REM ==========================================================================
call "%~dp0axol-config.bat"
node "%~dp0publicar-mods.js"
echo.
pause
