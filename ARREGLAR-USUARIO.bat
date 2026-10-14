@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0arreglar-usuario.ps1"
if errorlevel 1 pause
