@echo off
rem Publishes changes to the phone app. Phones get the new version next time they open it.
cd /d "%~dp0"
where git >nul 2>nul || (echo Git is not installed on this PC. & pause & exit /b 1)
git add -A
git diff --cached --quiet && (echo Nothing changed. & pause & exit /b 0)
git commit -m "Update app"
git push || (echo Push failed - check your internet connection or GitHub sign-in. & pause & exit /b 1)
echo.
echo Done. GitHub is rebuilding the site; the new version is live in about 2-3 minutes.
pause
