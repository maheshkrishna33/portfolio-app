@echo off
title GitHub sign-in for Portfolio app
echo ============================================================
echo  GitHub sign-in
echo  1. Press Enter for each question below.
echo  2. Copy the code it shows (like ABCD-1234).
echo  3. A browser opens: paste the code, click Authorize.
echo ============================================================
echo.
"C:\Program Files\GitHub CLI\gh.exe" auth login --hostname github.com --git-protocol https --web
echo.
"C:\Program Files\GitHub CLI\gh.exe" auth status
echo.
echo You can close this window now.
pause
