#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""회사 프록시 환경에서 Gemini 임베딩 API가 되는지 1건 테스트."""
import os, sys, time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# law-chatbot/.env.local 에서 GEMINI_API_KEY 읽기
env_path = Path(r"C:\Users\Administrator\law-chatbot\.env.local")
for line in env_path.read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

print("GEMINI_API_KEY 존재:", bool(os.environ.get("GEMINI_API_KEY")))

from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
t = time.time()
try:
    resp = client.models.embed_content(
        model="gemini-embedding-001",
        contents=["부가가치세 매입세액 공제 테스트 문장입니다."],
        config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT", output_dimensionality=768),
    )
    vec = resp.embeddings[0].values
    print(f"★ 임베딩 성공: {len(vec)}차원, {time.time()-t:.1f}초")
    print(f"  앞 5개 값: {vec[:5]}")
except Exception as e:
    print(f"✗ 임베딩 실패 ({time.time()-t:.1f}초): {type(e).__name__}: {e}")
