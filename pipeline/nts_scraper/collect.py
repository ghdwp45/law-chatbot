#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
국세청 국세법령정보시스템 - 질의회신 Phase 0 전량 수집기 (중단/재개 지원)

- 세목: 상속증여세(308)/종합부동산세(311)/소비세(313)/교육세(315)/농어촌특별세 제외한 나머지
- 출력: data/질의회신_YYYY-MM.md (생산월 단위 누적)
- 진행상태: state.json (수집한 DOC_ID 집합 + 마지막 위치) → 언제 꺼도 재실행 시 이어받음

사용법:
    py collect.py              # 이어서 수집 (state.json 있으면 자동 재개)
    py collect.py --limit 30   # 이번 실행에서 최대 30건만 (테스트용)
    py collect.py --sleep 0.5  # 본문 호출 간 대기(초), 기본 0.5
"""
import argparse
import json
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# Windows 콘솔(cp949)에서 한글/특수문자 print 시 인코딩 에러 방지
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

BASE = "https://taxlaw.nts.go.kr"
LIST_PAGE = f"{BASE}/qt/USEQTJ001M.do"
ACTION = f"{BASE}/action.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# 수집 대상 세목 코드(300번대 완전분류에서 제외 세목 뺀 나머지)
INCLUDE_TLAW = ["301", "302", "303", "305", "306", "307",
                "309", "310", "312", "314", "999"]
VIEW_COUNT = 50

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
STATE_FILE = ROOT / "state.json"

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
            # 연결 끊김(10054)·타임아웃 등: 백오프 후 세션 재수립하고 재시도
            wait = min(60, 3 * (attempt + 1))
            print(f"  [재시도 {attempt + 1}/{retries}] {action_id}: {e} ({wait}s 후)", flush=True)
            time.sleep(wait)
            try:
                get_session()  # 쿠키/연결 갱신
            except Exception:  # noqa: BLE001
                pass
    raise RuntimeError(f"{action_id} 실패(재시도 {retries}회): {last}")


# 목록 API 딥페이징 상한 (이 값 초과 startCount는 빈 결과)
PAGE_CAP = 2350


def _list_param(start_count, strt, end, view):
    return {
        "collectionName": "question,question_gr",
        "dcmClCdCtl": ["001_02"],
        "qstnPrdcOrgnClCtl": [],
        "sortField": "DCM_RGT_DTM/DESC",
        "schDtBase": "DCM_RGT_DTM",
        "bltnStrtDt": strt,
        "bltnEndDt": end,
        "startCount": start_count,
        "viewCount": view,
        "rltnStttCtl": [],
        "ntstTlawClCdList": INCLUDE_TLAW,
    }


def fetch_list(start_count, strt="", end=""):
    return do_action("ASIPDI002PR01", _list_param(start_count, strt, end, VIEW_COUNT))["body"]


def count_range(strt, end):
    """해당 생산일자 구간(YYYYMMDD)의 001_02 총 건수."""
    res = do_action("ASIPDI002PR01", _list_param(1, strt, end, 1))
    cm = res["top"][0]["categoryMap"]["SUB_ID_CATEGORY"]
    return sum(int(x["count"]) for x in cm if x["name"] == "001_02")


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


def make_windows(start_year, end_year):
    """생산일자 윈도우 목록 생성. 연 단위 기준, 2350건 넘는 해는 월 단위로 세분화."""
    windows = []
    for y in range(start_year, end_year + 1):
        ys, ye = f"{y}0101", f"{y}1231"
        c = count_range(ys, ye)
        if c == 0:
            continue
        if c < PAGE_CAP:
            windows.append((ys, ye, c))
        else:
            # 월 단위로 분할 (월도 초과하면 일 단위)
            for m in range(1, 13):
                ms = f"{y}{m:02d}01"
                me = f"{y}{m:02d}{_last_day(y, m):02d}"
                mc = count_range(ms, me)
                if mc == 0:
                    continue
                if mc < PAGE_CAP:
                    windows.append((ms, me, mc))
                else:
                    for d in range(1, _last_day(y, m) + 1):
                        ds = f"{y}{m:02d}{d:02d}"
                        windows.append((ds, ds, None))  # 일 단위(건수 미조회)
    return windows


def _last_day(y, m):
    if m == 12:
        return 31
    import datetime
    return (datetime.date(y, m + 1, 1) - datetime.timedelta(days=1)).day


def load_state():
    if STATE_FILE.exists():
        s = json.loads(STATE_FILE.read_text(encoding="utf-8-sig"))
        s["done_ids"] = set(s.get("done_ids", []))
        s.setdefault("done_windows", [])
        s["done_windows"] = set(tuple(w) for w in s["done_windows"])
        return s
    return {"done_ids": set(), "done_windows": set(), "collected": 0}


def save_state(state):
    out = dict(state)
    out["done_ids"] = sorted(state["done_ids"])
    out["done_windows"] = sorted(list(w) for w in state["done_windows"])
    STATE_FILE.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")


def append_md(body, dcm):
    tlaw = (dcm.get("NTST_TLAW_CL_NM") or "기타").strip()
    tlaw = re.sub(r'[\\/:*?"<>|]', "_", tlaw) or "기타"
    f = DATA_DIR / f"질의회신_{tlaw}.md"
    atts = [a for a in (body.get("fleId"), body.get("ntstWpFleId")) if a]
    block = [
        f"## {clean(body.get('ntstDcmTtl'))}\n",
        f"- 문서ID: `{body.get('ntstDcmId')}`",
        f"- 문서종류: {dcm.get('LBL1_TTL', '')}",
        f"- 세목: {dcm.get('NTST_TLAW_CL_NM', '')}",
        f"- 생산일자: {fmt_date(body.get('ntstDcmRgtDt'))}",
        f"- 질의문서번호: {clean(body.get('ntstDcmDscmCntn'))}",
        f"- 회신문서번호: {clean(body.get('ntstDcmRplyCntn'))}",
        f"- 주제어: {clean(body.get('ntstDcmMatrCntn'))}",
    ]
    if atts:
        block.append(f"- 첨부파일ID: {', '.join(atts)}")
    block.append("")
    block.append(f"### 요지\n\n{clean(body.get('ntstDcmGistCntn'))}\n")
    block.append(f"### 회신내용\n\n{clean(body.get('ntstDcmCntn'))}\n")
    block.append("\n---\n")
    text = "\n".join(block) + "\n"
    # 파일이 백신/인덱서 등에 일시적으로 잠길 수 있어(PermissionError) 재시도
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


def collect_window(state, win, sleep_s, limit, this_run_ref):
    """한 날짜 윈도우 수집. 날짜필터 시 deep-paging이 막히므로, 윈도우 내 전체를
    단일 요청(viewCount 크게)으로 받는다. 윈도우 건수 < PAGE_CAP 보장 전제."""
    strt, end, _ = win
    # 윈도우 전체를 한 번에 (2350 미만 보장 → viewCount 2400이면 충분)
    items = do_action("ASIPDI002PR01", _list_param(1, strt, end, PAGE_CAP + 50))["body"]
    for it in items:
        dcm = it["dcm"]
        doc_id = dcm["DOC_ID"]
        if doc_id in state["done_ids"]:
            continue
        body = fetch_body(doc_id)
        append_md(body, dcm)
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
            return None  # 중단 신호
    return True  # 윈도우 완료


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="이번 실행 최대 수집 건수(0=무제한)")
    ap.add_argument("--sleep", type=float, default=0.5, help="본문 호출 간 대기(초)")
    ap.add_argument("--start-year", type=int, default=1953, help="수집 시작 연도")
    ap.add_argument("--end-year", type=int, default=2026, help="수집 종료 연도")
    args = ap.parse_args()

    DATA_DIR.mkdir(exist_ok=True)
    state = load_state()
    print(f"재개: 누적 수집={state['collected']}건, 완료 윈도우={len(state['done_windows'])}개")

    get_session()

    print("날짜 윈도우 계산 중...(연/월 건수 조회)")
    windows = make_windows(args.start_year, args.end_year)
    total_planned = sum(w[2] for w in windows if w[2])
    print(f"윈도우 {len(windows)}개, 예상 대상 약 {total_planned:,}건+ (일단위 윈도우 제외)")

    this_run = [0]
    try:
        for win in windows:
            key = (win[0], win[1])
            if key in state["done_windows"]:
                continue
            result = collect_window(state, win, args.sleep, args.limit, this_run)
            if result is None:  # limit 중단
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
    print(f"\n[완료] 전량 수집 끝. 총 {state['collected']}건.")


if __name__ == "__main__":
    main()
