#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NTS 질의회신 md 파일을 문서 단위로 파싱하고, 임베딩용 청크로 변환한다.

md 포맷(collect.py의 append_md()가 생성):
    ## 제목

    - 문서ID: `...`
    - 문서종류: ...
    - 세목: ...
    - 생산일자: YYYY-MM-DD
    - 질의문서번호: ...
    - 회신문서번호: ...
    - 주제어: ...
    - 첨부파일ID: ... (있을 때만)

    ### 요지

    ...

    ### 회신내용

    ...

    ---
"""
import datetime
import re

try:
    import tiktoken
    _ENCODER = tiktoken.get_encoding("cl100k_base")
except Exception:  # noqa: BLE001
    _ENCODER = None

DOC_SPLIT_RE = re.compile(r"(?m)^## ")
META_LINE_RE = re.compile(r"^- ([^:：]+):\s*(.*)$")
# gemini-embedding-001은 입력 ~2,048토큰(≈ cl100k ~3,000토큰) 초과분을 에러 없이 잘라
# 앞부분만 임베딩한다(내용 손실). 안전 마진 두고 cl100k 2,000으로 제한.
# (현 NTS 데이터 최장 청크는 1,967토큰이라 실제 분할은 거의 안 일어나지만, 향후 증분분 안전장치.)
MAX_TOKENS = 2000


def _count_tokens(text):
    if _ENCODER is None:
        # tiktoken 미설치 시 대략치(한글 기준 바이트/2.2 ≈ 토큰수)
        return len(text.encode("utf-8")) // 2
    return len(_ENCODER.encode(text))


def _extract_section(body, heading):
    m = re.search(rf"### {heading}\n+([\s\S]*?)(?=\n### |\n---\s*$|\Z)", body)
    return m.group(1).strip() if m else ""


def _valid_date(s):
    """YYYY-MM-DD 형식 검증. 원본 API 데이터에 존재하지 않는 날짜(예: 2011-04-86)가
    섞여 있어 그대로 DB에 넣으면 Postgres가 거부하므로 무효면 None으로 치환."""
    if not s:
        return None
    try:
        datetime.date.fromisoformat(s)
        return s
    except (ValueError, TypeError):
        return None


def parse_md_file(text):
    """파일 전체 텍스트 -> 문서 dict 리스트."""
    text = text.replace("\r\n", "\n")  # 원본이 CRLF라 \n\n 기준 섹션 추출이 깨지는 것 방지
    raw_blocks = DOC_SPLIT_RE.split(text)
    docs = []
    for block in raw_blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        title = lines[0].strip()
        body = "\n".join(lines[1:])

        meta = {}
        for line in body.split("\n"):
            stripped = line.strip()
            if stripped.startswith("### "):
                break
            m = META_LINE_RE.match(stripped)
            if m:
                meta[m.group(1).strip()] = m.group(2).strip()

        doc_id = meta.get("문서ID", "").strip("`").strip()
        if not doc_id:
            continue  # 메타데이터 파싱 실패한 블록은 건너뜀(파일 끝 빈 블록 등)

        docs.append({
            "title": title,
            "doc_id": doc_id,
            "doc_type": meta.get("문서종류", ""),
            "tlaw": meta.get("세목", ""),
            "prod_date": _valid_date(meta.get("생산일자", "")),
            "qstn_no": meta.get("질의문서번호", ""),
            "reply_no": meta.get("회신문서번호", ""),
            "keywords": meta.get("주제어", ""),
            "gist": _extract_section(body, "요지"),
            "reply": _extract_section(body, "회신내용"),
        })

    # 수집 단계(collect.py)에서 중단/재개가 겹치며 같은 문서ID가 두 번 들어간 경우가
    # 있어(예: 질의회신_국세기본.md에 7건), 같은 배치 안에서 동일 doc_id가 중복되면
    # Postgres upsert(ON CONFLICT)가 "같은 행을 한 번에 두 번 갱신" 에러를 내므로 여기서 제거.
    seen_ids = set()
    deduped = []
    for d in docs:
        if d["doc_id"] in seen_ids:
            continue
        seen_ids.add(d["doc_id"])
        deduped.append(d)
    return deduped


def _header(doc):
    return (
        f"[{doc['tlaw']}] {doc['title']}\n"
        f"문서종류: {doc['doc_type']} | 생산일자: {doc['prod_date']} | "
        f"질의문서번호: {doc['qstn_no']} | 회신문서번호: {doc['reply_no']}\n"
    )


def doc_to_chunks(doc):
    """1문서 -> 1개 이상의 청크(dict 리스트, doc의 필드를 모두 포함하고 content/chunk_index/chunk_total 추가)."""
    header = _header(doc)
    full_text = f"{header}\n### 요지\n{doc['gist']}\n\n### 회신내용\n{doc['reply']}"
    if _count_tokens(full_text) <= MAX_TOKENS:
        return [{**doc, "content": full_text, "chunk_index": 0, "chunk_total": 1}]

    # 장문 문서: 회신내용을 단락 단위로 분할
    paragraphs = doc["reply"].split("\n\n") or [doc["reply"]]
    chunks, cur = [], ""
    for p in paragraphs:
        candidate = (cur + "\n\n" + p) if cur else p
        if cur and _count_tokens(header + candidate) > MAX_TOKENS:
            chunks.append(cur)
            cur = p
        else:
            cur = candidate
    if cur:
        chunks.append(cur)
    if not chunks:
        chunks = [doc["reply"]]

    result = []
    for i, c in enumerate(chunks):
        content = (
            f"{header}\n### 요지\n{doc['gist']}\n\n"
            f"### 회신내용(부분 {i + 1}/{len(chunks)})\n{c}"
        )
        result.append({**doc, "content": content, "chunk_index": i, "chunk_total": len(chunks)})
    return result


# ---------------------------------------------------------------------------
# 기재부(기획재정부) 세법해석 사례
# md 포맷:
#   # 기획재정부 <부서명> 세법해석 사례
#   **분류**: 예규·판례
#   ---
#
#   ## [문서번호] 제목
#
#   | 항목 | 내용 |
#   |---|---|
#   | 문서번호 | ... |
#   | 회신일자 | ... |
#   | 분류 | ... |
#
#   ### 질의요지
#   > ...
#
#   ### 회신요지
#   > ...
#
#   ### 관련법령
#   ...
#
#   ---
# ---------------------------------------------------------------------------

MOF_SPLIT_RE = re.compile(r"(?m)^## \[")
MOF_HEAD_RE = re.compile(r"^([^\]]+)\]\s*(.*)$")
TABLE_ROW_RE = re.compile(r"^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$")
MOF_DATE_RE = re.compile(r"^(\d{4})\.(\d{2})\.(\d{2})\.?$")


def _mof_date_to_iso(s):
    """'2021.10.28.' -> '2021-10-28'. 형식이 다르거나 무효한 날짜(예: 04.86)는 None."""
    if not s:
        return None
    m = MOF_DATE_RE.match(s.strip())
    if not m:
        return None
    iso = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return _valid_date(iso)


def parse_mof_file(text):
    """기재부 세법해석 사례 md -> 문서 dict 리스트."""
    text = text.replace("\r\n", "\n")
    dept_m = re.search(r"^#\s*기획재정부\s*(.*?)\s*세법해석 사례", text, re.M)
    dept = dept_m.group(1).strip() if dept_m else ""

    raw_blocks = MOF_SPLIT_RE.split(text)
    docs = []
    for block in raw_blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        m = MOF_HEAD_RE.match(lines[0].strip())
        if not m:
            continue
        doc_no, title = m.group(1).strip(), m.group(2).strip()
        body = "\n".join(lines[1:])

        meta = {}
        for line in body.split("\n"):
            tm = TABLE_ROW_RE.match(line.strip())
            if tm and tm.group(1) not in ("항목", "---"):
                meta[tm.group(1).strip()] = tm.group(2).strip()

        qstn = re.sub(r"(?m)^>\s?", "", _extract_section(body, "질의요지")).strip()
        reply = re.sub(r"(?m)^>\s?", "", _extract_section(body, "회신요지")).strip()
        related_law = _extract_section(body, "관련법령")

        docs.append({
            "doc_no": doc_no,  # 화면 표시/인용용 원본 문서번호(부서가 연도 넘어 재사용할 수 있어 고유하지 않음)
            "title": title,
            "dept": dept,
            "doc_type": meta.get("분류", "예규·판례"),
            "reply_date": _mof_date_to_iso(meta.get("회신일자")),
            "qstn": qstn,
            "reply": reply,
            "related_law": related_law,
        })

    # 같은 부서가 문서번호를 다른 연도에 재사용하는 경우가 있어(예: "관세제도과-78"이
    # 2025년·2019년 두 건에 쓰임) 문서번호만으로는 DB의 고유키(doc_id)가 될 수 없다.
    # 회신일자를 더해 고유화하고, 그래도 겹치면(완전 동일 문서번호+일자) 순번을 덧붙인다.
    seen = {}
    for d in docs:
        base_id = f"{d['doc_no']}_{d['reply_date'] or 'NA'}"
        seen[base_id] = seen.get(base_id, 0) + 1
        d["doc_id"] = base_id if seen[base_id] == 1 else f"{base_id}_{seen[base_id]}"
    return docs


def mof_doc_to_chunks(doc):
    header = (
        f"[기획재정부 {doc['dept']}] {doc['title']}\n"
        f"문서번호: {doc['doc_no']} | 회신일자: {doc['reply_date']} | 분류: {doc['doc_type']}\n"
    )
    body = f"### 질의요지\n{doc['qstn']}\n\n### 회신요지\n{doc['reply']}\n\n### 관련법령\n{doc['related_law']}"
    parts = _split_long_text_generic(header, body)
    return [
        {
            "doc_id": doc["doc_id"],  # DB 고유키(문서번호+일자, 부서가 연도 넘어 재사용해도 충돌 안 함)
            "doc_no": doc["doc_no"],  # 화면 표시/인용용 원본 문서번호
            "chunk_index": i,
            "chunk_total": len(parts),
            "content": p,
            "title": doc["title"],
            "doc_type": f"기재부 {doc['doc_type']}",
            "dept": doc["dept"],
            "reply_date": doc["reply_date"],
        }
        for i, p in enumerate(parts)
    ]


# ---------------------------------------------------------------------------
# 판례·결정례 (판례/심판청구/심사청구/이의신청/과세적부)
# md 포맷(collect_prec.py 생성, 5개 유형 동일):
#   ## 제목
#
#   - 문서ID: `...`
#   - 문서종류: 판례|심판청구|심사청구|이의신청|과세적부
#   - 사건번호: ...
#   - 세목: ...
#   - 생산일자: YYYY-MM-DD
#   - 주제어: ...
#   - 첨부파일ID: ...
#
#   ### 요지
#   ...
#
#   ### 내용
#   결정 내용은 붙임과 같습니다.   (대부분 placeholder — 실제 본문은 첨부파일)
#
#   ---
# ---------------------------------------------------------------------------

# "결정 내용은 붙임과 같습니다" 류의 placeholder(공백·줄바꿈 무시하고 판정)
_PREC_PLACEHOLDER_RE = re.compile(r"^\s*결정\s*내용은?\s*붙임과\s*같습니다\.?\s*$")


def parse_prec_file(text):
    """판례·결정례 md -> 문서 dict 리스트. 질의회신과 메타 필드만 다름(사건번호)."""
    text = text.replace("\r\n", "\n")
    raw_blocks = DOC_SPLIT_RE.split(text)
    docs = []
    for block in raw_blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        title = lines[0].strip()
        body = "\n".join(lines[1:])

        meta = {}
        for line in body.split("\n"):
            stripped = line.strip()
            if stripped.startswith("### "):
                break
            m = META_LINE_RE.match(stripped)
            if m:
                meta[m.group(1).strip()] = m.group(2).strip()

        doc_id = meta.get("문서ID", "").strip("`").strip()
        if not doc_id:
            continue

        gist = _extract_section(body, "요지")
        content_body = _extract_section(body, "내용")
        if _PREC_PLACEHOLDER_RE.match(content_body):
            content_body = ""  # placeholder는 버림(임베딩에 노이즈)

        docs.append({
            "title": title,
            "doc_id": doc_id,
            "doc_type": meta.get("문서종류", ""),
            "case_no": meta.get("사건번호", ""),
            "tlaw": meta.get("세목", ""),
            "prod_date": _valid_date(meta.get("생산일자", "")),
            "keywords": meta.get("주제어", ""),
            "gist": gist,
            "content_body": content_body,
        })

    seen_ids = set()
    deduped = []
    for d in docs:
        if d["doc_id"] in seen_ids:
            continue
        seen_ids.add(d["doc_id"])
        deduped.append(d)
    return deduped


def prec_doc_to_chunks(doc):
    """판례 1문서 -> 청크 리스트. 임베딩 텍스트는 제목+요지(+실내용 있으면)."""
    header = (
        f"[{doc['tlaw']}] {doc['title']}\n"
        f"문서종류: {doc['doc_type']} | 사건번호: {doc['case_no']} | 생산일자: {doc['prod_date']}\n"
    )
    body = f"### 요지\n{doc['gist']}"
    if doc["content_body"]:
        body += f"\n\n### 내용\n{doc['content_body']}"

    parts = _split_long_text_generic(header, body)
    return [
        {
            "doc_id": doc["doc_id"],
            "chunk_index": i,
            "chunk_total": len(parts),
            "content": p,
            "title": doc["title"],
            "doc_type": doc["doc_type"],
            "case_no": doc["case_no"],
            "tlaw": doc["tlaw"],
            "prod_date": doc["prod_date"],
            "keywords": doc["keywords"],
        }
        for i, p in enumerate(parts)
    ]


def _split_long_text_generic(header, body, max_tokens=MAX_TOKENS):
    """헤더+본문이 토큰 상한을 넘으면 단락 단위로 서브분할(헤더는 각 조각에 반복 포함)."""
    full = f"{header}\n\n{body}"
    if _count_tokens(full) <= max_tokens:
        return [full]
    paragraphs = body.split("\n\n") or [body]
    parts, cur = [], ""
    for p in paragraphs:
        candidate = (cur + "\n\n" + p) if cur else p
        if cur and _count_tokens(header + "\n\n" + candidate) > max_tokens:
            parts.append(cur)
            cur = p
        else:
            cur = candidate
    if cur:
        parts.append(cur)
    if not parts:
        parts = [body]
    return [f"{header}\n\n(부분 {i + 1}/{len(parts)})\n{p}" for i, p in enumerate(parts)]
