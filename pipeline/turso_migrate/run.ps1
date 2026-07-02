# .env.local에서 환경변수 읽어서 migrate.mjs 실행
$envFile = "C:\Users\Administrator\law-chatbot\.env.local"
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.+)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
    }
}
# TURSO_DATABASE_URL -> TURSO_URL 별칭 처리 (libsql:// 그대로 유지 — WebSocket이 프록시 통과됨)
if (-not $env:TURSO_URL -and $env:TURSO_DATABASE_URL) { $env:TURSO_URL = $env:TURSO_DATABASE_URL }
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
Write-Host "TURSO_URL: $env:TURSO_URL"
node migrate.mjs
