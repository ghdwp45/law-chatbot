-- 하이브리드 검색에 원본 코사인 유사도(cos_sim) 반환 추가 (2026-06-25)
-- Supabase SQL Editor에서 005 다음에 실행. 본문 로직은 005와 동일하며 cos_sim 한 컬럼만 끝에 추가.
--
-- 배경: 기존 score는 RRF(1/(60+rank))로 '순위 섞기'용이라 절대적 관련도(품질) 기준이 아니다.
--       질문과 동떨어진 결과도 RRF 상위에 올라올 수 있어, route.js가 관련도 하한을 두려면
--       원본 코사인 유사도가 필요하다. 여기서 cos_sim(1=동일, 0=무관, 음수=반대)을 추가 반환한다.
--       <=> 는 halfvec_cosine_ops의 코사인 '거리'이므로 유사도 = 1 - 거리.
-- 반환 컬럼(시그니처)이 바뀌므로 create or replace가 아니라 drop 후 재생성한다(005와 동일 이유).
-- 주의: route.js는 cos_sim이 없어도(이 마이그레이션 미적용 시) 동작하도록 구현돼 있다(문턱 자동 비활성).
--       이 SQL을 실행해야 NTS_MIN_SIM/KIFRS_MIN_SIM 문턱이 실제로 활성화된다.
-- chunk_total은 005가 추가한 발췌 판정용 컬럼이므로 반드시 유지한다(빠지면 발췌 판정 회귀).

-- ===========================================================================
-- nts_chunks 하이브리드 (halfvec 512) + chunk_total + cos_sim
-- ===========================================================================
drop function if exists match_nts_chunks_hybrid(halfvec, text, integer, text);

create function match_nts_chunks_hybrid(
  query_embedding halfvec(512),
  query_text text,
  match_count int default 5,
  filter_tlaw text default null
)
returns table (
  doc_id text, chunk_index int, chunk_total int, content text, title text, doc_type text,
  tlaw text, prod_date date, qstn_no text, reply_no text, score float, cos_sim float
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
  select c.doc_id, c.chunk_index, c.chunk_total, c.content, c.title, c.doc_type, c.tlaw,
         c.prod_date, c.qstn_no, c.reply_no, comb.rrf_score as score,
         (1 - (c.embedding <=> query_embedding))::float as cos_sim
  from combined comb
  join nts_chunks c on c.doc_id = comb.doc_id and c.chunk_index = comb.chunk_index
  order by comb.rrf_score desc
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_nts_chunks_hybrid(halfvec, text, integer, text) from public, anon, authenticated;
grant execute on function match_nts_chunks_hybrid(halfvec, text, integer, text) to service_role;

-- ===========================================================================
-- kifrs_chunks 하이브리드 (halfvec 512) + chunk_total + cos_sim
-- ===========================================================================
drop function if exists match_kifrs_chunks_hybrid(halfvec, text, integer, text, text);

create function match_kifrs_chunks_hybrid(
  query_embedding halfvec(512),
  query_text text,
  match_count int default 5,
  filter_doc_type text default null,
  filter_std_no text default null
)
returns table (
  doc_id text, chunk_index int, chunk_total int, content text, title text, doc_type text,
  std_no text, heading_path text, para_range text, date date, related_std text, score float, cos_sim float
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
  select c.doc_id, c.chunk_index, c.chunk_total, c.content, c.title, c.doc_type, c.std_no,
         c.heading_path, c.para_range, c.date, c.related_std, comb.rrf_score as score,
         (1 - (c.embedding <=> query_embedding))::float as cos_sim
  from combined comb
  join kifrs_chunks c on c.doc_id = comb.doc_id and c.chunk_index = comb.chunk_index
  order by comb.rrf_score desc
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_kifrs_chunks_hybrid(halfvec, text, integer, text, text) from public, anon, authenticated;
grant execute on function match_kifrs_chunks_hybrid(halfvec, text, integer, text, text) to service_role;
