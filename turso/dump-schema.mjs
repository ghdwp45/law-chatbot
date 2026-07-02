import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// .env.local 로드 (토큰 하드코딩 금지)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 실제 운영 DB의 모든 테이블·인덱스·트리거 정의(DDL)를 그대로 추출
const { rows } = await client.execute(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name"
);

let out = '-- law-chatbot Turso 운영 DB 실제 스키마 (자동 추출)\n';
out += `-- 추출 시각: ${new Date().toISOString()}\n\n`;
for (const r of rows) {
  out += `-- [${r.type}] ${r.name}\n${r.sql};\n\n`;
}

const outPath = path.join(__dirname, 'schema.sql');
writeFileSync(outPath, out, 'utf-8');
console.log(`스키마 ${rows.length}개 객체 추출 완료 -> turso/schema.sql`);
console.log('테이블/인덱스 목록:', rows.map(r => `${r.type}:${r.name}`).join(', '));
