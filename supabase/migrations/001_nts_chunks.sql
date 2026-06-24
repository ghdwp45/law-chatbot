-- NTS 질의회신 RAG 벡터DB 스키마 (하이브리드: dense pgvector + sparse pg_trgm)
-- Supabase SQL Editor에서 직접 실행할 것.
-- 임베딩 모델: gemini-embedding-001, 차원수 768.
-- 차원수는 nts_scraper/embed/embed_and_upsert.py의 EMBED_DIM,
-- law-chatbot/app/api/chat/route.js의 NTS_EMBED_DIM과 반드시 일치시켜야 함.

create extension if not exists vector;
create extension if not exists pg_trgm;

create table if not exists nts_chunks (
  doc_id        text not null,
  chunk_index   int not null default 0,
  chunk_total   int not null default 1,
  content       text not null,
  embedding     vector(768) not null,
  title         text,
  doc_type      text,
  tlaw          text,                  -- 세목 (필터링 핵심 컬럼)
  prod_date     date,
  qstn_no       text,
  reply_no      text,
  keywords      text,
  source_file   text,                  -- 어느 원본 파일/폴더에서 왔는지(디버깅·재처리용)
  created_at    timestamptz not null default now(),
  primary key (doc_id, chunk_index)
);

-- 서버의 service role만 접근한다. 공개 Data API를 통한 원문/벡터 직접 열람은 차단한다.
alter table nts_chunks enable row level security;

create index if not exists idx_nts_chunks_tlaw on nts_chunks (tlaw);
create index if not exists idx_nts_chunks_prod_date on nts_chunks (prod_date);
create index if not exists idx_nts_chunks_qstn_no on nts_chunks (qstn_no);
create index if not exists idx_nts_chunks_reply_no on nts_chunks (reply_no);

-- 벡터 검색용 인덱스 (HNSW: pgvector 0.5+, 10만+ 건에서 ivfflat보다 정확도/속도 우수)
create index if not exists idx_nts_chunks_embedding on nts_chunks
  using hnsw (embedding vector_cosine_ops);

-- 한국어는 Postgres 기본 사전(형태소 분석)이 없어 tsvector 단어검색이 잘 안 맞는다.
-- 대신 문자 트라이그램(pg_trgm)으로 언어 무관한 부분일치/정확 키워드 검색을 보완한다.
create index if not exists idx_nts_chunks_trgm on nts_chunks
  using gin ((title || ' ' || content) gin_trgm_ops);

-- 의미검색(dense, pgvector) + 키워드검색(sparse 대체, pg_trgm)을 RRF로 결합
create or replace function match_nts_chunks_hybrid(
  query_embedding vector(768),
  query_text text,
  match_count int default 5,
  filter_tlaw text default null
)
returns table (
  doc_id text,
  chunk_index int,
  content text,
  title text,
  doc_type text,
  tlaw text,
  prod_date date,
  qstn_no text,
  reply_no text,
  score float
)
language sql stable
as $$
  with dense as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by c.embedding <=> query_embedding) as rnk
    from nts_chunks c
    where (filter_tlaw is null or c.tlaw = filter_tlaw)
    order by c.embedding <=> query_embedding
    limit 30
  ),
  sparse as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by similarity(c.title || ' ' || c.content, query_text) desc) as rnk
    from nts_chunks c
    where (filter_tlaw is null or c.tlaw = filter_tlaw)
      and (c.title || ' ' || c.content) % query_text
    order by similarity(c.title || ' ' || c.content, query_text) desc
    limit 30
  ),
  combined as (
    select coalesce(d.doc_id, s.doc_id) as doc_id,
           coalesce(d.chunk_index, s.chunk_index) as chunk_index,
           (1.0 / (60 + coalesce(d.rnk, 1000))) + (1.0 / (60 + coalesce(s.rnk, 1000))) as rrf_score
    from dense d
    full outer join sparse s on d.doc_id = s.doc_id and d.chunk_index = s.chunk_index
  )
  select c.doc_id, c.chunk_index, c.content, c.title, c.doc_type, c.tlaw,
         c.prod_date, c.qstn_no, c.reply_no, comb.rrf_score as score
  from combined comb
  join nts_chunks c on c.doc_id = comb.doc_id and c.chunk_index = comb.chunk_index
  order by comb.rrf_score desc
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_nts_chunks_hybrid(vector, text, integer, text) from public, anon, authenticated;
grant execute on function match_nts_chunks_hybrid(vector, text, integer, text) to service_role;

-- 질의/회신문서번호 정확검색(부분일치). 임베딩보다 이게 우선해야 하는 케이스용.
create or replace function match_nts_chunks_by_docno(
  query_text text,
  match_count int default 5
)
returns table (
  doc_id text,
  chunk_index int,
  content text,
  title text,
  doc_type text,
  tlaw text,
  prod_date date,
  qstn_no text,
  reply_no text
)
language sql stable
as $$
  select c.doc_id, c.chunk_index, c.content, c.title, c.doc_type, c.tlaw,
         c.prod_date, c.qstn_no, c.reply_no
  from nts_chunks c
  where c.qstn_no ilike '%' || query_text || '%'
     or c.reply_no ilike '%' || query_text || '%'
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_nts_chunks_by_docno(text, integer) from public, anon, authenticated;
grant execute on function match_nts_chunks_by_docno(text, integer) to service_role;
