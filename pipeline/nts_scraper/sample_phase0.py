#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
국세청 국세법령정보시스템 - 질의회신 Phase 0 샘플 스크레이퍼
최근 5건의 목록 + 전체 본문을 가져와 md 파일로 저장한다.

검증된 API:
  POST https://taxlaw.nts.go.kr/action.do  (form: actionId, paramData=JSON)
  - 목록: actionId=ASIPDI002PR01  -> data.ASIPDI002PR01.body[]
  - 본문: actionId=ASIQTB002PR01  -> data.ASIQTB002PR01.dcmDVO
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import ssl
from pathlib import Path

BASE = "https://taxlaw.nts.go.kr"
LIST_PAGE = f"{BASE}/qt/USEQTJ001M.do"
ACTION = f"{BASE}/action.do"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# 정부 사이트 인증서 체인 이슈 회피 (curl -k 와 동일)
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
    """첫 GET 으로 JSESSIONID 등 세션 쿠키 획득."""
    req = urllib.request.Request(LIST_PAGE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, context=_CTX, timeout=30) as resp:
        _store_cookies(resp)


def do_action(action_id, param_obj, referer=LIST_PAGE):
    body = urllib.parse.urlencode({
        "actionId": action_id,
        "paramData": json.dumps(param_obj, ensure_ascii=False),
    }).encode("utf-8")
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
        raise RuntimeError(f"{action_id} failed: {data.get('status')} / {data.get('message')}")
    return data["data"][action_id]


def fetch_list(view_count=5, start_count=1):
    param = {
        "collectionName": "question,question_gr",
        "dcmClCdCtl": ["001_02"],          # 001_02 = 질의회신
        "qstnPrdcOrgnClCtl": [],
        "sortField": "DCM_RGT_DTM/DESC",   # 생산일자 최신순
        "schDtBase": "DCM_RGT_DTM",
        "bltnStrtDt": "",
        "bltnEndDt": "",
        "startCount": start_count,
        "viewCount": view_count,
        "rltnStttCtl": [],
    }
    return do_action("ASIPDI002PR01", param)["body"]


def fetch_body(doc_id):
    referer = f"{BASE}/qt/USEQTA002P.do?ntstDcmId={doc_id}"
    dvo = do_action("ASIQTB002PR01", {"dcmDVO": {"ntstDcmId": doc_id}}, referer=referer)
    return dvo["dcmDVO"]


def clean(html):
    """간단한 태그/엔티티 정리."""
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
    if s and len(s) >= 8:
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return s or ""


def main():
    out_dir = Path(__file__).resolve().parent / "data"
    out_dir.mkdir(exist_ok=True)
    out_file = out_dir / "sample_질의회신_최근5건.md"

    print("[1/3] 세션 획득...")
    get_session()

    print("[2/3] 목록 조회 (최근 5건)...")
    items = fetch_list(view_count=5)
    print(f"      {len(items)}건 수신")

    lines = ["# 질의회신 최근 5건 (Phase 0 샘플)\n"]
    for idx, it in enumerate(items, 1):
        dcm = it["dcm"]
        doc_id = dcm["DOC_ID"]
        print(f"[3/3] 본문 수집 {idx}/{len(items)}  DOC_ID={doc_id}")
        body = fetch_body(doc_id)
        time.sleep(1)  # 서버 배려

        # 첨부파일 ID (질의 전문 등 원문 문서)
        atts = [body.get("fleId"), body.get("ntstWpFleId")]
        atts = [a for a in atts if a]

        lines.append(f"## {idx}. {clean(body.get('ntstDcmTtl'))}\n")
        lines.append(f"- 문서ID: `{doc_id}`")
        lines.append(f"- 문서종류: {dcm.get('LBL1_TTL', '')}")
        lines.append(f"- 세목: {dcm.get('NTST_TLAW_CL_NM', '')}")
        lines.append(f"- 생산일자: {fmt_date(body.get('ntstDcmRgtDt'))}")
        lines.append(f"- 질의문서번호: {clean(body.get('ntstDcmDscmCntn'))}")
        lines.append(f"- 회신문서번호: {clean(body.get('ntstDcmRplyCntn'))}")
        lines.append(f"- 주제어: {clean(body.get('ntstDcmMatrCntn'))}")
        if atts:
            lines.append(f"- 첨부파일ID: {', '.join(atts)}")
        lines.append("")
        lines.append(f"### 요지\n\n{clean(body.get('ntstDcmGistCntn'))}\n")
        lines.append(f"### 회신내용\n\n{clean(body.get('ntstDcmCntn'))}\n")
        lines.append("\n---\n")

    out_file.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n저장 완료: {out_file}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
