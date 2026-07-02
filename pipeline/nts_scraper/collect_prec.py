#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
국세청 국세법령정보시스템 - 판례·결정례 전량 수집기 (중단/재개 지원)

대상(컬렉션 precedent,precedent_gr, 분류코드 dcmClCdCtl):
    001_05 과세적부 / 001_06 이의신청 / 001_07 심사청구 /
    001_08 심판청구(조세심판원) / 001_09 판례(법원) / 001_10 헌재
    (003_01 감사원심사는 기본 제외 — --codes로 추가 가능)
  → 6개 합 약 151,376건 (2026-06-26 확인)

- 출력: data/판례결정례/{종류}_{세목}.md  (세목명 NTST_TLAW_CL_NM 기준으로 법인세/소득세/부가세 등 자동 구분)
- 진행상태: state_prec.json (질의회신 state.json과 분리 → 서로 간섭 없음)
- 본문 API(ASIQTB002PR01)는 질의회신과 동일 필드. ntstDcmDscmCntn = 사건번호(조심/법원 사건번호).

사용법:
    py collect_prec.py                 # 전량 이어서 수집 (state_prec.json 자동 재개)
    py collect_prec.py --limit 30      # 이번 실행 최대 30건만 (테스트)
    py collect_prec.py --sleep 0.3     # 본문 호출 간격(초), 기본 0.5
    py collect_prec.py --codes 001_08,001_09   # 특정 분류만
