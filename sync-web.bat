@echo off
rem Copies the website (..\webypdf) into the app. Run after you change the website, then rebuild.
set SRC=%1
if "%SRC%"=="" set SRC=..\webypdf
set DST=app\src\main\assets\www
if exist "%DST%" rmdir /s /q "%DST%"
mkdir "%DST%"
copy "%SRC%\index.html" "%DST%\" >nul
copy "%SRC%\manifest.webmanifest" "%DST%\" >nul
robocopy "%SRC%\css" "%DST%\css" /e >nul
robocopy "%SRC%\js" "%DST%\js" /e >nul
robocopy "%SRC%\vendor" "%DST%\vendor" /e >nul
robocopy "%SRC%\icons" "%DST%\icons" /e >nul
echo Synced web app into %DST%
