@echo off
cd /d "C:\Users\Administrator\law-chatbot\pipeline\nts_scraper"
echo [%date% %time%] 증분 수집 시작 >> embed\monthly.log
py collect_incremental.py >> embed\monthly.log 2>&1
if %errorlevel% neq 0 (
  echo [%date% %time%] 수집 실패 - 임베딩 생략 >> embed\monthly.log
  exit /b 1
)
echo [%date% %time%] 증분 수집 완료, 임베딩 시작 >> embed\monthly.log
py embed\embed_and_upsert.py --incremental-only >> embed\monthly.log 2>&1
echo [%date% %time%] 전체 완료 >> embed\monthly.log
