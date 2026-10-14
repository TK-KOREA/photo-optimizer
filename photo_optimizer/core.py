"""고해상도 사진 축소 변환 코어.

목표 용량(기본 7MB, ±3MB 허용) 안에서 가능한 한 높은 해상도와 품질을 남긴다.
  1. 해상도는 원본의 1/2(2억 → 5천만 화소)부터 시도한다.
  2. 각 해상도에서 JPEG 품질(Q)을 이진 탐색해 상한 용량 이하의 최고 Q를 찾는다.
  3. 최저 Q(min_q)로도 상한을 넘으면 해상도를 한 단계 낮춘다.
이미 상한 안의 JPEG는 다시 압축하지 않는다(해상도만 잃거나 오히려 커진다). 위치 정보만 지운다.
"""
from __future__ import annotations

import re
import struct
import time
from dataclasses import dataclass, asdict, field

import pyvips

MB = 1024 * 1024
DEFAULT_TARGET_MB = 7.0
TOLERANCE_MB = 3.0  # 목표 용량 ± 이 값까지 허용

# 시도할 축소 배율 (가로/세로 기준). 0.5 = 면적 1/4 = 2억 → 5천만 화소
SCALE_STEPS = (0.5, 0.45, 0.4, 0.35, 0.3, 0.25)


def target_range(target_mb: float) -> tuple[float, float]:
    """목표 용량 하나를 허용 범위(하한, 상한)로 바꾼다."""
    return max(0.5, target_mb - TOLERANCE_MB), target_mb + TOLERANCE_MB


@dataclass
class Options:
    min_mb: float = DEFAULT_TARGET_MB - TOLERANCE_MB
    max_mb: float = DEFAULT_TARGET_MB + TOLERANCE_MB
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
    kept: bool = False       # 원본을 다시 압축하지 않고 그대로 돌려줌 (quality는 0)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["megapixels"] = round(self.width * self.height / 1e6, 1)
        d["src_megapixels"] = round(self.src_width * self.src_height / 1e6, 1)
        d["size_mb"] = round(self.size / MB, 2)
        d["src_size_mb"] = round(self.src_size / MB, 2)
        d["saved_pct"] = round(100 * (1 - self.size / self.src_size), 1) if self.src_size else 0
        return d


# ---------- JPEG GPS 무손실 제거 (docs/jpeg-meta.js와 같은 방식) ----------
_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
_XMP_ID = b"http://ns.adobe.com/xap/1.0/\0"
_XMP_GPS = re.compile(rb'\sexif:GPS\w*="[^"]*"|<exif:GPS(\w*)\b[^>]*?/>|<exif:GPS(\w*)\b[^>]*>.*?</exif:GPS\2>', re.S)


def _segments(b: bytes):
    """SOS 전까지의 (마커, 내용 시작, 끝)."""
    p = 2
    while p + 4 <= len(b):
        if b[p] != 0xFF:
            return
        if b[p + 1] == 0xFF:  # 채움 바이트
            p += 1
            continue
        m = b[p + 1]
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            p += 2
            continue
        if m in (0xDA, 0xD9):
            return
        end = p + 2 + (b[p + 2] << 8 | b[p + 3])
        if end > len(b):
            return
        yield m, p + 4, end
        p = end


def scrub_gps(data: bytes) -> tuple[bytes, bool]:
    """JPEG의 EXIF GPS IFD를 0으로 채우고 XMP의 exif:GPS*를 공백으로 바꾼다. 길이·픽셀은 그대로."""
    if data[:2] != b"\xff\xd8":
        return data, False
    b = bytearray(data)
    removed = False
    for m, start, end in list(_segments(b)):
        if m != 0xE1:
            continue
        if b[start:start + 6] == b"Exif\0\0":
            tiff = start + 6
            e = "<" if b[tiff:tiff + 2] == b"II" else ">"
            r16 = lambda o: struct.unpack_from(e + "H", b, o)[0]
            r32 = lambda o: struct.unpack_from(e + "I", b, o)[0]
            ifd0 = tiff + r32(tiff + 4)
            if ifd0 + 2 > end:
                continue
            for i in range(r16(ifd0)):
                ent = ifd0 + 2 + i * 12
                if ent + 12 > end or r16(ent) != 0x8825:
                    continue
                gps = tiff + r32(ent + 8)
                if gps + 2 > end:
                    break
                n = r16(gps)
                for j in range(n):
                    g = gps + 2 + j * 12
                    if g + 12 > end:
                        break
                    size = _TYPE_SIZE.get(r16(g + 2), 1) * r32(g + 4)
                    off = tiff + r32(g + 8)
                    if size > 4 and off + size <= end:
                        b[off:off + size] = bytes(size)
                stop = min(end, gps + 2 + n * 12 + 4)  # 항목 수, 항목, 다음 IFD 위치
                b[gps:stop] = bytes(stop - gps)
                removed = removed or n > 0
                break
        elif b[start:start + len(_XMP_ID)] == _XMP_ID:
            frm = start + len(_XMP_ID)
            for mt in _XMP_GPS.finditer(bytes(b[frm:end])):
                b[frm + mt.start():frm + mt.end()] = b" " * (mt.end() - mt.start())
                removed = True
    return (bytes(b), True) if removed else (data, False)


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
    small = len(data) <= opts.max_mb * MB

    # 이미 상한 안의 JPEG: 다시 압축하지 않고 원본을 돌려준다 (필요하면 GPS만 지움)
    if small and data[:2] == b"\xff\xd8":
        head = pyvips.Image.new_from_buffer(data, "")  # 머리만 읽는다
        w, h = head.width, head.height
        if "orientation" in head.get_fields() and head.get("orientation") in (5, 6, 7, 8):
            w, h = h, w
        buf, removed = (data, False) if opts.keep_gps else scrub_gps(data)
        note = "이미 목표 크기 안이라 원본을 그대로 두었습니다" + (" (위치 정보만 지움)" if removed else "")
        return buf, Result(width=w, height=h, src_width=w, src_height=h, quality=0, size=len(buf),
                           src_size=len(data), seconds=round(time.perf_counter() - t0, 2), note=note, kept=True)

    src = _load(data)
    src_w, src_h = src.width, src.height

    # JPEG가 아니어도 이미 상한 안이면 해상도를 줄이지 않고 원래 크기부터 시작한다
    max_scale = 1.0 if small else opts.max_scale
    scales = [s for s in (1.0,) + SCALE_STEPS if s <= max_scale]
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
            note = "최고 품질로도 목표보다 3MB 넘게 작습니다 (원본 정보량이 적은 사진)"
    else:
        # 최소 배율에서도 상한 초과: 최소 배율 + 최저 Q로 저장
        q, buf = opts.min_q, _encode(img, opts.min_q)
        note = "목표 상한을 넘었습니다 (최소 해상도·최저 품질 적용)"
    if not opts.keep_gps:
        buf, _ = scrub_gps(buf)  # 엔진은 EXIF GPS만 지우므로 XMP의 GPS도 지운다

    result = Result(
        width=img.width, height=img.height,
        src_width=src_w, src_height=src_h,
        quality=q, size=len(buf), src_size=len(data),
        seconds=round(time.perf_counter() - t0, 2),
        note=note, tries=tries,
    )
    return buf, result
