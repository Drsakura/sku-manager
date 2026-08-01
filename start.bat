@echo off
rem sku-manager 启动入口(自动更新相关)
cd /d "%~dp0"
node scripts\launch.js
if errorlevel 1 pause
