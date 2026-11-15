@echo off
title APEX - API key setup
echo ==========================================
echo   APEX - API key setup
echo ==========================================
echo.
echo Paste your key and press Enter. Leave empty to skip a provider.
echo.
set /p OPENAI=OpenAI key:
set /p ANTHROPIC=Claude (Anthropic) key:
set /p GEMINI=Gemini key:
set /p GROQ=Groq key:
(
echo OPENAI_API_KEY=%OPENAI%
echo OPENAI_MODEL=gpt-5-mini
echo ANTHROPIC_API_KEY=%ANTHROPIC%
echo GEMINI_API_KEY=%GEMINI%
echo GROQ_API_KEY=%GROQ%
echo DEFAULT_PROVIDER=openai
echo SESSION_SECRET=%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%
echo DAILY_MESSAGE_LIMIT=30
echo PORT=3000
) > .env
echo.
echo Done. The .env file was created in this folder.
echo Now double-click START_APEX.bat
pause
