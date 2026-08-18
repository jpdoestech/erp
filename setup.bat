@echo off
setlocal enabledelayedexpansion
title ERP Payroll - Setup

echo ============================================
echo  ERP Payroll (Phase 1) - Setup
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on this machine.
    echo Please install Node.js LTS from https://nodejs.org and re-run this file.
    echo.
    pause
    exit /b 1
)

echo Node.js found:
node -v
npm -v
echo.

echo Installing dependencies (this can take a minute)...
call npm install
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. See the messages above.
    pause
    exit /b 1
)
echo.

echo Seeding demo data (companies, users, employees)...
call npm run seed
if errorlevel 1 (
    echo.
    echo [ERROR] Seeding failed. See the messages above.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Setup complete.
echo  Run "run.bat" to start the application.
echo ============================================
echo.
pause
