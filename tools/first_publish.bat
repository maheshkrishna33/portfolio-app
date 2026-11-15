@echo off
rem One-time: creates the public GitHub repository "portfolio-app" under your account,
rem uploads the app code (no portfolio data - .xlsx files and _site are excluded),
rem and switches on the free GitHub Pages website + the daily price job.
title Publish Portfolio phone app
cd /d "%~dp0.."
set GIT="C:\Program Files\Git\cmd\git.exe"
set GH="C:\Program Files\GitHub CLI\gh.exe"
set PATH=C:\Program Files\Git\cmd;%PATH%

echo Files that will be uploaded:
%GIT% add -A
%GIT% status --short
echo.
echo Press any key to publish these to github.com/maheshkrishna33/portfolio-app (public), or close this window to cancel.
pause >nul

%GIT% commit -q -m "Portfolio phone app"
%GH% repo create portfolio-app --public --description "Portfolio tracker phone app (data stays on your phone)" --source . --remote origin --push || goto :fail
%GH% api -X POST repos/maheshkrishna33/portfolio-app/pages -f build_type=workflow >nul || echo (Pages may already be on)
%GH% workflow run daily-data.yml -R maheshkrishna33/portfolio-app
echo.
echo Published. The first build downloads 10 years of fund history and takes about 20 minutes.
echo Your app will be at:  https://maheshkrishna33.github.io/portfolio-app/
pause
exit /b 0
:fail
echo Something went wrong - see the message above.
pause
exit /b 1
