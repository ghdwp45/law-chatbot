-- chunk_total을 검색함수 반환에 추가 (2026-06-24)
-- 목적: RAG 결과가 '여러 청크로 쪼갠 문서의 일부(발췌)'인지 정확히 판정하기 위함.
--   기존엔 chunk_index>0만으로 발췌를 표시해, 다중 청크 문서의 '첫 청크(chunk_index=0)'가
--   전체 문서처럼 보이는 문제가 있었다. chunk_total>1이면 어느 청크든 발췌임을 알 수 있다.
-- 반환 컬럼(시그니처)이 바뀌므로 create or replace가 아니라 drop 후 재생성한다.
-- 본문 로직은 004(halfvec 512)/001과 동일하며 c.chunk_total 한 컬럼만 추가했다.
-- 테이블 재작성·인덱스 재생성이 없어 수 초 내 완료된다. Supabase SQL Editor에서 실행.

-- ===========================================================================
-- nts_chunks 하이브리드 (halfvec 512) + chunk_total
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
  select c.doc_id, c.chunk_index, c.chunk_total, c.content, c.title, c.doc_type, c.tlaw,
         c.prod_date, c.qstn_no, c.reply_no, comb.rrf_score as score
  from combined comb
  join nts_chunks c on c.doc_id = comb.doc_id and c.chunk_index = comb.chunk_index
  order by comb.rrf_score desc
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_nts_chunks_hybrid(halfvec, text, integer, text) from public, anon, authenticated;
grant execute on function match_nts_chunks_hybrid(halfvec, text, integer, text) to service_role;

-- ===========================================================================
-- nts_chunks 문서번호 정확검색 + chunk_total (+ 결정적 정렬)
-- ===========================================================================
drop function if exists match_nts_chunks_by_docno(text, integer);

create function match_nts_chunks_by_docno(
  query_text text,
  match_count int default 5
)
returns table (
  doc_id text, chunk_index int, chunk_total int, content text, title text, doc_type text,
  tlaw text, prod_date date, qstn_no text, reply_no text
)
language sql stable
as $$
  select c.doc_id, c.chunk_index, c.chunk_total, c.content, c.title, c.doc_type, c.tlaw,
         c.prod_date, c.qstn_no, c.reply_no
  from nts_chunks c
  where c.qstn_no ilike '%' || query_text || '%'
     or c.reply_no ilike '%' || query_text || '%'
  order by c.doc_id, c.chunk_index        -- 정렬 없으면 같은 문서의 임의 청크가 잘려 나옴
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_nts_chunks_by_docno(text, integer) from public, anon, authenticated;
grant execute on function match_nts_chunks_by_docno(text, integer) to service_role;

-- ===========================================================================
-- kifrs_chunks 하이브리드 (halfvec 512) + chunk_total
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
  select c.doc_id, c.chunk_index, c.chunk_total, c.content, c.title, c.doc_type, c.std_no,
         c.heading_path, c.para_range, c.date, c.related_std, comb.rrf_score as score
  from combined comb
  join kifrs_chunks c on c.doc_id = comb.doc_id and c.chunk_index = comb.chunk_index
  order by comb.rrf_score desc
  limit least(greatest(coalesce(match_count, 5), 1), 10);
$$;

revoke all on function match_kifrs_chunks_hybrid(halfvec, text, integer, text, text) from public, anon, authenticated;
grant execute on function match_kifrs_chunks_hybrid(halfvec, text, integer, text, text) to service_role;
