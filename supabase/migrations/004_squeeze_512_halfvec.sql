-- 무료 티어(500MB) 우겨넣기 (2026-06-24)
-- 세 가지를 동시에 적용해 ~982MB → 약 400MB대로 축소(매달 증가분 여유 포함):
--   ① 768 → 512차원 truncate (Matryoshka): 기존 벡터의 앞 512차원만 사용. 재임베딩 0원.
--      코사인 검색이라 정규화는 코사인 연산자가 내부 처리(별도 L2 정규화 불필요).
--   ② fp32 → halfvec(16비트): 벡터 원소 정밀도 절반.
--   ③ 트라이그램(키워드) GIN: (title||content) 전체 → (title||keywords/heading_path)로 축소.
-- Supabase SQL Editor에서 실행. 테이블 재작성 + 인덱스 재생성이 있어 수 분 소요될 수 있다.
-- 검색함수의 query_embedding 파라미터 타입도 halfvec(512)로 바뀌므로 route.js는 NTS_EMBED_DIM=512로 맞춘다.
-- 전제: pgvector가 subvector()/halfvec를 지원(0.7+). Supabase 최신은 지원.

set statement_timeout = 0;               -- 인덱스 재생성이 오래 걸려도 끊기지 않게(이 세션 한정)
set max_parallel_maintenance_workers = 0; -- 병렬 HNSW 빌드의 공유메모리(DSM) 부족 에러(53100) 방지.
                                          -- 무료 티어는 공유메모리가 작아 병렬 빌드가 터지므로 단일 스레드로.
-- maintenance_work_mem은 일부러 안 올린다(높이면 무료 티어 메모리 초과). 기본값으로 단일 빌드.

-- ===========================================================================
-- nts_chunks : 벡터 512 halfvec + 트라이그램 제목·주제어
-- ===========================================================================
drop index if exists idx_nts_chunks_embedding;
drop index if exists idx_nts_chunks_trgm;

-- 768 벡터의 앞 512차원만 취해 halfvec(512)로 변환(전체 행 재작성)
alter table nts_chunks
  alter column embedding type halfvec(512)
  using subvector(embedding, 1, 512)::halfvec(512);

create index idx_nts_chunks_embedding on nts_chunks
  using hnsw (embedding halfvec_cosine_ops);

create index idx_nts_chunks_trgm on nts_chunks
  using gin ((coalesce(title, '') || ' ' || coalesce(keywords, '')) gin_trgm_ops);

create or replace function match_nts_chunks_hybrid(
  query_embedding halfvec(512),
  query_text text,
  match_count int default 5,
  filter_tlaw text default null
)
returns table (
  doc_id text, chunk_index int, content text, title text, doc_type text,
  tlaw text, prod_date date, qstn_no text, reply_no text, score float
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
           row_number() over (order by word_similarity(query_text, coalesce(c.title,'') || ' ' || coalesce(c.keywords,'')) desc) as rnk
    from nts_chunks c
    where (filter_tlaw is null or c.tlaw = filter_tlaw)
      and query_text <% (coalesce(c.title,'') || ' ' || coalesce(c.keywords,''))
    order by word_similarity(query_text, coalesce(c.title,'') || ' ' || coalesce(c.keywords,'')) desc
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

revoke all on function match_nts_chunks_hybrid(halfvec, text, integer, text) from public, anon, authenticated;
grant execute on function match_nts_chunks_hybrid(halfvec, text, integer, text) to service_role;
drop function if exists match_nts_chunks_hybrid(vector, text, integer, text);

-- ===========================================================================
-- kifrs_chunks : 벡터 512 halfvec + 트라이그램 제목·섹션경로
-- ===========================================================================
drop index if exists idx_kifrs_chunks_embedding;
drop index if exists idx_kifrs_chunks_trgm;

alter table kifrs_chunks
  alter column embedding type halfvec(512)
  using subvector(embedding, 1, 512)::halfvec(512);

create index idx_kifrs_chunks_embedding on kifrs_chunks
  using hnsw (embedding halfvec_cosine_ops);

create index idx_kifrs_chunks_trgm on kifrs_chunks
  using gin ((coalesce(title, '') || ' ' || coalesce(heading_path, '')) gin_trgm_ops);

create or replace function match_kifrs_chunks_hybrid(
  query_embedding halfvec(512),
  query_text text,
  match_count int default 5,
  filter_doc_type text default null,
  filter_std_no text default null
)
returns table (
  doc_id text, chunk_index int, content text, title text, doc_type text,
  std_no text, heading_path text, para_range text, date date, related_std text, score float
)
language sql stable
as $$
  with dense as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by c.embedding <=> query_embedding) as rnk
    from kifrs_chunks c
    where (filter_doc_type is null or c.doc_type = filter_doc_type)
      and (filter_std_no is null or c.std_no = filter_std_no
           or c.related_std ilike '%' || filter_std_no || '%')
    order by c.embedding <=> query_embedding
    limit 30
  ),
  sparse as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by word_similarity(query_text, coalesce(c.title,'') || ' ' || coalesce(c.heading_path,'')) desc) as rnk
    from kifrs_chunks c
    where (filter_doc_type is null or c.doc_type = filter_doc_type)
      and (filter_std_no is null or c.std_no = filter_std_no
           or c.related_std ilike '%' || filter_std_no || '%')
      and query_text <% (coalesce(c.title,'') || ' ' || coalesce(c.heading_path,''))
    order by word_similarity(query_text, coalesce(c.title,'') || ' ' || coalesce(c.heading_path,'')) desc
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

revoke all on function match_kifrs_chunks_hybrid(halfvec, text, integer, text, text) from public, anon, authenticated;
grant execute on function match_kifrs_chunks_hybrid(halfvec, text, integer, text, text) to service_role;
drop function if exists match_kifrs_chunks_hybrid(vector, text, integer, text, text);

-- ===========================================================================
-- 적용 후 용량 확인용(주석 해제해 실행)
-- ===========================================================================
-- select pg_size_pretty(pg_total_relation_size('nts_chunks'))  as nts,
--        pg_size_pretty(pg_total_relation_size('kifrs_chunks')) as kifrs;
