#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
판례·결정례 md -> 청크 -> Gemini 임베딩 -> 백업 jsonl.gz 저장
(질의회신 embed_and_upsert.py와 동일한 임베딩 방식. 저장만 Supabase 대신 로컬 백업)

사용법:
    py embed_prec.py            # 미처리 파일 전부 임베딩(이어받기)
    py embed_prec.py --dry-run  # 임베딩 없이 파일별 문서/청크 수만 출력

출력: vector_backup_768/precedent/<원본파일명>.jsonl.gz  (파일당 1개, 원자적 저장)
필요 환경변수: GEMINI_API_KEY  (law-chatbot/.env.local 에서 자동 로드)
"""
import argparse
import gzip
import json
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
from chunker import parse_prec_file, prec_doc_to_chunks  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PREC_DIR = ROOT / "data" / "판례결정례"
OUT_DIR = Path(r"C:\Users\Administrator\law-chatbot\pipeline\backup\vector_backup_768\precedent")
MANIFEST = Path(__file__).resolve().parent / "prec_manifest.json"

EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768
BATCH_SIZE = 64
MAX_RETRIES = 5

_genai_client = None


def _load_env():
    env_path = Path(r"C:\Users\Administrator\law-chatbot\.env.local")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def _client():
    global _genai_client
    if _genai_client is None:
        from google import genai
        _genai_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _genai_client


def embed_batch(texts):
    from google.genai import types
    client = _client()
    for attempt in range(MAX_RETRIES):
        try:
            resp = client.models.embed_content(
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


def load_manifest():
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    return {"files": {}}


def save_manifest(m):
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


def process_file(path, dry_run):
    docs = parse_prec_file(path.read_text(encoding="utf-8"))
    all_chunks = []
    for d in docs:
        all_chunks.extend(prec_doc_to_chunks(d))
    if dry_run:
        print(f"  -> 문서 {len(docs)}건, 청크 {len(all_chunks)}개 (dry-run)")
        return len(all_chunks)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / (path.stem + ".jsonl.gz")
    tmp_path = out_path.with_suffix(".gz.tmp")
    written = 0
    with gzip.open(tmp_path, "wt", encoding="utf-8") as f:
        for i in range(0, len(all_chunks), BATCH_SIZE):
            batch = all_chunks[i:i + BATCH_SIZE]
            embeddings = embed_batch([c["content"] for c in batch])
            for c, emb in zip(batch, embeddings):
                row = {
                    "doc_id": c["doc_id"],
                    "chunk_index": c["chunk_index"],
                    "chunk_total": c["chunk_total"],
                    "content": c["content"],
                    "embedding": emb,
                    "title": c["title"],
                    "doc_type": c["doc_type"],
                    "case_no": c["case_no"],
                    "tlaw": c["tlaw"],
                    "prod_date": c["prod_date"],
                    "keywords": c["keywords"],
                    "source_file": path.name,
                }
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
            written += len(batch)
            print(f"  ...{path.name}: {written}/{len(all_chunks)}청크", flush=True)
    tmp_path.replace(out_path)  # 원자적 교체(중간에 죽으면 .tmp만 남고 재실행 시 전체 재처리)
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.dry_run:
        _load_env()

    manifest = load_manifest()
    files = sorted(PREC_DIR.glob("*.md"))
    print(f"판례·결정례 파일 {len(files)}개 발견\n")

    grand = 0
    for path in files:
        st = path.stat()
        rec = manifest["files"].get(path.name)
        done = rec is not None and rec.get("mtime") == st.st_mtime and rec.get("size") == st.st_size
        if done and not args.dry_run:
            print(f"[스킵] {path.name} (이미 임베딩됨, {rec['chunk_count']}청크)")
            grand += rec["chunk_count"]
            continue
        print(f"[처리] {path.name} ({st.st_size:,} bytes)")
        n = process_file(path, args.dry_run)
        grand += n
        if not args.dry_run:
            manifest["files"][path.name] = {
                "mtime": st.st_mtime,
                "size": st.st_size,
                "chunk_count": n,
                "embedded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }
            save_manifest(manifest)

    print(f"\n[완료] 총 {grand}청크 ({'dry-run' if args.dry_run else '임베딩 저장 완료'})")


if __name__ == "__main__":
    main()
