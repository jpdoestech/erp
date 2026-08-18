@echo off
title ERP Payroll - Server

echo ============================================
echo  ERP Payroll (Phase 1) - Starting server
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on this machine.
    echo Please install Node.js LTS from https://nodejs.org and re-run setup.bat first.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [ERROR] Dependencies are not installed yet.
    echo Please run "setup.bat" first.
    echo.
    pause
    exit /b 1
)

if not exist "db\erp.db" (
    echo No database found yet - running the seed script first...
    call npm run seed
    echo.
)

echo Starting the server at http://localhost:3000
echo Demo logins: admin / companyadmin / payrollapprover / branchuser  (password: admin123)
echo Press CTRL+C in this window to stop the server.
echo.

start "" http://localhost:3000
call npm start

pause
