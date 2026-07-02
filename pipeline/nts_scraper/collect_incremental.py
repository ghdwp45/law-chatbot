#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
국세청 국세법령정보시스템 - 질의회신 Phase 1 증분 수집기

- Phase 0(collect.py)가 모은 116,702건 이후의 신규 항목만 가져온다.
- state.json의 done_ids를 공유해서 중복 없이 신규 건만 판별한다.
- 최근 OVERLAP_DAYS일 구간만 조회(신규 등록 지연을 감안한 안전 여유분).
- 출력은 실행 당일 날짜 하위폴더: data/<YYYY-MM-DD>/질의회신_<세목명>.md

사용법:
    py collect_incremental.py              # 최근 60일 구간에서 신규분만 수집
    py collect_incremental.py --days 90    # 조회 구간 늘리기(예: 오래 PC를 안 켠 경우)
"""
import argparse
import datetime
import json
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
from collect import (  # noqa: E402
    DATA_DIR,
    PAGE_CAP,
    STATE_FILE,
    _list_param,
    append_md,
    do_action,
    get_session,
    load_state,
    save_state,
    fetch_body,
)

ROOT = Path(__file__).resolve().parent
OVERLAP_DAYS = 60


def collect_recent(state, days, sleep_s):
    today = datetime.date.today()
    strt = (today - datetime.timedelta(days=days)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")

    run_dir = DATA_DIR / today.strftime("%Y-%m-%d")
    run_dir.mkdir(parents=True, exist_ok=True)

    items = do_action("ASIPDI002PR01", _list_param(1, strt, end, PAGE_CAP + 50))["body"]
    new_count = 0
    for it in items:
        dcm = it["dcm"]
        doc_id = dcm["DOC_ID"]
        if doc_id in state["done_ids"]:
            continue
        body = fetch_body(doc_id)
        append_md_to_dir(run_dir, body, dcm)
        state["done_ids"].add(doc_id)
        state["collected"] += 1
        new_count += 1
        time.sleep(sleep_s)
        if new_count % 20 == 0:
            save_state(state)
            print(f"  ...신규 {new_count}건 수집 (전체 누적 {state['collected']}건)")
    return new_count


def append_md_to_dir(run_dir, body, dcm):
    """append_md와 동일한 포맷이지만 출력 폴더만 당일 증분 폴더로 바꾼다."""
    import collect as _c

    orig_dir = _c.DATA_DIR
    _c.DATA_DIR = run_dir
    try:
        append_md(body, dcm)
    finally:
        _c.DATA_DIR = orig_dir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=OVERLAP_DAYS, help="조회할 최근 일수(기본 60일)")
    ap.add_argument("--sleep", type=float, default=0.5, help="본문 호출 간 대기(초)")
    args = ap.parse_args()

    state = load_state()
    print(f"[증분] 시작 시각={datetime.datetime.now()}, 기존 누적={state['collected']}건")

    get_session()
    try:
        new_count = collect_recent(state, args.days, args.sleep)
    except Exception as e:  # noqa: BLE001
        save_state(state)
        print(f"\n[오류] {e}\n  신규 수집분은 저장됨. 누적 {state['collected']}건.", file=sys.stderr)
        sys.exit(1)

    save_state(state)
    print(f"\n[완료] 증분 수집 끝. 이번 실행 신규 {new_count}건, 전체 누적 {state['collected']}건.")


if __name__ == "__main__":
    main()
