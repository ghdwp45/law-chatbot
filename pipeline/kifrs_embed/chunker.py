#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
K-IFRS 자료(질의회신 QnA, 기준서/해석서 본문) md 파일을 청크로 변환한다.

두 가지 입력 포맷을 지원:
1. QnA 파일: `## [ID] 제목` + `- 일자:` + `- 관련기준:` 메타데이터 + 자유서식 본문,
   엔트리 구분자는 `---`. (parse_qna_file)
2. 기준서/해석서 파일: `# K-IFRS 기업회계기준서 제NNNN호` 최상위 제목 + `**분류**:` +
   `#### 제목 (문단범위)` 식의 중첩 헤딩(레벨 2~6)으로 문단 구간을 표시.
   해석서 파일 하나에 여러 기준서/해석서 문서가 묶여 있을 수 있음(최상위 `# ` 단위로 구분).
   (parse_standard_file)
"""
import datetime
import re

try:
    import tiktoken
    _ENCODER = tiktoken.get_encoding("cl100k_base")
except Exception:  # noqa: BLE001
    _ENCODER = None

# gemini-embedding-001은 입력이 약 2,048 토큰(≈ cl100k 기준 ~3,000 토큰)을 넘으면 에러 없이
# 조용히 뒷부분을 잘라 앞부분만 임베딩한다(실측: cl100k 2,800은 끝까지 읽고 3,200부터 잘림).
# 잘림=내용 손실이라 안전 마진을 두고 cl100k 2,000 토큰으로 제한한다.
MAX_TOKENS = 2000

QNA_SPLIT_RE = re.compile(r"(?m)^## \[")
QNA_HEAD_RE = re.compile(r"^([^\]]+)\]\s*(.*)$")
META_LINE_RE = re.compile(r"^- ([^:：]+):\s*(.*)$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
PARA_RANGE_RE = re.compile(r"\(([^()]*\d[^()]*)\)\s*$")
STD_NO_RE = re.compile(r"제\s*(\d+)\s*호")


def _valid_date(s):
    """YYYY-MM-DD 형식·달력상 유효성 검증(Postgres date 컬럼에 무효한 값이 들어가는 것 방지)."""
    if not s:
        return None
    try:
        datetime.date.fromisoformat(s)
        return s
    except (ValueError, TypeError):
        return None


def _count_tokens(text):
    if _ENCODER is None:
        return len(text.encode("utf-8")) // 2
    return len(_ENCODER.encode(text))


def _hard_chunks(text, budget):
    """문단/문장 경계로도 예산 이하로 못 줄이는 한 덩어리를 토큰(또는 문자) 창으로 강제 분할.
    이게 없으면 거대한 단일 문단이 통째로 한 청크가 되어 임베딩 단계에서 조용히 잘린다."""
    if _count_tokens(text) <= budget:
        return [text]
    if _ENCODER is not None:
        toks = _ENCODER.encode(text)
        return [_ENCODER.decode(toks[i:i + budget]) for i in range(0, len(toks), budget)]
    approx = budget * 2  # tiktoken 없을 때 문자 근사(_count_tokens가 바이트/2라 토큰≈문자)
    return [text[i:i + approx] for i in range(0, len(text), approx)]


def _split_long_text(header, body, max_tokens=MAX_TOKENS):
    """본문을 토큰 상한 이하 조각들로 분할. 헤더가 각 조각에 반복 포함되므로 그만큼 예산에서 제외.
    문단(\\n\\n) 단위로 모으되 한 문단이 예산을 넘으면 _hard_chunks로 강제 분할까지 적용한다."""
    full = f"{header}\n\n{body}"
    if _count_tokens(full) <= max_tokens:
        return [full]
    # 각 조각 = 헤더 + "(부분 i/n)" 표기 + 본문. 본문에 허용되는 예산을 보수적으로 잡는다.
    budget = max(max_tokens - _count_tokens(header) - 30, 200)
    units = []
    for p in body.split("\n\n"):
        units.extend(_hard_chunks(p, budget))
    parts, cur = [], ""
    for p in units:
        candidate = (cur + "\n\n" + p) if cur else p
        if cur and _count_tokens(candidate) > budget:
            parts.append(cur)
            cur = p
        else:
            cur = candidate
    if cur:
        parts.append(cur)
    if not parts:
        parts = [body]
    return [f"{header}\n\n(부분 {i + 1}/{len(parts)})\n{p}" for i, p in enumerate(parts)]


# ---------------------------------------------------------------------------
# QnA
# ---------------------------------------------------------------------------

def parse_qna_file(text):
    """K-IFRS 질의회신 QnA md -> 문서 dict 리스트."""
    text = text.replace("\r\n", "\n")
    raw_blocks = QNA_SPLIT_RE.split(text)
    docs = []
    for block in raw_blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        m = QNA_HEAD_RE.match(lines[0].strip())
        if not m:
            continue  # 헤더 파싱 안 되는 블록(파일 맨 앞 머리말 등)은 건너뜀
        entry_id, title = m.group(1).strip(), m.group(2).strip()
        body_lines = lines[1:]

        meta = {}
        consumed = 0
        for line in body_lines:
            stripped = line.strip()
            if stripped == "":
                consumed += 1
                continue
            mm = META_LINE_RE.match(stripped)
            if mm:
                meta[mm.group(1).strip()] = mm.group(2).strip()
                consumed += 1
            else:
                break
        body = "\n".join(body_lines[consumed:]).strip()

        docs.append({
            "doc_id": entry_id,
            "title": title,
            "date": _valid_date(meta.get("일자")),
            "related_std": meta.get("관련기준", ""),
            "body": body,
        })
    return docs


def qna_doc_to_chunks(doc):
    header = f"[K-IFRS 질의회신 QnA] {doc['title']}\n일자: {doc['date']} | 관련기준: {doc['related_std']}"
    parts = _split_long_text(header, doc["body"])
    return [
        {
            "doc_id": doc["doc_id"],
            "chunk_index": i,
            "chunk_total": len(parts),
            "content": p,
            "title": doc["title"],
            "doc_type": "qna",
            "std_no": None,
            "heading_path": None,
            "para_range": None,
            "date": doc["date"],
            "related_std": doc["related_std"],
        }
        for i, p in enumerate(parts)
    ]


# ---------------------------------------------------------------------------
# 기준서 / 해석서
# ---------------------------------------------------------------------------

def parse_standard_file(text):
    """K-IFRS 기준서/해석서 md -> 최상위 문서 리스트.
    각 문서는 {std_no, category, title, headings:[(level,title,para_range,body)]}.
    """
    text = text.replace("\r\n", "\n")
    lines = text.split("\n")

    top_docs = []  # [(title_line, body_lines)]
    cur_title, cur_body = None, []
    for line in lines:
        if line.startswith("# ") and not line.startswith("## "):
            if cur_title is not None:
                top_docs.append((cur_title, cur_body))
            cur_title = line[2:].strip()
            cur_body = []
        else:
            cur_body.append(line)
    if cur_title is not None:
        top_docs.append((cur_title, cur_body))

    results = []
    for title_line, body_lines in top_docs:
        std_m = STD_NO_RE.search(title_line)
        std_no = f"제{std_m.group(1)}호" if std_m else title_line.strip()
        category = ""
        body_start = 0
        for i, line in enumerate(body_lines[:5]):
            if line.strip().startswith("**분류**"):
                category = line.split(":", 1)[-1].strip().strip("*").strip()
                body_start = i + 1
                break
        sections = _parse_headings(body_lines[body_start:])
        results.append({
            "std_no": std_no,
            "title": title_line.strip(),
            "category": category,
            "sections": sections,
        })
    return results


def _parse_headings(lines):
    """헤딩(레벨2~6) 단위로 (level, title, para_range, breadcrumb, body) 리스트 생성."""
    # 헤딩 위치 인덱스 수집
    heads = []  # (line_idx, level, title, para_range)
    for i, line in enumerate(lines):
        m = HEADING_RE.match(line)
        if not m or len(m.group(1)) < 2:
            continue  # 레벨1(#)은 최상위 문서 제목이라 여기선 무시
        level = len(m.group(1))
        raw_title = m.group(2).strip()
        rm = PARA_RANGE_RE.search(raw_title)
        para_range = rm.group(1) if rm else None
        title = PARA_RANGE_RE.sub("", raw_title).strip()
        heads.append((i, level, title, para_range))

    sections = []
    stack = []  # [(level, title)]
    for idx, (line_idx, level, title, para_range) in enumerate(heads):
        end = heads[idx + 1][0] if idx + 1 < len(heads) else len(lines)
        body = "\n".join(lines[line_idx + 1:end]).strip()
        while stack and stack[-1][0] >= level:
            stack.pop()
        breadcrumb = " > ".join(t for _, t in stack + [(level, title)] if t != "본문")
        stack.append((level, title))
        # "본문"은 NotebookLM 변환 템플릿상 항상 평문 전체요약을 담는 최상위 래퍼이고,
        # 그 내용은 아래 문단별 헤딩에서 그대로 반복되므로 중복 임베딩을 막기 위해 제외.
        if title == "본문":
            continue
        if body:
            sections.append({
                "level": level,
                "title": title,
                "para_range": para_range,
                "breadcrumb": breadcrumb,
                "body": body,
            })
    return sections


def standard_doc_to_chunks(doc):
    # 같은 기준서(예: 제1109호 금융상품)가 본문·결론도출근거 등 여러 물리 파일로 쪼개져 있으면
    # std_no가 같아 doc_id가 충돌하고, chunk_index도 겹쳐 upsert가 서로 덮어쓴다(데이터 손실).
    # run_standards가 파일별로 부여한 고유 doc_id가 있으면 그걸 쓰고, 없으면 std_no로 폴백.
    doc_id = doc.get("doc_id") or doc["std_no"]
    # 해석서(제2NNN호)는 개별 문서의 분류(**분류**:)가 "회계기준"으로만 적혀 있어 category로는
    # 기준서와 구분되지 않는다. 제목에 "기업회계기준해석서"가 들어가므로 제목으로도 판별한다.
    is_interp = "해석" in (doc["category"] or "") or "해석" in (doc["title"] or "")
    doc_type = "interpretation" if is_interp else "standard"
    chunks = []
    for sec_idx, sec in enumerate(doc["sections"]):
        header = (
            f"[K-IFRS {doc['category'] or '회계기준'} {doc['std_no']}] {doc['title']}\n"
            f"섹션: {sec['breadcrumb']}" + (f" (문단 {sec['para_range']})" if sec["para_range"] else "")
        )
        parts = _split_long_text(header, sec["body"])
        for part_idx, p in enumerate(parts):
            chunks.append({
                "doc_id": doc_id,
                "chunk_index": sec_idx * 1000 + part_idx,  # 섹션 순서를 그대로 보존하는 안정적 인덱스
                "chunk_total": None,  # 아래에서 실제 청크 수로 채움(섹션이 길면 _split_long_text로 더 쪼개짐)
                "content": p,
                "title": doc["title"],
                "doc_type": doc_type,
                "std_no": doc["std_no"],
                "heading_path": sec["breadcrumb"],
                "para_range": sec["para_range"],
                "date": None,
                "related_std": None,
            })
    for c in chunks:  # chunk_total = 섹션 수가 아니라 실제 생성된 청크 수
        c["chunk_total"] = len(chunks)
    return chunks
