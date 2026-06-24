import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 30;

// RAG(로컬 검색) 전용 진단 엔드포인트. 운영에서 search_nts_taxlaw/search_kifrs_accounting이
// "서버 오류"로 실패할 때, 어느 의존성(키 미설정 / Gemini / Supabase)이 문제인지 빠르게 가린다.
// 비밀값은 절대 노출하지 않고 존재 여부(boolean)와 마스킹된 에러 메시지만 반환한다.
// 비용·남용 방지: 실제 외부호출(임베딩/RPC)은 ?probe=1 일 때만 수행한다(기본은 키 존재여부만).
const NTS_EMBED_MODEL = 'gemini-embedding-001';
const NTS_EMBED_DIM = 512;

function mask(msg) {
  let s = String(msg || '').slice(0, 300);
  for (const v of [process.env.GEMINI_API_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SUPABASE_URL]) {
    if (v) s = s.split(v).join('***');
  }
  return s;
}

export async function GET(request) {
  const probe = new URL(request.url).searchParams.get('probe') === '1';
  const env = {
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const result = { ok: false, env, embed: 'skipped', supabase: 'skipped', dims: null };

  if (!probe) {
    result.ok = env.GEMINI_API_KEY && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY;
    result.note = '키 존재여부만 확인함. 실제 연결까지 보려면 ?probe=1 추가.';
    return Response.json(result);
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

  // 2) Supabase RPC 실제 호출(임베딩 성공 시 그 벡터로, 실패 시 더미 벡터로 함수 존재만 확인)
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const vec = queryEmbedding || new Array(NTS_EMBED_DIM).fill(0.01);
    const { data, error } = await supabase.rpc('match_nts_chunks_hybrid', {
      query_embedding: vec, query_text: '진단', match_count: 1, filter_tlaw: null,
    });
    if (error) result.supabase = `error: ${mask(error.message)}`;
    else result.supabase = `ok (rows=${(data || []).length})`;
  } catch (e) {
    result.supabase = `error: ${mask(e.message)}`;
  }

  result.ok = result.embed === 'ok' && result.supabase.startsWith('ok');
  return Response.json(result);
}
