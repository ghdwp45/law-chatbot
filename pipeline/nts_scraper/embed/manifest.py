#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""임베딩 완료 여부를 소스 파일/폴더 단위로 추적하는 manifest. collect.py의
load_state/save_state 패턴을 그대로 모사한다."""
import datetime
import json
from pathlib import Path

MANIFEST_FILE = Path(__file__).resolve().parent / "embedded_manifest.json"


def load_manifest():
    if MANIFEST_FILE.exists():
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8-sig"))
    return {"legacy_files": {}, "incremental_dirs": {}}


def save_manifest(m):
    MANIFEST_FILE.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


def is_legacy_file_done(m, filename, mtime, size):
    rec = m["legacy_files"].get(filename)
    return rec is not None and rec["mtime"] == mtime and rec["size"] == size


def mark_legacy_file_done(m, filename, mtime, size, chunk_count):
    m["legacy_files"][filename] = {
        "mtime": mtime,
        "size": size,
        "chunk_count": chunk_count,
        "embedded_at": datetime.datetime.now().isoformat(),
    }


def is_incremental_dir_done(m, dirname):
    return dirname in m["incremental_dirs"]


def mark_incremental_dir_done(m, dirname, chunk_count):
    m["incremental_dirs"][dirname] = {
        "chunk_count": chunk_count,
        "embedded_at": datetime.datetime.now().isoformat(),
    }
