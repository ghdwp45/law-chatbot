import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// .env.local에서 환경변수 로드 (토큰을 코드에 박지 않는다)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 이 .env.local 에 없습니다.');
  process.exit(1);
}

const client = createClient({ url, authToken });
try {
  const result = await client.execute('SELECT 1 as test');
  console.log('연결 성공:', JSON.stringify(result.rows));
} catch (e) {
  console.error('연결 실패:', e.message);
  console.error('cause:', e.cause?.message);
}
