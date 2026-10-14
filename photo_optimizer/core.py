"""고해상도 사진 축소 변환 코어.

용도 프리셋으로 동작한다 (브라우저판 docs/app.js의 PRESETS와 같은 값).
  원본 해상도   해상도 그대로 다시 저장해 용량만 줄인다
  고화질 보관   목표 용량(7MB, ±3MB 허용) 안에서 가능한 한 높은 해상도와 품질 (기본)
  카톡·메신저   긴 변 4000px, 4MB 이하
  메일 첨부     긴 변 3000px, 2MB 이하
  직접 설정     목표 용량 하나(±3MB)
목표 용량 방식은 이렇게 찾는다.
  1. 해상도는 원본의 1/2(2억 → 5천만 화소)부터 시도한다.
  2. 각 해상도에서 JPEG 품질(Q)을 이진 탐색해 상한 용량 이하의 최고 Q를 찾는다.
  3. 최저 Q(min_q)로도 상한을 넘으면 해상도를 한 단계 낮춘다.
이미 상한 안의 JPEG는 다시 압축하지 않는다(해상도만 잃거나 오히려 커진다). 위치 정보만 지운다.
결과가 원본 JPEG보다 크면 원본을 그대로 쓴다.
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


# mode: size = 목표 용량(±3MB), edge = 긴 변 상한 + 용량 상한, original = 해상도 그대로 다시 저장
PRESETS = {
    "original":  {"label": "원본 해상도", "mode": "original"},
    "archive":   {"label": "고화질 보관", "mode": "size", "target_mb": 7.0},
    "messenger": {"label": "카톡·메신저", "mode": "edge", "long_edge": 4000, "max_mb": 4.0},
    "mail":      {"label": "메일 첨부", "mode": "edge", "long_edge": 3000, "max_mb": 2.0},
}
DEFAULT_PRESET = "archive"
REENCODE_Q = 88  # 원본 해상도 프리셋의 JPEG 품질


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
    preset: str = DEFAULT_PRESET  # 결과 표시용 (직접 설정이면 "custom")
    mode: str = "size"            # size | edge | original
    long_edge: int = 0            # edge 모드의 긴 변 상한(px)


def preset_options(preset: str = DEFAULT_PRESET, target_mb: float | None = None,
                   sharpen: bool = False, keep_gps: bool = False) -> Options:
    """프리셋 이름(또는 "custom" + 목표 용량)을 변환 옵션으로 바꾼다."""
    common = dict(preset=preset, sharpen=sharpen, keep_gps=keep_gps)
    if preset == "custom":
        lo, hi = target_range(DEFAULT_TARGET_MB if target_mb is None else target_mb)
        return Options(min_mb=lo, max_mb=hi, mode="size", **common)
    if preset not in PRESETS:
        raise ValueError(f"알 수 없는 프리셋: {preset}")
    p = PRESETS[preset]
    if p["mode"] == "original":
        return Options(min_mb=0, max_mb=float("inf"), mode="original", **common)
    if p["mode"] == "edge":
        return Options(min_mb=0, max_mb=p["max_mb"], mode="edge", long_edge=p["long_edge"], **common)
    lo, hi = target_range(p["target_mb"])
    return Options(min_mb=lo, max_mb=hi, mode="size", **common)


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
    preset: str = DEFAULT_PRESET

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


def _oriented_size(img: pyvips.Image) -> tuple[int, int]:
    """EXIF 회전을 반영한 가로·세로."""
    if "orientation" in img.get_fields() and img.get("orientation") in (5, 6, 7, 8):
        return img.height, img.width
    return img.width, img.height


def _keep_original(data: bytes, opts: Options, t0: float) -> tuple[bytes, Result]:
    """원본을 다시 압축하지 않고 돌려준다 (필요하면 GPS만 무손실로 지움)."""
    w, h = _oriented_size(pyvips.Image.new_from_buffer(data, ""))  # 머리만 읽는다
    buf, removed = (data, False) if opts.keep_gps else scrub_gps(data)
    note = "이미 충분히 작아 원본을 그대로 두었습니다" + (" (위치 정보만 지움)" if removed else "")
    return buf, Result(width=w, height=h, src_width=w, src_height=h, quality=0, size=len(buf),
                       src_size=len(data), seconds=round(time.perf_counter() - t0, 2), note=note,
                       kept=True, preset=opts.preset)


def _reencode(data: bytes, opts: Options) -> tuple[bytes, int, int]:
    """원본 해상도 그대로 다시 저장한다. 디코딩→인코딩을 흘려보내 픽셀을 메모리에 모으지 않는다.

    회전은 픽셀을 돌리지 않고 EXIF 방향값으로 남긴다(90도 회전은 이미지 전체를 메모리에 올린다).
    optimize_coding/trellis는 이미지 전체의 계수를 메모리에 잡으므로(2억 화소면 1GB 이상) 끈다.
    크로마는 휴대폰 원본과 같은 4:2:0이라 원본보다 나빠지지 않는다.
    """
    img = pyvips.Image.new_from_buffer(data, "", access="sequential")
    w, h = _oriented_size(img)
    if img.hasalpha():
        img = img.flatten(background=[255, 255, 255])
    if img.interpretation not in ("srgb", "b-w"):
        img = img.colourspace("srgb")
    if not opts.keep_gps:
        img = _strip_gps(img)
    if opts.sharpen:
        img = img.sharpen(sigma=0.5, x1=2, m1=0, m2=2)
    buf = img.jpegsave_buffer(Q=REENCODE_Q, subsample_mode="on", optimize_coding=False,
                              trellis_quant=False, overshoot_deringing=True, quant_table=3,
                              keep="exif,icc,xmp,iptc")
    return buf, w, h


def convert(data: bytes, opts: Options | None = None) -> tuple[bytes, Result]:
    opts = opts or Options()
    t0 = time.perf_counter()
    is_jpeg = data[:2] == b"\xff\xd8"

    # 원본 해상도: 해상도 그대로 다시 저장. 원본 JPEG보다 커지면 원본을 그대로 쓴다
    if opts.mode == "original":
        buf, w, h = _reencode(data, opts)
        if not opts.keep_gps:
            buf, _ = scrub_gps(buf)
        if is_jpeg and len(buf) >= len(data):
            return _keep_original(data, opts, t0)
        return buf, Result(width=w, height=h, src_width=w, src_height=h, quality=REENCODE_Q, size=len(buf),
                           src_size=len(data), seconds=round(time.perf_counter() - t0, 2),
                           note="해상도는 그대로 두고 용량만 줄였습니다", preset=opts.preset)

    # 이미 용량 상한 안의 JPEG는 다시 압축하지 않는다. 긴 변 프리셋도 마찬가지다: 상한 안이면
    # 원본이 같은 용량에 해상도가 더 높다
    small = len(data) <= opts.max_mb * MB
    if small and is_jpeg:
        return _keep_original(data, opts, t0)

    src = _load(data)
    src_w, src_h = src.width, src.height

    if opts.mode == "edge":
        # 긴 변을 long_edge 이하로. 상한을 못 맞추면 85%, 70%로 한 단계씩 더 줄인다
        s = min(1.0, opts.long_edge / max(src_w, src_h))
        scales = [s, s * 0.85, s * 0.7]
    else:
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
        if opts.mode == "size" and len(buf) < opts.min_mb * MB:
            note = "최고 품질로도 목표보다 3MB 넘게 작습니다 (원본 정보량이 적은 사진)"
    else:
        # 최소 배율에서도 상한 초과: 최소 배율 + 최저 Q로 저장
        q, buf = opts.min_q, _encode(img, opts.min_q)
        note = "목표 상한을 넘었습니다 (최소 해상도·최저 품질 적용)"
    if not opts.keep_gps:
        buf, _ = scrub_gps(buf)  # 엔진은 EXIF GPS만 지우므로 XMP의 GPS도 지운다
    if is_jpeg and len(buf) >= len(data):  # 그래도 원본보다 크면 원본을 그대로 쓴다
        return _keep_original(data, opts, t0)

    result = Result(
        width=img.width, height=img.height,
        src_width=src_w, src_height=src_h,
        quality=q, size=len(buf), src_size=len(data),
        seconds=round(time.perf_counter() - t0, 2),
        note=note, tries=tries, preset=opts.preset,
    )
    return buf, result
