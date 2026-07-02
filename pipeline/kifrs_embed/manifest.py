#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""임베딩 완료 여부를 소스 파일 단위로 추적하는 manifest. nts_scraper/embed의 패턴과 동일."""
import datetime
import json
from pathlib import Path

MANIFEST_FILE = Path(__file__).resolve().parent / "embedded_manifest.json"


def load_manifest():
    if MANIFEST_FILE.exists():
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8-sig"))
    return {"files": {}}


def save_manifest(m):
    MANIFEST_FILE.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


def is_file_done(m, filename, mtime, size):
    rec = m["files"].get(filename)
    return rec is not None and rec["mtime"] == mtime and rec["size"] == size


def mark_file_done(m, filename, mtime, size, chunk_count):
    m["files"][filename] = {
        "mtime": mtime,
        "size": size,
        "chunk_count": chunk_count,
        "embedded_at": datetime.datetime.now().isoformat(),
    }