"""
import argparse
import datetime
import json
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

BASE = "https://taxlaw.nts.go.kr"
LIST_PAGE = f"{BASE}/qt/USEQTJ001M.do"
ACTION = f"{BASE}/action.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# 분류코드 → 종류 라벨(파일명 접두)
CODE_LABEL = {
    "001_05": "과세적부",
    "001_06": "이의신청",
    "001_07": "심사청구",
    "001_08": "심판청구",
    "001_09": "판례",
    "001_10": "헌재",
    "003_01": "감사원심사",
}
DEFAULT_CODES = ["001_05", "001_06", "001_07", "001_08", "001_09", "001_10"]

VIEW_COUNT = 50
PAGE_CAP = 2350  # 목록 딥페이징 상한

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data" / "판례결정례"
STATE_FILE = ROOT / "state_prec.json"

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE
_cookies = {}


def _store_cookies(resp):
    for h in resp.headers.get_all("Set-Cookie") or []:
        kv = h.split(";", 1)[0]
        if "=" in kv:
            k, v = kv.split("=", 1)
            _cookies[k.strip()] = v.strip()


def _cookie_header():
    return "; ".join(f"{k}={v}" for k, v in _cookies.items())


def get_session():
    req = urllib.request.Request(LIST_PAGE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, context=_CTX, timeout=30) as resp:
        _store_cookies(resp)


def do_action(action_id, param_obj, referer=LIST_PAGE, retries=8):
    body = urllib.parse.urlencode({
        "actionId": action_id,
        "paramData": json.dumps(param_obj, ensure_ascii=False),
    }).encode("utf-8")
    last = None
    for attempt in range(retries):
        try:
            headers = {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": referer,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Cookie": _cookie_header(),
            }
            req = urllib.request.Request(ACTION, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, context=_CTX, timeout=60) as resp:
                _store_cookies(resp)
                raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            if data.get("status") != "SUCCESS":
                raise RuntimeError(f"{action_id}: status={data.get('status')}")
            return data["data"][action_id]
        except Exception as e:  # noqa: BLE001
            last = e
            wait = min(60, 3 * (attempt + 1))
            print(f"  [재시도 {attempt + 1}/{retries}] {action_id}: {e} ({wait}s 후)", flush=True)
            time.sleep(wait)
            try:
                get_session()
            except Exception:  # noqa: BLE001
                pass
    raise RuntimeError(f"{action_id} 실패(재시도 {retries}회): {last}")


def _list_param(code, start_count, strt, end, view):
    return {
        "collectionName": "precedent,precedent_gr",
        "dcmClCdCtl": [code],
        "qstnPrdcOrgnClCtl": [],
        "sortField": "DCM_RGT_DTM/DESC",
        "schDtBase": "DCM_RGT_DTM",
        "bltnStrtDt": strt,
        "bltnEndDt": end,
        "startCount": start_count,
        "viewCount": view,
        "rltnStttCtl": [],
    }


def count_range(code, strt, end):
    """해당 분류코드·생산일자 구간(YYYYMMDD)의 총 건수."""
    res = do_action("ASIPDI002PR01", _list_param(code, 1, strt, end, 1))
    cm = res["top"][0]["categoryMap"]["SUB_ID_CATEGORY"]
    return sum(int(x["count"]) for x in cm if x["name"] == code)


def fetch_body(doc_id):
    referer = f"{BASE}/qt/USEQTA002P.do?ntstDcmId={doc_id}"
    dvo = do_action("ASIQTB002PR01", {"dcmDVO": {"ntstDcmId": doc_id}}, referer=referer)
    return dvo["dcmDVO"]


def clean(html):
    if not html:
        return ""
    t = html.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&nbsp;", " ")
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"</p>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def fmt_date(s):
    return f"{s[0:4]}-{s[4:6]}-{s[6:8]}" if s and len(s) >= 8 else (s or "")


def _last_day(y, m):
    if m == 12:
        return 31
    return (datetime.date(y, m + 1, 1) - datetime.timedelta(days=1)).day


def make_windows(code, start_year, end_year):
    """분류코드별 생산일자 윈도우. 연 기준, 2350건 초과 해는 월→일 단위로 세분."""
    windows = []
    for y in range(start_year, end_year + 1):
        ys, ye = f"{y}0101", f"{y}1231"
        c = count_range(code, ys, ye)
        if c == 0:
            continue
        if c < PAGE_CAP:
            windows.append((ys, ye, c))
        else:
            for m in range(1, 13):
                ms = f"{y}{m:02d}01"
                me = f"{y}{m:02d}{_last_day(y, m):02d}"
                mc = count_range(code, ms, me)
                if mc == 0:
                    continue
                if mc < PAGE_CAP:
                    windows.append((ms, me, mc))
                else:
                    for d in range(1, _last_day(y, m) + 1):
                        ds = f"{y}{m:02d}{d:02d}"
                        windows.append((ds, ds, None))
    return windows


def load_state():
    if STATE_FILE.exists():
        s = json.loads(STATE_FILE.read_text(encoding="utf-8-sig"))
        s["done_ids"] = set(s.get("done_ids", []))
        s.setdefault("done_windows", [])
        s["done_windows"] = set(tuple(w) for w in s["done_windows"])
        s.setdefault("collected", 0)
        return s
    return {"done_ids": set(), "done_windows": set(), "collected": 0}


def save_state(state):
    out = dict(state)
    out["done_ids"] = sorted(state["done_ids"])
    out["done_windows"] = sorted(list(w) for w in state["done_windows"])
    STATE_FILE.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")


def append_md(body, dcm, code):
    jong = CODE_LABEL.get(code, "기타")
    tlaw = (dcm.get("NTST_TLAW_CL_NM") or "기타").strip() or "기타"
    safe = lambda s: re.sub(r'[\\/:*?"<>|]', "_", s)
    f = DATA_DIR / f"{safe(jong)}_{safe(tlaw)}.md"
    atts = [a for a in (body.get("fleId"), body.get("ntstWpFleId")) if a]
    block = [
        f"## {clean(body.get('ntstDcmTtl'))}\n",
        f"- 문서ID: `{body.get('ntstDcmId')}`",
        f"- 문서종류: {clean(body.get('ntstDcmClNm')) or jong}",
        f"- 사건번호: {clean(body.get('ntstDcmDscmCntn'))}",
        f"- 세목: {dcm.get('NTST_TLAW_CL_NM', '')}",
        f"- 생산일자: {fmt_date(body.get('ntstDcmRgtDt'))}",
        f"- 주제어: {clean(body.get('ntstDcmMatrCntn'))}",
    ]
    if atts:
        block.append(f"- 첨부파일ID: {', '.join(atts)}")
    block.append("")
    block.append(f"### 요지\n\n{clean(body.get('ntstDcmGistCntn'))}\n")
    block.append(f"### 내용\n\n{clean(body.get('ntstDcmCntn'))}\n")
    block.append("\n---\n")
    text = "\n".join(block) + "\n"
    for attempt in range(10):
        try:
            with f.open("a", encoding="utf-8") as fh:
                fh.write(text)
            return
        except PermissionError as e:
            if attempt == 9:
                raise
            print(f"  [파일잠금 재시도 {attempt + 1}/10] {f.name}: {e}", flush=True)
            time.sleep(3)


def collect_window(state, code, win, sleep_s, limit, this_run_ref):
    strt, end, _ = win
    items = do_action("ASIPDI002PR01", _list_param(code, 1, strt, end, PAGE_CAP + 50))["body"]
    for it in items:
        dcm = it["dcm"]
        doc_id = dcm["DOC_ID"]
        if doc_id in state["done_ids"]:
            continue
        body = fetch_body(doc_id)
        append_md(body, dcm, code)
        state["done_ids"].add(doc_id)
        state["collected"] += 1
        this_run_ref[0] += 1
        time.sleep(sleep_s)
        if this_run_ref[0] % 20 == 0:
            save_state(state)
            print(f"  ...누적 {state['collected']}건 (이번 실행 {this_run_ref[0]})")
        if limit and this_run_ref[0] >= limit:
            save_state(state)
            print(f"\n[중단] limit {limit} 도달. 누적 {state['collected']}건. 재실행 시 이어감.")
            return None
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="이번 실행 최대 수집 건수(0=무제한)")
    ap.add_argument("--sleep", type=float, default=0.5, help="본문 호출 간 대기(초)")
    ap.add_argument("--start-year", type=int, default=1950, help="수집 시작 연도")
    ap.add_argument("--end-year", type=int, default=2026, help="수집 종료 연도")
    ap.add_argument("--codes", type=str, default="", help="분류코드 콤마구분(미지정 시 6개 기본)")
    args = ap.parse_args()

    codes = [c.strip() for c in args.codes.split(",") if c.strip()] or DEFAULT_CODES

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    print(f"재개: 누적 수집={state['collected']}건, 완료 윈도우={len(state['done_windows'])}개")
    print(f"대상 분류: {', '.join(f'{c}({CODE_LABEL.get(c, c)})' for c in codes)}")

    get_session()

    this_run = [0]
    try:
        for code in codes:
            print(f"\n=== [{code} {CODE_LABEL.get(code, '')}] 날짜 윈도우 계산 중...")
            windows = make_windows(code, args.start_year, args.end_year)
            planned = sum(w[2] for w in windows if w[2])
            print(f"    윈도우 {len(windows)}개, 예상 약 {planned:,}건+ (일단위 제외)")
            for win in windows:
                key = (code, win[0], win[1])
                if key in state["done_windows"]:
                    continue
                result = collect_window(state, code, win, args.sleep, args.limit, this_run)
                if result is None:
                    return
                state["done_windows"].add(key)
                save_state(state)
    except KeyboardInterrupt:
        save_state(state)
        print(f"\n[중단] 사용자 종료. 누적 {state['collected']}건 저장됨. 재실행 시 이어감.")
        return
    except Exception as e:  # noqa: BLE001
        save_state(state)
        print(f"\n[오류] {e}\n  누적 {state['collected']}건까지 저장됨. 재실행 시 이어감.", file=sys.stderr)
        sys.exit(1)

    save_state(state)
    print(f"\n[완료] 판례·결정례 전량 수집 끝. 총 {state['collected']}건.")


if __name__ == "__main__":
    main()
