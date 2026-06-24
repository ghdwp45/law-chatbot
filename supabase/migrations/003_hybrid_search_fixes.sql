-- 하이브리드 검색 품질 수정 (코덱스 전체 리뷰 후속, 2026-06-24)
-- Supabase SQL Editor에서 001·002 다음에 실행할 것. 함수 본문만 교체하므로 데이터·인덱스 영향 없음.
--
-- M7: 기존 sparse 가지는 `(title||content) % query_text`(similarity 임계값 0.3)를 썼는데,
--     수백 자짜리 긴 청크와 짧은 검색어의 전체 문자열 유사도는 0.02 수준이라 항상 임계값 미달 →
--     sparse가 0건만 내보내 하이브리드가 사실상 dense-only로 퇴화했다.
--     word_similarity(짧은 질의가 긴 문서의 "연속 구간"과 얼마나 닮았는지)로 교체한다.
--     `<%` 연산자는 GIN trgm 인덱스로 가속되며 word_similarity_threshold(기본 0.6)를 쓴다.
--     (함수 단위 SET pg_trgm.word_similarity_threshold는 Supabase에서 권한 거부(42501)라 안 씀.
--      나중에 재현율이 부족하면 세션/DB 레벨에서 임계값을 낮추는 방안을 검토.)
-- M1: kifrs QnA는 std_no가 NULL이고 관련 기준서번호는 related_std에 들어있다. 기존엔 std_no만
--     비교해 QnA를 기준서번호로 좁히면 항상 0건이었다. related_std 부분일치도 허용한다.

-- ---------------------------------------------------------------------------
-- NTS 하이브리드 (M7)
-- ---------------------------------------------------------------------------
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
           row_number() over (order by word_similarity(query_text, c.title || ' ' || c.content) desc) as rnk
    from nts_chunks c
    where (filter_tlaw is null or c.tlaw = filter_tlaw)
      and query_text <% (c.title || ' ' || c.content)
    order by word_similarity(query_text, c.title || ' ' || c.content) desc
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

-- ---------------------------------------------------------------------------
-- K-IFRS 하이브리드 (M7 + M1)
-- ---------------------------------------------------------------------------
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
      and (filter_std_no is null or c.std_no = filter_std_no
           or c.related_std ilike '%' || filter_std_no || '%')   -- M1: QnA는 related_std로 매칭
    order by c.embedding <=> query_embedding
    limit 30
  ),
  sparse as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by word_similarity(query_text, c.title || ' ' || c.content) desc) as rnk
    from kifrs_chunks c
    where (filter_doc_type is null or c.doc_type = filter_doc_type)
      and (filter_std_no is null or c.std_no = filter_std_no
           or c.related_std ilike '%' || filter_std_no || '%')
      and query_text <% (c.title || ' ' || c.content)
    order by word_similarity(query_text, c.title || ' ' || c.content) desc
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
