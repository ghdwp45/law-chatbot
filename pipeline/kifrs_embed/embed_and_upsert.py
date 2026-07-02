#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
K-IFRS 자료(질의회신 QnA 2,245건 + 기준서/해석서 51개 파일) -> 청크 -> Gemini 임베딩 ->
Supabase pgvector(`kifrs_chunks` 테이블) upsert.

사용법:
    py embed_and_upsert.py              # 미처리분 전체
    py embed_and_upsert.py --qna-only   # QnA 파일만
    py embed_and_upsert.py --std-only   # 기준서/해석서 파일만
    py embed_and_upsert.py --dry-run    # 임베딩/DB 호출 없이 청크 수만 출력

필요 환경변수: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
모델: gemini-embedding-001(텍스트 전용, 배치 정상지원). nts_scraper/embed와 동일 모델/차원 사용.
"""
import argparse
import os
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chunker import (  # noqa: E402
    parse_qna_file,
    qna_doc_to_chunks,
    parse_standard_file,
    standard_doc_to_chunks,
)
from manifest import load_manifest, save_manifest, is_file_done, mark_file_done  # noqa: E402

DATA_DIR = Path(r"C:\Users\Administrator\law-chatbot\pipeline\sources\회계기준서_notebooklm(이게 정제한거)")
EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768  # nts_scraper/embed와 동일 차원으로 통일(law-chatbot 쪽 RPC가 둘 다 768 가정)
BATCH_SIZE = 64
MAX_RETRIES = 5

_genai_client = None
_supabase = None


def _clients():
    global _genai_client, _supabase
    if _genai_client is None:
        from google import genai
        _genai_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    if _supabase is None:
        from supabase import create_client
        _supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    return _genai_client, _supabase


def embed_batch(texts):
    from google.genai import types
    genai_client, _ = _clients()
    for attempt in range(MAX_RETRIES):
        try:
            resp = genai_client.models.embed_content(
                model=EMBED_MODEL,
                contents=texts,
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_DOCUMENT",
                    output_dimensionality=EMBED_DIM,
                ),
            )
            return [e.values for e in resp.embeddings]
        except Exception as e:  # noqa: BLE001
            wait = min(60, 3 * (attempt + 1))
            print(f"  [임베딩 재시도 {attempt + 1}/{MAX_RETRIES}] {e} ({wait}s 후)", flush=True)
            time.sleep(wait)
    raise RuntimeError("임베딩 실패(재시도 소진)")


# Supabase 무료 티어의 문 실행 시간초과(57014)는 배치 크기에 비례하는 결정적 현상이라
# 같은 문장 재시도로는 안 풀린다. timeout이면 배치를 절반씩 재귀 분할(→1행까지), 1행에서도
# 실패하거나 다른 오류면 백오프 재시도. on_conflict 기반이라 멱등(재실행 안전).
UPSERT_SUB = 20


def _is_timeout(e):
    s = str(e)
    return "57014" in s or "statement timeout" in s


def _upsert_sub(rows):
    _, supabase = _clients()
    for attempt in range(MAX_RETRIES):
        try:
            supabase.table("kifrs_chunks").upsert(rows, on_conflict="doc_id,chunk_index").execute()
            return
        except Exception as e:  # noqa: BLE001
            if _is_timeout(e) and len(rows) > 1:
                mid = len(rows) // 2
                print(f"  [upsert 분할] {len(rows)}행 timeout → {mid}+{len(rows) - mid}행으로 분할", flush=True)
                _upsert_sub(rows[:mid])
                _upsert_sub(rows[mid:])
                return
            wait = min(60, 5 * (attempt + 1))
            print(f"  [upsert 재시도 {attempt + 1}/{MAX_RETRIES}] ({len(rows)}행) {e} ({wait}s 후)", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"upsert 실패(재시도 소진, {len(rows)}행)")


def _upsert_rows(rows):
    for i in range(0, len(rows), UPSERT_SUB):
        _upsert_sub(rows[i:i + UPSERT_SUB])


def upsert_chunks(chunks, embeddings, source_file):
    rows = []
    for c, emb in zip(chunks, embeddings):
        rows.append({
            "doc_id": c["doc_id"],
            "chunk_index": c["chunk_index"],
            "chunk_total": c["chunk_total"],
            "content": c["content"],
            "embedding": emb,
            "title": c["title"],
            "doc_type": c["doc_type"],
            "std_no": c["std_no"],
            "heading_path": c["heading_path"],
            "para_range": c["para_range"],
            "date": c["date"],
            "related_std": c["related_std"],
            "source_file": source_file,
        })
    _upsert_rows(rows)


def _embed_chunks_in_batches(all_chunks, path, dry_run):
    if dry_run:
        print(f"  -> 청크 {len(all_chunks)}개 (dry-run, 실제 임베딩 안 함)")
        return len(all_chunks)
    total = 0
    for i in range(0, len(all_chunks), BATCH_SIZE):
        batch = all_chunks[i:i + BATCH_SIZE]
        embeddings = embed_batch([c["content"] for c in batch])
        upsert_chunks(batch, embeddings, source_file=path.name)
        total += len(batch)
        print(f"  ...{path.name}: {min(i + BATCH_SIZE, len(all_chunks))}/{len(all_chunks)}청크")
    return total


def run_qna(manifest, dry_run):
    path = DATA_DIR / "K-IFRS_질의회신_QnA_2245건(최종수정).md"
    if not path.exists():
        print(f"[경고] QnA 파일을 찾을 수 없음: {path}")
        return
    st = path.stat()
    if is_file_done(manifest, path.name, st.st_mtime, st.st_size):
        print(f"[스킵] {path.name} (이미 임베딩됨)")
        return
    print(f"[처리] {path.name} ({st.st_size:,} bytes)")
    docs = parse_qna_file(path.read_text(encoding="utf-8"))
    all_chunks = []
    for d in docs:
        all_chunks.extend(qna_doc_to_chunks(d))
    n = _embed_chunks_in_batches(all_chunks, path, dry_run)
    if not dry_run:
        mark_file_done(manifest, path.name, st.st_mtime, st.st_size, n)
        save_manifest(manifest)


def run_standards(manifest, dry_run):
    files = sorted(DATA_DIR.glob("K-IFRS_제*.md")) + sorted(DATA_DIR.glob("K-IFRS_해석서_*.md"))
    for path in files:
        st = path.stat()
        if is_file_done(manifest, path.name, st.st_mtime, st.st_size):
            print(f"[스킵] {path.name} (이미 임베딩됨)")
            continue
        print(f"[처리] {path.name} ({st.st_size:,} bytes)")
        top_docs = parse_standard_file(path.read_text(encoding="utf-8"))
        # doc_id를 물리 파일 단위로 고유화: 같은 std_no가 여러 파일로 쪼개져도(제1109호) 충돌 안 함.
        # 파일명 기반이라 재실행해도 동일 doc_id가 나와 upsert 멱등성 유지. 한 파일에 같은 std_no가
        # 둘 이상이면(방어적) 순번까지 덧붙임.
        std_counts = {}
        for d in top_docs:
            std_counts[d["std_no"]] = std_counts.get(d["std_no"], 0) + 1
        seen = {}
        for d in top_docs:
            base = f"{d['std_no']}::{path.stem}"
            if std_counts[d["std_no"]] > 1:
                seen[d["std_no"]] = seen.get(d["std_no"], 0) + 1
                base = f"{base}::{seen[d['std_no']]}"
            d["doc_id"] = base
        all_chunks = []
        for d in top_docs:
            all_chunks.extend(standard_doc_to_chunks(d))
        n = _embed_chunks_in_batches(all_chunks, path, dry_run)
        if not dry_run:
            mark_file_done(manifest, path.name, st.st_mtime, st.st_size, n)
            save_manifest(manifest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qna-only", action="store_true")
    ap.add_argument("--std-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    manifest = load_manifest()
    if not args.std_only:
        run_qna(manifest, args.dry_run)
    if not args.qna_only:
        run_standards(manifest, args.dry_run)
    print("\n[완료] 임베딩/upsert 종료.")


if __name__ == "__main__":
    main()
