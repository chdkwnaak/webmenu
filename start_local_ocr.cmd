@echo off
setlocal
cd /d "%~dp0"
title COC Local OCR Server

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found.
  pause
  exit /b 1
)

where ollama >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Ollama was not found.
  pause
  exit /b 1
)

ollama list >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Cannot connect to Ollama. Start Ollama and try again.
  pause
  exit /b 1
)

python -c "from PIL import Image; import cv2" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] OCR image modules are not installed.
  echo Run this command and try again:
  echo python -m pip install -r requirements.txt
  pause
  exit /b 1
)

if not defined COC_OCR_MODEL set "COC_OCR_MODEL=gemma4:e4b-it-qat"
if not defined COC_OCR_PORT set "COC_OCR_PORT=8765"

ollama show "%COC_OCR_MODEL%" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] The configured vision model is not installed: %COC_OCR_MODEL%
  echo Run this command and try again:
  echo ollama pull %COC_OCR_MODEL%
  pause
  exit /b 1
)

python "%~dp0local_ocr_server.py"

if errorlevel 1 (
  echo.
  echo [ERROR] The local OCR server stopped with an error.
  pause
)
endlocal
