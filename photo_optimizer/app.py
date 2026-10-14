"""웹 서비스 (PC 프로그램도 같은 서버를 내부에서 띄워 사용한다)."""
from __future__ import annotations

import asyncio
import io
import os
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .core import DEFAULT_TARGET_MB, Options, convert, target_range

MAX_UPLOAD_MB = int(os.environ.get("PHOTO_OPTIMIZER_MAX_UPLOAD_MB", "120"))
# 2억 화소 1장 처리에 약 0.9GB를 쓰므로 동시 처리 수를 제한한다
MAX_JOBS = int(os.environ.get("PHOTO_OPTIMIZER_MAX_JOBS", "2"))
KEEP_SECONDS = 60 * 60  # 결과 파일 보관 시간

OUT_DIR = Path(tempfile.gettempdir()) / "photo-optimizer"
OUT_DIR.mkdir(exist_ok=True)
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Photo Optimizer")
_jobs = asyncio.Semaphore(MAX_JOBS)
_names: dict[str, str] = {}  # 결과 id → 다운로드 파일명


def _cleanup() -> None:
    cutoff = time.time() - KEEP_SECONDS
    for f in OUT_DIR.glob("*.jpg"):
        if f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)
            _names.pop(f.stem, None)


def _out_name(src: str) -> str:
    stem = Path(src or "photo").stem
    return f"{stem}_optimized.jpg"


@app.post("/api/convert")
async def api_convert(
    file: UploadFile = File(...),
    target_mb: float = Form(DEFAULT_TARGET_MB),
    sharpen: bool = Form(False),
    keep_gps: bool = Form(False),
):
    if not (1 <= target_mb <= 47):
        raise HTTPException(400, "목표 용량은 1~47MB 사이로 정해 주세요.")
    min_mb, max_mb = target_range(target_mb)
    data = await file.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"{MAX_UPLOAD_MB}MB 이하 파일만 올릴 수 있습니다.")

    opts = Options(min_mb=min_mb, max_mb=max_mb, sharpen=sharpen, keep_gps=keep_gps)
    async with _jobs:
        try:
            buf, result = await run_in_threadpool(convert, data, opts)
        except Exception:  # pyvips.Error 등: 손상 파일, 미지원 포맷
            raise HTTPException(422, "지원하지 않는 형식이거나 손상된 파일입니다.")

    _cleanup()
    job_id = uuid.uuid4().hex
    (OUT_DIR / f"{job_id}.jpg").write_bytes(buf)
    _names[job_id] = _out_name(file.filename)
    d = result.to_dict()
    d.update(id=job_id, filename=_names[job_id])
    return d


def _path(job_id: str) -> Path:
    if not job_id.isalnum():
        raise HTTPException(400)
    p = OUT_DIR / f"{job_id}.jpg"
    if not p.exists():
        raise HTTPException(404, "결과 파일이 만료되었습니다. 다시 변환해 주세요.")
    return p


@app.get("/api/download/{job_id}")
def api_download(job_id: str):
    return FileResponse(_path(job_id), media_type="image/jpeg",
                        filename=_names.get(job_id, f"{job_id}.jpg"))


@app.get("/api/zip")
def api_zip(ids: str):
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, "w", zipfile.ZIP_STORED) as z:  # JPEG는 재압축 효과 없음
        used: set[str] = set()
        for job_id in ids.split(","):
            name = _names.get(job_id, f"{job_id}.jpg")
            while name in used:
                name = "_" + name
            used.add(name)
            z.write(_path(job_id), name)
    mem.seek(0)
    return StreamingResponse(mem, media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="photo-optimizer.zip"'})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
