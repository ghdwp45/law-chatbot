-- =============================================================================
-- law-chatbot Turso(libsql) 스키마 참조본 (RECONSTRUCTED / 재구성본)
-- =============================================================================
-- ⚠️ 주의: 이 파일은 원본 마이그레이션이 아니라, app/lib/turso.js 의 SELECT/JOIN 에서
--          역추적해 재구성한 "참조용" 스키마다. 원래 데이터 적재·인덱스 생성 스크립트
--          (turso.js 주석이 언급한 setup-turso-search.mjs / import-turso-backup.mjs)는
--          현재 리포지토리에 없다. 새 Turso DB를 만들 때 출발점으로만 쓰고,
--          FTS5·벡터 인덱스 세부는 실제 적재 스크립트와 반드시 대조할 것.
--
-- 확실한 부분(코드가 실제로 읽는 컬럼): 각 *_chunks 테이블의 컬럼 목록.
-- 불확실한 부분(TODO 표기): FTS5 가상테이블의 정확한 정의(external-content 구성,
--          keywords 컬럼 출처)와 벡터 컬럼/인덱스 세부.
--
-- 공통 규약(turso.js 헤더 주석 기준):
--   - embedding: F32_BLOB(768)  (쿼리 임베딩도 768차원이어야 vector_distance_cos 동작)
--   - content:   BLOB (+ content_encoding: 'text' | 'gzip')
--   - FTS5:      trigram 토크나이저, external content 방식(rowid 공유)로 *_chunks 와 조인
-- =============================================================================

-- ===== NTS: 국세청 질의회신 + 기재부 세법해석 =====================================
CREATE TABLE IF NOT EXISTS nts_chunks (
  doc_id           TEXT    NOT NULL,   -- 국세청: taxlaw ntstDcmId(18자리) / 기재부: 문서번호+일자
  chunk_index      INTEGER NOT NULL,
  chunk_total      INTEGER,
  content          BLOB,               -- content_encoding 에 따라 gzip 해제 필요
  content_encoding TEXT,               -- 'text' | 'gzip'
  title            TEXT,
  doc_type         TEXT,               -- '기재부…' 로 시작하면 기재부, 아니면 국세청
  tlaw             TEXT,               -- 세목(정식명칭: '부가가치세' 등)
  prod_date        TEXT,
  qstn_no          TEXT,               -- 질의문서번호
  reply_no         TEXT,               -- 회신문서번호
  embedding        F32_BLOB(768),
  PRIMARY KEY (doc_id, chunk_index)
);

-- TODO(대조 필요): 실제 적재 스크립트의 FTS5 정의와 일치시킬 것.
-- 코드는 nts_fts(title, keywords) 를 MATCH 하고 c.rowid = f.rowid 로 조인한다.
-- external-content FTS5 는 content 테이블에 대응 컬럼이 있어야 하므로, keywords 는
-- 적재 시 별도로 채워 넣는 컬럼일 수 있다(원본 로더 확인 필요).
CREATE VIRTUAL TABLE IF NOT EXISTS nts_fts USING fts5(
  title,
  keywords,
  content='nts_chunks',
  content_rowid='rowid',
  tokenize='trigram'
);

-- ===== K-IFRS: 기준서 본문 / 해석서 / 회계 질의회신 QnA =============================
CREATE TABLE IF NOT EXISTS kifrs_chunks (
  doc_id           TEXT    NOT NULL,   -- 기준서번호 또는 QnA 엔트리ID
  chunk_index      INTEGER NOT NULL,
  chunk_total      INTEGER,
  content          BLOB,
  content_encoding TEXT,               -- 'text' | 'gzip'
  title            TEXT,
  doc_type         TEXT,               -- 'standard' | 'interpretation' | 'qna'
  std_no           TEXT,               -- 기준서번호(예: '제1115호'), QnA는 NULL 가능
  heading_path     TEXT,
  para_range       TEXT,
  date             TEXT,               -- QnA 일자
  related_std      TEXT,               -- QnA 관련기준(예: '제1115호, 제1016호')
  embedding        F32_BLOB(768),
  PRIMARY KEY (doc_id, chunk_index)
);

-- TODO(대조 필요): 코드는 kifrs_fts(title, heading_path, related_std) 를 MATCH.
CREATE VIRTUAL TABLE IF NOT EXISTS kifrs_fts USING fts5(
  title,
  heading_path,
  related_std,
  content='kifrs_chunks',
  content_rowid='rowid',
  tokenize='trigram'
);

-- ===== 판례·심판례·심사결정 =======================================================
-- 조세심판원 심판청구 / 국세청 심사청구 / 법원 판례 / 이의신청 / 과세적부 결정례.
CREATE TABLE IF NOT EXISTS precedent_chunks (
  doc_id           TEXT    NOT NULL,
  chunk_index      INTEGER NOT NULL,
  chunk_total      INTEGER,
  content          BLOB,
  content_encoding TEXT,               -- 'text' | 'gzip'
  title            TEXT,
  doc_type         TEXT,               -- '심판청구' | '심사청구' | '판례' | '이의신청' | '과세적부' …
  case_no          TEXT,               -- 사건번호
  tlaw             TEXT,               -- 세목
  prod_date        TEXT,               -- 결정일자
  embedding        F32_BLOB(768),
  PRIMARY KEY (doc_id, chunk_index)
);

-- TODO(대조 필요): 코드는 precedent_fts(title, keywords, case_no) 를 MATCH.
CREATE VIRTUAL TABLE IF NOT EXISTS precedent_fts USING fts5(
  title,
  keywords,
  case_no,
  content='precedent_chunks',
  content_rowid='rowid',
  tokenize='trigram'
);

-- =============================================================================
-- 참고: 하이브리드 검색은 dense(벡터 cosine 상위 30) + sparse(FTS trigram 상위 30)를
--       RRF( 1/(60+rank) 합산 )로 합쳐 상위 match_count(≤10)를 고른다. app/lib/turso.js 참조.
-- =============================================================================
