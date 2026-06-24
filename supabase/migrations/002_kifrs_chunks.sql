-- K-IFRS 회계기준 RAG 벡터DB 스키마 (질의회신 QnA + 기준서/해석서)
-- Supabase SQL Editor에서 001_nts_chunks.sql 다음에 실행할 것.
-- 임베딩 모델: gemini-embedding-001, 차원수 768 (nts_chunks와 동일하게 통일).

create extension if not exists vector;
create extension if not exists pg_trgm;

create table if not exists kifrs_chunks (
  doc_id        text not null,        -- QnA: 엔트리 ID(예: SSI-202511020) / 기준서: 기준서번호(예: 제1016호)
  chunk_index   int not null default 0,
  chunk_total   int not null default 1,
  content       text not null,
  embedding     vector(768) not null,
  title         text,
  doc_type      text not null,        -- 'qna' | 'standard' | 'interpretation'
  std_no        text,                 -- 기준서/해석서 번호(QnA는 null)
  heading_path  text,                 -- 기준서 섹션 breadcrumb(QnA는 null)
  para_range    text,                 -- 문단 범위(예: '15~24', QnA는 null)
  date          date,                 -- QnA 일자(기준서는 null)
  related_std   text,                 -- QnA 관련기준 텍스트(기준서는 null)
  source_file   text,
  created_at    timestamptz not null default now(),
  primary key (doc_id, chunk_index)
);

alter table kifrs_chunks enable row level security;

create index if not exists idx_kifrs_chunks_doc_type on kifrs_chunks (doc_type);
create index if not exists idx_kifrs_chunks_std_no on kifrs_chunks (std_no);

create index if not exists idx_kifrs_chunks_embedding on kifrs_chunks
  using hnsw (embedding vector_cosine_ops);

create index if not exists idx_kifrs_chunks_trgm on kifrs_chunks
  using gin ((title || ' ' || content) gin_trgm_ops);

-- 의미검색(dense) + 키워드검색(pg_trgm)을 RRF로 결합. doc_type/std_no로 좁힐 수 있음.
create or replace function match_kifrs_chunks_hybrid(
  query_embedding vector(768),
  query_text text,
  match_count int default 5,
  filter_doc_type text default null,
  filter_std_no text default null
)
returns table (
  doc_id text,
  chunk_index int,
  content text,
  title text,
  doc_type text,
  std_no text,
  heading_path text,
  para_range text,
  date date,
  related_std text,
  score float
)
language sql stable
as $$
  with dense as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by c.embedding <=> query_embedding) as rnk
    from kifrs_chunks c
    where (filter_doc_type is null or c.doc_type = filter_doc_type)
      and (filter_std_no is null or c.std_no = filter_std_no)
    order by c.embedding <=> query_embedding
    limit 30
  ),
  sparse as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by similarity(c.title || ' ' || c.content, query_text) desc) as rnk
    from kifrs_chunks c
    where (filter_doc_type is null or c.doc_type = filter_doc_type)
      and (filter_std_no is null or c.std_no = filter_std_no)
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
  select c.doc_id, c.chunk_index, c.content, c.title, c.doc_type, c.std_no,
         c.heading_path, c.para_range, c.date, c.related_std, comb.rrf_score as score
  from combined comb
  join kifrs_chunks c on c.doc_id = comb.doc_id and c.chunk_index = comb.chunk_index
  order by comb.rrf_score desc
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_kifrs_chunks_hybrid(vector, text, integer, text, text) from public, anon, authenticated;
grant execute on function match_kifrs_chunks_hybrid(vector, text, integer, text, text) to service_role;
