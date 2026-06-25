-- 하이브리드 검색에 출처(기재부/국세청) 필터 추가 (2026-06-25)
-- Supabase SQL Editor에서 006 다음에 실행.
--
-- 배경: nts_chunks에는 국세청 질의회신(약 7.5만건)과 기재부 세법해석(약 972건)이 함께 들어 있다.
--       기존 match_nts_chunks_hybrid에는 세목(tlaw) 필터만 있어, 데이터가 압도적으로 많은 국세청이
--       상위 결과를 독점한다. 그 결과 기재부 해석이 DB에 있어도 상위 match_count(≤10)에 못 올라와
--       모델이 보지 못한다(급식 월합계 질문에서 기재부 부가가치세제과-73 누락 사례).
--       이를 풀기 위해 출처 전용 검색을 가능케 하는 filter_source 파라미터를 추가한다.
--       route.js는 과세관청 버킷에서 '기본 검색 + source=mof 전용 검색'을 병렬로 돌려 기재부에
--       독립된 검색 슬롯을 보장한다.
--
--   filter_source = 'mof' : 기재부 문서만 (doc_type like '기재부%')
--   filter_source = 'nts' : 국세청 문서만 (doc_type가 '기재부'로 시작하지 않거나 null)
--   filter_source = null  : 현행 그대로(전체) — 하위호환
--
-- 반환 컬럼(시그니처)에 인자가 하나 늘어나므로 create or replace가 아니라 drop 후 재생성한다.
-- 주의: route.js는 이 마이그레이션 미적용 시(filter_source 미지원) source 인자 없이 자동 재시도하도록
--       구현돼 있다. 이 SQL을 실행해야 source 전용 검색이 실제로 활성화된다.
-- chunk_total·cos_sim은 005/006이 추가한 컬럼이므로 반드시 유지한다(빠지면 발췌 판정·관련도 문턱 회귀).

drop function if exists match_nts_chunks_hybrid(halfvec, text, integer, text);
drop function if exists match_nts_chunks_hybrid(halfvec, text, integer, text, text);

create function match_nts_chunks_hybrid(
  query_embedding halfvec(512),
  query_text text,
  match_count int default 5,
  filter_tlaw text default null,
  filter_source text default null
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
      and (filter_source is null
           or (filter_source = 'mof' and c.doc_type like '기재부%')
           or (filter_source = 'nts' and (c.doc_type is null or c.doc_type not like '기재부%')))
    order by c.embedding <=> query_embedding
    limit 30
  ),
  sparse as (
    select c.doc_id, c.chunk_index,
           row_number() over (order by word_similarity(query_text, coalesce(c.title,'') || ' ' || coalesce(c.keywords,'')) desc) as rnk
    from nts_chunks c
    where (filter_tlaw is null or c.tlaw = filter_tlaw)
      and (filter_source is null
           or (filter_source = 'mof' and c.doc_type like '기재부%')
           or (filter_source = 'nts' and (c.doc_type is null or c.doc_type not like '기재부%')))
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

revoke all on function match_nts_chunks_hybrid(halfvec, text, integer, text, text) from public, anon, authenticated;
grant execute on function match_nts_chunks_hybrid(halfvec, text, integer, text, text) to service_role;
