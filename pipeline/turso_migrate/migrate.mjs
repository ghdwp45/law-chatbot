import { createClient } from '@libsql/client';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import path from 'path';

const TURSO_URL = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const BACKUP_DIR = 'C:\\Users\\Administrator\\law-chatbot\\pipeline\\backup\\vector_backup_768';
// 한 번에 Turso에 보낼 행 수. 너무 크면 요청 크기 초과 가능 (50 권장)
const BATCH_SIZE = 50;    // 배치당 행 수
const CONCURRENCY = 2;    // 동시에 보낼 배치 수

if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
  console.error('TURSO_URL 또는 TURSO_AUTH_TOKEN 환경변수가 없습니다.');
  process.exit(1);
}

const client = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });

// JSONL.GZ 파일을 한 줄씩 읽어 파싱 객체를 yield 하는 제너레이터
async function* readJsonlGz(filePath) {
  const gunzip = createGunzip();
  const rl = createInterface({ input: createReadStream(filePath).pipe(gunzip) });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed);
  }
}

// Python date 객체 직렬화 형태('2023-05-15'나 datetime iso)를 'YYYY-MM-DD' 문자열로 변환
function toDateStr(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return null;
}

// embedding 배열(768개 float)을 16진수 문자열로 변환 (SQL X'...' 리터럴용)
// 백업 파일에서 embedding이 JSON 문자열로 저장된 경우 파싱
function embToHex(embedding) {
  const arr = typeof embedding === 'string' ? JSON.parse(embedding) : embedding;
  return Buffer.from(new Float32Array(arr).buffer).toString('hex');
}

async function migrateTable(table, filePath, rowToArgs) {
  console.log(`\n[${table}] 시작: ${filePath}`);
  let pending = [];   // 아직 안 보낸 배치들
  let total = 0;
  let errors = 0;
  let batch = [];

  const flush = async (force = false) => {
    if (batch.length > 0) {
      pending.push(batch);
      batch = [];
    }
    if (pending.length >= CONCURRENCY || (force && pending.length > 0)) {
      await Promise.all(pending.map(b => client.batch(b, 'write')));
      total += pending.reduce((s, b) => s + b.length, 0);
      if (Math.floor(total / 500) > Math.floor((total - pending.reduce((s,b)=>s+b.length,0)) / 500)) {
        console.log(`  ${total}행 완료`);
      }
      pending = [];
    }
  };

  for await (const row of readJsonlGz(filePath)) {
    try {
      batch.push(rowToArgs(row));
    } catch (e) {
      errors++;
      console.warn(`  변환 오류(건너뜀): doc_id=${row.doc_id} chunk=${row.chunk_index} — ${e.message}`);
      continue;
    }
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush(true);

  console.log(`[${table}] 완료: ${total}행 적재, 오류 ${errors}건`);
  return total;
}

function ntsRowToArgs(row) {
  const hex = embToHex(row.embedding);
  return {
    sql: `INSERT OR REPLACE INTO nts_chunks
            (doc_id, chunk_index, chunk_total, content, embedding,
             title, doc_type, tlaw, prod_date, qstn_no, reply_no, keywords, source_file)
          VALUES (?, ?, ?, ?, vector32(X'${hex}'), ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      String(row.doc_id),
      Number(row.chunk_index ?? 0),
      Number(row.chunk_total ?? 1),
      String(row.content),
      row.title ?? null,
      row.doc_type ?? null,
      row.tlaw ?? null,
      toDateStr(row.prod_date),
      row.qstn_no ?? null,
      row.reply_no ?? null,
      row.keywords ?? null,
      row.source_file ?? null,
    ],
  };
}

function kifrsRowToArgs(row) {
  const hex = embToHex(row.embedding);
  return {
    sql: `INSERT OR REPLACE INTO kifrs_chunks
            (doc_id, chunk_index, chunk_total, content, embedding,
             title, doc_type, std_no, heading_path, para_range,
             date, related_std, source_file)
          VALUES (?, ?, ?, ?, vector32(X'${hex}'), ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      String(row.doc_id),
      Number(row.chunk_index ?? 0),
      Number(row.chunk_total ?? 1),
      String(row.content),
      row.title ?? null,
      String(row.doc_type ?? 'qna'),
      row.std_no ?? null,
      row.heading_path ?? null,
      row.para_range ?? null,
      toDateStr(row.date),
      row.related_std ?? null,
      row.source_file ?? null,
    ],
  };
}

async function verifyCount(table) {
  const { rows } = await client.execute(`SELECT COUNT(*) AS cnt FROM ${table}`);
  console.log(`  ${table} 행수: ${rows[0].cnt}`);
}

async function main() {
  console.log('=== Turso 마이그레이션 시작 ===');

  const ntsFile  = path.join(BACKUP_DIR, 'nts_chunks.jsonl.gz');
  const kifrsFile = path.join(BACKUP_DIR, 'kifrs_chunks.jsonl.gz');

  await migrateTable('nts_chunks',   ntsFile,   ntsRowToArgs);
  await migrateTable('kifrs_chunks', kifrsFile, kifrsRowToArgs);

  console.log('\n=== 행수 검증 ===');
  await verifyCount('nts_chunks');
  await verifyCount('kifrs_chunks');

  // FTS5 트리거가 INSERT 시 자동 빌드했는지 확인 (검색 1건 테스트)
  console.log('\n=== FTS5 동작 확인 ===');
  const { rows: ftsTest } = await client.execute({
    sql: `SELECT c.doc_id FROM nts_fts f JOIN nts_chunks c ON c.rowid = f.rowid WHERE nts_fts MATCH '부가가치세' LIMIT 1`,
    args: [],
  });
  console.log(`  nts_fts 검색 결과: ${ftsTest.length > 0 ? '정상' : '0건 — FTS5 이상'}`);

  console.log('\n=== 완료 ===');
  client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
