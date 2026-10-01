"""결과창 후보 묶기 — 실행(detect.py)과 평가(train.py games)가 **같은 함수**를 쓴다.

문턱을 넘는 칸을 잇되, 2칸(6초) 이하 끊김은 잇고, 칸 시각이 9초 넘게 벌어지면(분할 파일 경계) 끊는다.
min_len 칸 미만 덩어리는 버린다. 반환: [(첫 칸, 끝 칸)] — 칸 번호.
예전엔 평가 쪽이 파일 경계 끊기를 안 해 둘의 후보가 달랐다(Codex 검토, 2026-10-01).
"""
import numpy as np

def group_runs(at, s, threshold, min_len):
    hi = np.where(np.asarray(s) >= threshold)[0]
    if not len(hi): return []
    at = np.asarray(at)
    groups = np.split(hi, np.where((np.diff(hi) > 2) | (np.diff(at[hi]) > 9))[0] + 1)
    return [(int(g[0]), int(g[-1])) for g in groups if len(g) >= min_len]
