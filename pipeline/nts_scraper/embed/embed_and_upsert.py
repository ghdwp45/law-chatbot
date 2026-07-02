#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NTS 질의회신 md -> 청크 -> Gemini 임베딩 -> Supabase pgvector upsert

사용법:
    py embed_and_upsert.py                     # 레거시(미처리분) + 증분(미처리분) 모두 처리
    py embed_and_upsert.py --legacy-only        # 레거시 파일만(최초 백필용)
    py embed_and_upsert.py --incremental-only   # 증분 폴더만(매달 자동화용)
    py embed_and_upsert.py --dry-run            # 임베딩/DB 호출 없이 문서 수만 출력

필요 환경변수: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

모델: gemini-embedding-001 (텍스트 전용, 배치 입력 시 항목별 개별 임베딩 반환).
gemini-embedding-2는 멀티모달 모델로 텍스트 리스트를 넣으면 하나로 합쳐진 임베딩만
반환하므로(배치 부적합) 이 용도에는 쓰지 않음.
"""
import argparse
import os
import re
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chunker import parse_md_file, doc_to_chunks, parse_mof_file, mof_doc_to_chunks  # noqa: E402
from manifest import (  # noqa: E402
    load_manifest,
    save_manifest,
    is_legacy_file_done,
    mark_legacy_file_done,
    is_incremental_dir_done,
    mark_incremental_dir_done,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768  # Supabase 무료 티어 용량 절감 목적. 스키마의 vector(768)와 반드시 일치시킬 것.
BATCH_SIZE = 64  # 공식 문서에 배치 상한이 명시돼 있지 않아 보수적으로 설정(에러 시 줄일 것)
MAX_RETRIES = 5

# 사용자 결정(2026-06-23): 중요도가 낮거나 너무 비대한 세목은 임베딩 대상에서 제외.
# 파일명(질의회신_<세목>.md)의 <세목> 부분과 정확히 일치하는 것만 제외한다.
EXCLUDE_TLAW = {
    "관세법", "교육세법", "교통ㆍ에너지ㆍ환경세법", "기타",
    "농어촌특별세법", "양도소득세", "인지세법", "종합소득세",
}

MOF_DIR = DATA_DIR / "기재부"
INCREMENTAL_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_genai_client = None
_supabase = None


def _clients():
    """API 키가 필요한 시점에만 클라이언트를 만든다(--dry-run에서는 불필요)."""
    global _genai_client, _supabase
    if _genai_client is None:
        from google import genai
        _genai_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    if _supabase is None:
        from supabase import create_client
        _supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    return _genai_client, _supabase


def _excluded(filename):
    """파일명(질의회신_세목.md)이 제외 대상 세목인지 확인."""
    stem = filename
    if stem.startswith("질의회신_"):
        stem = stem[len("질의회신_"):]
    stem = stem.rsplit(".", 1)[0]
    return stem in EXCLUDE_TLAW


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


# Supabase 무료 티어는 문 실행 시간초과(statement timeout, 코드 57014)가 짧게 걸려 있고,
# nts_chunks가 커질수록 HNSW 벡터 인덱스 삽입이 느려져 한 번에 여러 행을 upsert하면
# 시간초과로 죽는다. 이 시간초과는 "일시적"이 아니라 배치 크기에 비례하는 결정적 현상이라
# 같은 문장을 그대로 재시도하면 또 실패한다. 따라서 timeout이면 배치를 절반씩 재귀 분할해
# 결국 1행까지 줄이고(1행 HNSW 삽입은 어떤 timeout 안에도 들어옴), 1행에서도 실패하거나
# timeout이 아닌 다른 오류면 백오프 재시도한다. on_conflict 기반이라 멱등(재실행 안전).
UPSERT_SUB = 20


def _is_timeout(e):
    s = str(e)
    return "57014" in s or "statement timeout" in s


def _upsert_sub(table, rows):
    _, supabase = _clients()
    for attempt in range(MAX_RETRIES):
        try:
            supabase.table(table).upsert(rows, on_conflict="doc_id,chunk_index").execute()
            return
        except Exception as e:  # noqa: BLE001
            if _is_timeout(e) and len(rows) > 1:
                mid = len(rows) // 2
                print(f"  [upsert 분할] {len(rows)}행 timeout → {mid}+{len(rows) - mid}행으로 분할", flush=True)
                _upsert_sub(table, rows[:mid])
                _upsert_sub(table, rows[mid:])
                return
            wait = min(60, 5 * (attempt + 1))
            print(f"  [upsert 재시도 {attempt + 1}/{MAX_RETRIES}] ({len(rows)}행) {e} ({wait}s 후)", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"upsert 실패(재시도 소진, {len(rows)}행)")


def _upsert_rows(rows):
    for i in range(0, len(rows), UPSERT_SUB):
        _upsert_sub("nts_chunks", rows[i:i + UPSERT_SUB])


def upsert_chunks(chunks, embeddings):
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
            "tlaw": c["tlaw"],
            "prod_date": c["prod_date"],
            "qstn_no": c["qstn_no"],
            "reply_no": c["reply_no"],
            "keywords": c["keywords"],
            "source_file": c["source_file"],
        })
    _upsert_rows(rows)


def process_file(path, source_label):
    text = path.read_text(encoding="utf-8")
    docs = parse_md_file(text)
    total_chunks = 0
    for i in range(0, len(docs), BATCH_SIZE):
        batch_docs = docs[i:i + BATCH_SIZE]
        all_chunks = []
        for d in batch_docs:
            for c in doc_to_chunks(d):
                c["source_file"] = source_label
                all_chunks.append(c)
        if not all_chunks:
            continue
        embeddings = embed_batch([c["content"] for c in all_chunks])
        upsert_chunks(all_chunks, embeddings)
        total_chunks += len(all_chunks)
        print(f"  ...{path.name}: {min(i + BATCH_SIZE, len(docs))}/{len(docs)}문서, 누적 {total_chunks}청크")
    return total_chunks


def run_legacy(manifest, dry_run):
    for path in sorted(DATA_DIR.glob("질의회신_*.md")):
        if _excluded(path.name):
            print(f"[제외] {path.name} (임베딩 대상 아님)")
            continue
        st = path.stat()
        if is_legacy_file_done(manifest, path.name, st.st_mtime, st.st_size):
            print(f"[스킵] {path.name} (이미 임베딩됨)")
            continue
        print(f"[처리] {path.name} ({st.st_size:,} bytes)")
        if dry_run:
            docs = parse_md_file(path.read_text(encoding="utf-8"))
            print(f"  -> 문서 {len(docs)}건 (dry-run, 실제 임베딩 안 함)")
            continue
        n = process_file(path, source_label=path.name)
        mark_legacy_file_done(manifest, path.name, st.st_mtime, st.st_size, n)
        save_manifest(manifest)


def run_incremental(manifest, dry_run):
    for dirpath in sorted(DATA_DIR.iterdir()):
        if not dirpath.is_dir():
            continue
        if not INCREMENTAL_DIR_RE.match(dirpath.name):
            continue  # 기재부/ 등 날짜 폴더가 아닌 디렉터리는 건너뜀(별도 파서로 처리)
        if is_incremental_dir_done(manifest, dirpath.name):
            print(f"[스킵] {dirpath.name}/ (이미 임베딩됨)")
            continue
        print(f"[처리] {dirpath.name}/")
        total = 0
        for path in sorted(dirpath.glob("*.md")):
            if _excluded(path.name):
                print(f"  [제외] {path.name} (임베딩 대상 아님)")
                continue
            if dry_run:
                docs = parse_md_file(path.read_text(encoding="utf-8"))
                print(f"  -> {path.name}: 문서 {len(docs)}건 (dry-run)")
                continue
            total += process_file(path, source_label=f"{dirpath.name}/{path.name}")
        if not dry_run:
            mark_incremental_dir_done(manifest, dirpath.name, total)
            save_manifest(manifest)


def upsert_mof_chunks(chunks, embeddings):
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
            "tlaw": None,  # 기재부 사례는 세목으로 깔끔히 안 떨어져서 비워둠(부서명은 source_file로 추적)
            "prod_date": c["reply_date"],
            "qstn_no": None,
            "reply_no": c["doc_no"],
            "keywords": None,
            "source_file": c["dept"] and f"기재부_{c['dept']}" or "기재부",
        })
    _upsert_rows(rows)


def process_mof_file(path, dry_run):
    docs = parse_mof_file(path.read_text(encoding="utf-8"))
    all_chunks = []
    for d in docs:
        all_chunks.extend(mof_doc_to_chunks(d))
    if dry_run:
        print(f"  -> 문서 {len(docs)}건, 청크 {len(all_chunks)}개 (dry-run)")
        return len(all_chunks)
    total = 0
    for i in range(0, len(all_chunks), BATCH_SIZE):
        batch = all_chunks[i:i + BATCH_SIZE]
        embeddings = embed_batch([c["content"] for c in batch])
        upsert_mof_chunks(batch, embeddings)
        total += len(batch)
        print(f"  ...{path.name}: 누적 {total}/{len(all_chunks)}청크")
    return total


def run_mof(manifest, dry_run):
    if not MOF_DIR.exists():
        return
    for path in sorted(MOF_DIR.glob("*.md")):
        st = path.stat()
        if is_legacy_file_done(manifest, path.name, st.st_mtime, st.st_size):
            print(f"[스킵] 기재부/{path.name} (이미 임베딩됨)")
            continue
        print(f"[처리] 기재부/{path.name} ({st.st_size:,} bytes)")
        n = process_mof_file(path, dry_run)
        if not dry_run:
            mark_legacy_file_done(manifest, path.name, st.st_mtime, st.st_size, n)
            save_manifest(manifest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy-only", action="store_true")
    ap.add_argument("--incremental-only", action="store_true")
    ap.add_argument("--mof-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.legacy_only and args.incremental_only:
        ap.error("--legacy-only와 --incremental-only는 동시에 줄 수 없습니다(둘 다 주면 아무 것도 처리되지 않음).")

    manifest = load_manifest()
    if args.mof_only:
        run_mof(manifest, args.dry_run)
        print("\n[완료] 임베딩/upsert 종료.")
        return
    if not args.incremental_only:
        run_legacy(manifest, args.dry_run)
        run_mof(manifest, args.dry_run)
    if not args.legacy_only:
        run_incremental(manifest, args.dry_run)
    print("\n[완료] 임베딩/upsert 종료.")


if __name__ == "__main__":
    main()
