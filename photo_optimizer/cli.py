"""명령줄 일괄 변환.

  python -m photo_optimizer.cli 사진폴더 -o 결과폴더
  python -m photo_optimizer.cli a.jpg b.jpg --target 7
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .core import DEFAULT_TARGET_MB, TOLERANCE_MB, Options, convert, target_range

EXTS = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp", ".tif", ".tiff"}


def main() -> None:
    p = argparse.ArgumentParser(description="고해상도 사진을 목표 용량으로 축소")
    p.add_argument("inputs", nargs="+", type=Path, help="파일 또는 폴더")
    p.add_argument("-o", "--out", type=Path, help="출력 폴더 (기본: 원본 옆)")
    p.add_argument("--target", type=float, default=DEFAULT_TARGET_MB, dest="target_mb",
                   help=f"목표 용량 MB (±{TOLERANCE_MB:g}MB 허용, 기본 {DEFAULT_TARGET_MB:g})")
    p.add_argument("--sharpen", action="store_true", help="축소 후 약한 샤프닝")
    p.add_argument("--keep-gps", action="store_true", help="위치 정보 유지")
    a = p.parse_args()

    files = []
    for path in a.inputs:
        files += sorted(f for f in path.iterdir() if f.suffix.lower() in EXTS) if path.is_dir() else [path]

    min_mb, max_mb = target_range(a.target_mb)
    opts = Options(min_mb=min_mb, max_mb=max_mb, sharpen=a.sharpen, keep_gps=a.keep_gps)
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
              f"{d['megapixels']}MP {d['size_mb']}MB ({'원본 유지' if r.kept else f'Q{r.quality}'}, {r.seconds}s) {r.note}")


if __name__ == "__main__":
    main()
