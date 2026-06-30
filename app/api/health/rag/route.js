import { GoogleGenAI } from '@google/genai';
import { ntsHybridSearch, tursoHealth } from '../../../lib/turso.js';

export const runtime = 'nodejs';
export const maxDuration = 30;

// RAG(로컬 검색) 전용 진단 엔드포인트. 운영에서 search_nts_taxlaw/search_kifrs_accounting이
// "서버 오류"로 실패할 때, 어느 의존성(키 미설정 / Gemini / Turso)이 문제인지 빠르게 가린다.
// 비밀값은 절대 노출하지 않고 존재 여부(boolean)와 마스킹된 에러 메시지만 반환한다.
// 비용·남용 방지: 실제 외부호출(임베딩/Turso)은 ?probe=1 일 때만 수행한다(기본은 키 존재여부만).
const NTS_EMBED_MODEL = 'gemini-embedding-001';
// 저장 벡터는 Turso F32_BLOB(768)이다. 쿼리 임베딩도 768로 맞춘다.
const NTS_EMBED_DIM = 768;

function mask(msg) {
  let s = String(msg || '').slice(0, 300);
  for (const v of [process.env.GEMINI_API_KEY, process.env.TURSO_AUTH_TOKEN, process.env.TURSO_DATABASE_URL]) {
    if (v) s = s.split(v).join('***');
  }
  return s;
}

export async function GET(request) {
  const probe = new URL(request.url).searchParams.get('probe') === '1';
  const env = {
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    TURSO_DATABASE_URL: !!process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: !!process.env.TURSO_AUTH_TOKEN,
    HEALTH_TOKEN: !!process.env.HEALTH_TOKEN,  // 값은 노출 안 함, 설정 여부만
  };
  const result = { ok: false, env, embed: 'skipped', turso: 'skipped', counts: null, dims: null };

  if (!probe) {
    result.ok = env.GEMINI_API_KEY && env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN;
    result.note = '키 존재여부만 확인함(비용 0). 실제 연결까지 보려면 ?probe=1&token=… 추가.';
    return Response.json(result);
  }

  // 비용 드는 실제 호출(probe)은 토큰으로 잠근다 — 아무나 호출해 Gemini 비용이 새는 것 방지.
  // HEALTH_TOKEN(환경변수)과 URL의 token 파라미터가 일치할 때만 실행.
  const token = (new URL(request.url).searchParams.get('token') || '').trim();
  const expected = (process.env.HEALTH_TOKEN || '').trim();  // 값 끝 공백·줄바꿈 실수 방어
  if (!expected || token !== expected) {
    return Response.json(
      { ok: false, env, error: 'probe는 유효한 token이 필요합니다(?probe=1&token=…). 키 존재여부는 token 없이 확인 가능.' },
      { status: 401 }
    );
  }

  // 1) Gemini 임베딩 실제 호출
  let queryEmbedding = null;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const emb = await ai.models.embedContent({
      model: NTS_EMBED_MODEL,
      contents: '진단용 임베딩',
      config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: NTS_EMBED_DIM },
    });
    queryEmbedding = emb.embeddings[0].values;
    result.embed = 'ok';
    result.dims = queryEmbedding.length;
  } catch (e) {
    result.embed = `error: ${mask(e.message)}`;
  }

  // 2) Turso 실제 호출 — 테이블 행 수 + (임베딩 성공 시) 하이브리드 검색 1건.
  try {
    result.counts = await tursoHealth();
    const vec = queryEmbedding || new Array(NTS_EMBED_DIM).fill(0.01);
    const rows = await ntsHybridSearch({ queryEmbedding: vec, queryText: '진단', matchCount: 1 });
    result.turso = `ok (rows=${rows.length})`;
  } catch (e) {
    result.turso = `error: ${mask(e.message)}`;
  }

  result.ok = result.embed === 'ok' && result.turso.startsWith('ok');
  return Response.json(result);
}
