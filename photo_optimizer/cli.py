"""명령줄 일괄 변환.

  python -m photo_optimizer.cli 사진폴더 -o 결과폴더
  python -m photo_optimizer.cli a.jpg b.jpg --min 5 --max 10
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .core import Options, convert

EXTS = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp", ".tif", ".tiff"}


def main() -> None:
    p = argparse.ArgumentParser(description="고해상도 사진을 목표 용량으로 축소")
    p.add_argument("inputs", nargs="+", type=Path, help="파일 또는 폴더")
    p.add_argument("-o", "--out", type=Path, help="출력 폴더 (기본: 원본 옆)")
    p.add_argument("--min", type=float, default=5.0, dest="min_mb", help="목표 하한 MB")
    p.add_argument("--max", type=float, default=10.0, dest="max_mb", help="목표 상한 MB")
    p.add_argument("--sharpen", action="store_true", help="축소 후 약한 샤프닝")
    p.add_argument("--keep-gps", action="store_true", help="위치 정보 유지")
    a = p.parse_args()

    files = []
    for path in a.inputs:
        files += sorted(f for f in path.iterdir() if f.suffix.lower() in EXTS) if path.is_dir() else [path]

    opts = Options(min_mb=a.min_mb, max_mb=a.max_mb, sharpen=a.sharpen, keep_gps=a.keep_gps)
    for f in files:
        out_dir = a.out or f.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        dst = out_dir / f"{f.stem}_optimized.jpg"
        try:
            buf, r = convert(f.read_bytes(), opts)
        except Exception as e:
            print(f"[실패] {f.name}: {str(e).splitlines()[0]}")
            continue
        dst.write_bytes(buf)
        d = r.to_dict()
        print(f"[완료] {f.name}: {d['src_megapixels']}MP {d['src_size_mb']}MB → "
              f"{d['megapixels']}MP {d['size_mb']}MB (Q{r.quality}, {r.seconds}s) {r.note}")


if __name__ == "__main__":
    main()
