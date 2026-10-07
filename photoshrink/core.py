"""고해상도 사진 축소 변환 코어.

목표 용량 범위(기본 5~10MB) 안에서 가능한 한 높은 해상도와 품질을 남긴다.
  1. 해상도는 원본의 1/2(2억 → 5천만 화소)부터 시도한다.
  2. 각 해상도에서 JPEG 품질(Q)을 이진 탐색해 상한 용량 이하의 최고 Q를 찾는다.
  3. 최저 Q(min_q)로도 상한을 넘으면 해상도를 한 단계 낮춘다.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, asdict, field

import pyvips

MB = 1024 * 1024

# 시도할 축소 배율 (가로/세로 기준). 0.5 = 면적 1/4 = 2억 → 5천만 화소
SCALE_STEPS = (0.5, 0.45, 0.4, 0.35, 0.3, 0.25)


@dataclass
class Options:
    min_mb: float = 5.0
    max_mb: float = 10.0
    min_q: int = 85          # 이 아래로는 품질을 낮추지 않고 해상도를 줄인다
    max_q: int = 95
    max_scale: float = 0.5   # 원본 대비 최대 배율 (1.0이면 축소 안 함부터 시도)
    sharpen: bool = False    # 축소 후 약한 출력 샤프닝
    keep_gps: bool = False   # False면 위치 정보 제거


@dataclass
class Result:
    width: int
    height: int
    src_width: int
    src_height: int
    quality: int
    size: int
    src_size: int
    seconds: float
    note: str = ""
    tries: list = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["megapixels"] = round(self.width * self.height / 1e6, 1)
        d["src_megapixels"] = round(self.src_width * self.src_height / 1e6, 1)
        d["size_mb"] = round(self.size / MB, 2)
        d["src_size_mb"] = round(self.src_size / MB, 2)
        d["saved_pct"] = round(100 * (1 - self.size / self.src_size), 1) if self.src_size else 0
        return d


def _load(data: bytes) -> pyvips.Image:
    img = pyvips.Image.new_from_buffer(data, "", access="sequential")
    return img.autorot()  # EXIF 회전 정보를 실제 픽셀에 반영


def _resize(img: pyvips.Image, scale: float, sharpen: bool) -> pyvips.Image:
    """선형 광(linear light) 공간에서 Lanczos3로 축소한다.

    sRGB와 Display P3는 같은 전달 곡선(감마)을 쓰므로 scRGB 변환으로 둘 다
    올바르게 선형화된다. 축소는 선형 연산이라 원색(primaries) 차이는 무관하고,
    원본 ICC 프로필은 메타데이터로 그대로 따라가 색이 유지된다.
    """
    has_alpha = img.hasalpha()
    if has_alpha:
        img = img.flatten(background=[255, 255, 255])
    if img.interpretation not in ("srgb", "b-w"):
        img = img.colourspace("srgb")

    if scale < 1.0:
        out = img.colourspace("scrgb").resize(scale, kernel="lanczos3").colourspace("srgb")
    else:
        out = img
    if sharpen:
        out = out.sharpen(sigma=0.5, x1=2, m1=0, m2=2)
    out = out.cast("uchar")
    # 이후 Q 탐색에서 여러 번 인코딩하므로 축소 결과를 메모리에 고정한다
    # (5천만 화소 기준 약 150MB)
    return out.copy_memory()


def _strip_gps(img: pyvips.Image) -> pyvips.Image:
    img = img.copy()
    for name in img.get_fields():
        if name.startswith("exif-ifd3-"):  # IFD3 = GPS
            img.remove(name)
    return img


def _encode(img: pyvips.Image, q: int) -> bytes:
    return img.jpegsave_buffer(
        Q=q,
        subsample_mode="off",      # 4:4:4 크로마: 빨간색·글자 경계 보존
        optimize_coding=True,
        trellis_quant=True,        # mozjpeg 계열 최적화 (지원 시)
        overshoot_deringing=True,
        quant_table=3,             # ImageMagick 계열 표, 고품질 구간에서 효율적
        keep="exif,icc,xmp,iptc",
    )


def _search_q(img: pyvips.Image, opts: Options, tries: list, scale: float):
    """max_mb 이하이면서 가장 높은 Q를 이진 탐색한다. 없으면 None."""
    limit = opts.max_mb * MB
    lo, hi = opts.min_q, opts.max_q
    best = None
    while lo <= hi:
        q = (lo + hi) // 2
        buf = _encode(img, q)
        tries.append({"scale": scale, "q": q, "mb": round(len(buf) / MB, 2)})
        if len(buf) <= limit:
            best = (q, buf)
            lo = q + 1
        else:
            hi = q - 1
    return best


def convert(data: bytes, opts: Options | None = None) -> tuple[bytes, Result]:
    opts = opts or Options()
    t0 = time.perf_counter()
    src = _load(data)
    src_w, src_h = src.width, src.height

    scales = [s for s in (1.0,) + SCALE_STEPS if s <= opts.max_scale]
    # 출력이 너무 작아지는(장변 2000px 미만) 배율은 제외
    scales = [s for s in scales if max(src_w, src_h) * s >= 2000] or [scales[0]]

    tries: list = []
    found = None
    for i, scale in enumerate(scales):
        # sequential 접근 이미지는 한 번만 읽을 수 있어 배율마다 다시 연다
        img = _resize(src if i == 0 else _load(data), scale, opts.sharpen)
        if not opts.keep_gps:
            img = _strip_gps(img)
        found = _search_q(img, opts, tries, scale)
        if found:
            break

    note = ""
    if found:
        q, buf = found
        if len(buf) < opts.min_mb * MB:
            note = "최고 품질로도 목표 하한보다 작습니다 (원본 정보량이 적은 사진)"
    else:
        # 최소 배율에서도 상한 초과: 최소 배율 + 최저 Q로 저장
        q, buf = opts.min_q, _encode(img, opts.min_q)
        note = "목표 상한을 넘었습니다 (최소 해상도·최저 품질 적용)"

    result = Result(
        width=img.width, height=img.height,
        src_width=src_w, src_height=src_h,
        quality=q, size=len(buf), src_size=len(data),
        seconds=round(time.perf_counter() - t0, 2),
        note=note, tries=tries,
    )
    return buf, result
