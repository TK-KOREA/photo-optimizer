"""고해상도 사진 축소 변환 코어.

용도 프리셋으로 동작한다 (브라우저판 docs/app.js의 PRESETS와 같은 값).
  리마스터     1,600만 화소로 줄이며 밝기·대비·색을 자동 보정 (그늘진 얼굴 밝히기)
  원본 해상도   해상도 그대로 다시 저장해 용량만 줄인다
  고화질 보관   목표 용량(7MB, ±3MB 허용) 안에서 가능한 한 높은 해상도와 품질 (기본)
  카톡·메신저   긴 변 4000px, 4MB 이하
  메일 첨부     긴 변 3000px, 2MB 이하
  직접 설정     목표 용량 하나(±3MB)
목표 용량 방식은 이렇게 찾는다.
  1. 해상도는 원본의 1/2(2억 → 5천만 화소)부터 시도한다.
  2. 각 해상도에서 JPEG 품질(Q)을 이진 탐색해 상한 용량 이하의 최고 Q를 찾는다.
  3. 최저 Q(min_q)로도 상한을 넘으면 해상도를 한 단계 낮춘다.
이미 상한 안의 JPEG는 다시 압축하지 않는다(해상도만 잃거나 오히려 커진다). 위치 정보 지우기를 켰으면 그것만 지운다.
결과가 원본 JPEG보다 크면 원본을 그대로 쓴다.
"""
from __future__ import annotations

import math
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


# mode: size = 목표 용량(±3MB), edge = 긴 변 상한(또는 화소 수 area_mp) + 용량 상한, original = 해상도 그대로 다시 저장
# tone: 밝기·대비·채도 자동 보정 (_auto_tone), chroma420: 4:2:0 크로마로 저장 (갤럭시 리마스터 결과와 같은 방식)
PRESETS = {
    "remaster":  {"label": "리마스터", "mode": "edge", "area_mp": 16, "max_mb": 8.0, "tone": True, "chroma420": True},
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
    keep_gps: bool = True    # False면 위치 정보 제거
    preset: str = DEFAULT_PRESET  # 결과 표시용 (직접 설정이면 "custom")
    mode: str = "size"            # size | edge | original
    long_edge: int = 0            # edge 모드의 긴 변 상한(px)
    area_mp: float = 0            # edge 모드의 화소 수 상한(백만 화소). 주면 long_edge 대신 쓴다
    tone: bool = False            # 밝기·대비·채도 자동 보정 (리마스터)
    chroma420: bool = False       # 4:2:0 크로마 (기본은 4:4:4)


def preset_options(preset: str = DEFAULT_PRESET, target_mb: float | None = None,
                   sharpen: bool = False, keep_gps: bool = True) -> Options:
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
        return Options(min_mb=0, max_mb=p["max_mb"], mode="edge", long_edge=p.get("long_edge", 0),
                       area_mp=p.get("area_mp", 0), tone=p.get("tone", False), chroma420=p.get("chroma420", False),
                       **common)
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


# ---------- 위치 정보 옮겨 심기 (docs/jpeg-meta.js의 readGps/putGps와 같은 방식) ----------
# 변환 엔진이 메타데이터를 다시 쓰는 과정에서 GPS를 잃을 때가 있다. 그래서 변환 전에 원본의
# GPS IFD를 읽어 메모리에 담아 두고, 변환이 끝난 JPEG에 다시 넣는다.
# 값은 엔디언과 무관하게 빅엔디언 바이트로 담아, 결과 파일의 엔디언에 맞춰 다시 쓴다.

def _unit(t: int) -> int:
    return 4 if t in (5, 10) else _TYPE_SIZE.get(t, 1)


def _swap(raw: bytes, unit: int) -> bytes:
    if unit == 1:
        return raw
    return b"".join(raw[k:k + unit][::-1] for k in range(0, len(raw), unit))


def _exif_segment(b: bytes):
    for m, start, end in _segments(b):
        if m == 0xE1 and b[start:start + 6] == b"Exif\0\0":
            return start, end
    return None


def read_gps(data: bytes) -> list | None:
    """원본의 GPS 항목들 [(tag, type, count, 빅엔디언 값 바이트)]. 없으면 None."""
    if data[:2] != b"\xff\xd8":
        return None
    seg = _exif_segment(data)
    if not seg:
        return None
    start, end = seg
    tiff = start + 6
    e = "<" if data[tiff:tiff + 2] == b"II" else ">"
    r16 = lambda o: struct.unpack_from(e + "H", data, o)[0]
    r32 = lambda o: struct.unpack_from(e + "I", data, o)[0]
    try:
        ifd0 = tiff + r32(tiff + 4)
        ptr = next((ifd0 + 2 + i * 12 for i in range(r16(ifd0)) if r16(ifd0 + 2 + i * 12) == 0x8825), None)
        if ptr is None:
            return None
        gps = tiff + r32(ptr + 8)
        out = []
        for j in range(r16(gps)):
            g = gps + 2 + j * 12
            if g + 12 > end:
                break
            t, count = r16(g + 2), r32(g + 4)
            if t not in _TYPE_SIZE:
                continue
            size = _TYPE_SIZE[t] * count
            frm = g + 8 if size <= 4 else tiff + r32(g + 8)
            if frm + size > end:
                continue
            raw = data[frm:frm + size]
            out.append((r16(g), t, count, _swap(raw, _unit(t)) if e == "<" else raw))
        return out or None
    except struct.error:
        return None


def _gps_ifd(gps: list, offset: int, e: str) -> bytes:
    items = sorted(gps)
    data_at = offset + 2 + len(items) * 12 + 4
    head, extra = [struct.pack(e + "H", len(items))], []
    for tag, t, count, raw in items:
        raw = _swap(raw, _unit(t)) if e == "<" else raw
        head.append(struct.pack(e + "HHI", tag, t, count))
        if len(raw) <= 4:
            head.append(raw.ljust(4, b"\0"))
        else:
            head.append(struct.pack(e + "I", data_at))
            pad = b"\0" * (len(raw) & 1)  # 오프셋은 짝수로 맞춘다
            extra.append(raw + pad)
            data_at += len(raw) + len(pad)
    head.append(struct.pack(e + "I", 0))
    return b"".join(head + extra)


def put_gps(data: bytes, gps: list | None) -> bytes:
    """변환 결과에 GPS를 넣는다. 이미 있으면 원본 값으로 바꾼다.

    기존 EXIF 내용은 그대로 두고 끝에 새 IFD0(GPS 항목 포함)과 GPS IFD를 덧붙인 뒤
    머리의 IFD0 위치만 바꾼다. 그래서 다른 항목의 오프셋은 하나도 움직이지 않는다.
    """
    if not gps or data[:2] != b"\xff\xd8":
        return data
    seg = _exif_segment(data)
    if seg:
        start, end = seg
        tiff = start + 6
        e = "<" if data[tiff:tiff + 2] == b"II" else ">"
        try:
            ifd0 = tiff + struct.unpack_from(e + "I", data, tiff + 4)[0]
            n = struct.unpack_from(e + "H", data, ifd0)[0]
        except struct.error:
            return data
        if ifd0 + 2 + n * 12 + 4 > end:
            return data
        entries = [data[ifd0 + 2 + i * 12:ifd0 + 14 + i * 12] for i in range(n)]
        entries = [x for x in entries if struct.unpack_from(e + "H", x)[0] != 0x8825]
        base = end - tiff
        pad = base & 1
        base += pad
        gps_at = base + 2 + (len(entries) + 1) * 12 + 4
        entries.append(struct.pack(e + "HHII", 0x8825, 4, 1, gps_at))
        entries.sort(key=lambda x: struct.unpack_from(e + "H", x)[0])
        nxt = data[ifd0 + 2 + n * 12:ifd0 + 6 + n * 12]  # 다음 IFD(썸네일) 위치
        old = bytearray(data[start:end])
        struct.pack_into(e + "I", old, 10, base)  # 머리의 IFD0 위치
        body = bytes(old) + b"\0" * pad + struct.pack(e + "H", len(entries)) + b"".join(entries) + nxt \
            + _gps_ifd(gps, gps_at, e)
        head, tail = data[:start - 4], data[end:]
    else:
        # EXIF가 아예 없으면 GPS만 담은 EXIF를 새로 만든다 (JFIF APP0 뒤, 없으면 SOI 뒤)
        body = b"Exif\0\0MM\0*" + struct.pack(">IHHHIII", 8, 1, 0x8825, 4, 1, 26, 0) + _gps_ifd(gps, 26, ">")
        first = next(_segments(data), None)
        at = first[2] if first and first[0] == 0xE0 else 2
        head, tail = data[:at], data[at:]
    if len(body) + 2 > 0xFFFF:
        return data  # APP1 한 구간에 다 들어가지 않으면 손대지 않는다
    return head + b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body + tail


# ---------- HDR 게인맵 (Ultra HDR, docs/jpeg-meta.js의 readGainMap/attachGainMap과 같은 방식) ----------
# 갤럭시·픽셀의 HDR 사진은 JPEG 뒤에 밝기 배율을 담은 작은 흑백 JPEG(게인맵)를 하나 더 붙인다.
# 본 사진의 XMP(hdrgm, Container)와 MPF(APP2)가 그 위치를 가리킨다. 엔진은 본 사진만 읽어 쓰므로
# 게인맵을 따로 꺼내 결과 크기에 맞춰 줄인 뒤 다시 붙인다.
_MPF_ID = b"MPF\0"
_ISO_GM_ID = b"urn:iso:std:iso:ts:21496:-1\0"


def read_gain_map(data: bytes) -> dict | None:
    """원본의 {gm: 게인맵 JPEG, xmp: hdrgm XMP 구간, iso: ISO 21496-1 구간 | None}. 없으면 None."""
    if data[:2] != b"\xff\xd8":
        return None
    xmp = iso = gm = None
    for m, start, end in _segments(data):
        if m == 0xE1 and data[start:start + len(_XMP_ID)] == _XMP_ID:
            body = data[start:end]
            if b"hdrgm:Version" in body and b"GainMap" in body:
                xmp = data[start - 4:end]
        elif m == 0xE2 and data[start:start + len(_ISO_GM_ID)] == _ISO_GM_ID:
            iso = data[start - 4:end]
        elif m == 0xE2 and data[start:start + 4] == _MPF_ID:
            tiff = start + 4
            e = "<" if data[tiff:tiff + 2] == b"II" else ">"
            try:
                ifd = tiff + struct.unpack_from(e + "I", data, tiff + 4)[0]
                for i in range(struct.unpack_from(e + "H", data, ifd)[0]):
                    tag, _t, count, val = struct.unpack_from(e + "HHII", data, ifd + 2 + i * 12)
                    if tag == 0xB002 and count >= 32:
                        size, off = struct.unpack_from(e + "II", data, tiff + val + 16 + 4)  # 두 번째 이미지
                        if off and tiff + off + size <= len(data):
                            gm = data[tiff + off:tiff + off + size]
            except struct.error:
                pass
    if not xmp or not gm or gm[:2] != b"\xff\xd8" or b"hdrgm" not in gm[:4096]:
        return None
    return {"gm": gm, "xmp": xmp, "iso": iso}


def gain_map_meta(gm: bytes) -> list[bytes]:
    """게인맵 JPEG 자체의 메타데이터 구간(hdrgm XMP, ISO 21496-1). 다시 인코딩한 게인맵에 옮겨 붙인다."""
    return [gm[start - 4:end] for m, start, end in _segments(gm)
            if (m == 0xE1 and gm[start:start + len(_XMP_ID)] == _XMP_ID)
            or (m == 0xE2 and gm[start:start + len(_ISO_GM_ID)] == _ISO_GM_ID)]


def insert_segments(data: bytes, segs: list[bytes]) -> bytes:
    """첫 APP0(JFIF) 뒤(없으면 SOI 뒤)에 구간들을 넣는다."""
    first = next(_segments(data), None)
    at = first[2] if first and first[0] == 0xE0 else 2
    return data[:at] + b"".join(segs) + data[at:]


def _app(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def _gm_length(text: bytes, n: int) -> bytes:
    """XMP의 GainMap 항목 길이(Item:Length)를 n으로 바꾼다."""
    def fix(mt):
        if mt.group(1):
            return mt.group(1) + str(n).encode() + mt.group(2)
        return mt.group(3) + str(n).encode() + mt.group(4)
    pat = rb'(Item:Semantic="GainMap"[^>]*?Item:Length=")\d+(")|(Item:Length=")\d+("[^>]*?Item:Semantic="GainMap")'
    return re.sub(pat, fix, text, count=1)


def attach_gain_map(primary: bytes, gm: bytes, src: dict | None) -> bytes:
    """변환 결과(primary)에 게인맵(gm)을 붙여 Ultra HDR JPEG로 만든다. src = read_gain_map(원본)."""
    if not src or primary[:2] != b"\xff\xd8" or gm[:2] != b"\xff\xd8":
        return primary
    # 결과에 남은 옛 hdrgm XMP·MPF·ISO 구간은 빼고 새로 만든다. 다른 XMP가 있으면 겹치므로 손대지 않는다
    segs = list(_segments(primary))
    last_app = max([end for m, _s, end in segs if 0xE0 <= m <= 0xEF], default=2)
    keep = []
    for m, start, end in segs:
        if end > last_app:
            break
        head = primary[start:start + 40]
        is_xmp = m == 0xE1 and head.startswith(_XMP_ID)
        if is_xmp and b"hdrgm" not in primary[start:end]:
            return primary
        if not (is_xmp or (m == 0xE2 and (head.startswith(_MPF_ID) or head.startswith(_ISO_GM_ID)))):
            keep.append(primary[start - 4:end])
    tail = primary[last_app:]

    xmp = _app(0xE1, _gm_length(src["xmp"][4:], len(gm)))
    iso = [src["iso"]] if src.get("iso") else []

    # MPF: 이미지 2장(본 사진, 게인맵)의 크기와 위치. 오프셋은 MPF의 TIFF 머리 기준 (리틀엔디언)
    head = primary[:2] + b"".join(keep)
    mpf_len = 4 + 4 + 82  # 마커·길이 + "MPF\0" + TIFF
    before_mpf = len(head) + len(xmp) + sum(len(x) for x in iso)
    total = before_mpf + mpf_len + len(tail)
    tiff_abs = before_mpf + 4 + 4
    tiff = (b"II*\0" + struct.pack("<I", 8) + struct.pack("<H", 3)
            + struct.pack("<HHI", 0xB000, 7, 4) + b"0100"
            + struct.pack("<HHII", 0xB001, 4, 1, 2)
            + struct.pack("<HHII", 0xB002, 7, 32, 50)
            + struct.pack("<I", 0)
            + struct.pack("<IIIHH", 0x030000, total, 0, 0, 0)
            + struct.pack("<IIIHH", 0, len(gm), total - tiff_abs, 0, 0))
    mpf = _app(0xE2, _MPF_ID + tiff)
    return head + xmp + b"".join(iso) + mpf + tail + gm


def _resize_gain_map(gm: bytes, src_wh: tuple[int, int], out_wh: tuple[int, int], orientation: int) -> bytes:
    """게인맵을 결과 사진과 같은 비율로 줄이고, 결과 픽셀을 돌렸으면 같은 방향으로 돌린다 (가로·세로는 화면 방향 기준)."""
    img = pyvips.Image.new_from_buffer(gm, "")
    turned = orientation in (5, 6, 7, 8)
    sw, sh = (src_wh[1], src_wh[0]) if turned else src_wh
    ow, oh = (out_wh[1], out_wh[0]) if turned else out_wh
    tw, th = max(1, int(img.width * ow / sw + 0.5)), max(1, int(img.height * oh / sh + 0.5))
    img = img.resize(tw / img.width, vscale=th / img.height, kernel="lanczos3")
    if orientation > 1:
        img = img.copy_memory().copy()
        img.set_type(pyvips.GValue.gint_type, "orientation", orientation)
        img = img.autorot()
    return img.jpegsave_buffer(Q=85, keep="none")


# ---------- 자동 보정 (리마스터, docs/worker.js의 autoTone과 같은 값) ----------
# 출발점은 갤럭시 S24 울트라 "사진 리마스터"가 2억 화소 사진에 한 일(원본·결과 3쌍을 재서 맞춤):
# 디테일은 새로 그리지 않고 1,600만 화소로 줄이며 밝기·대비·채도만 고쳤다. 여기에 역광 사진에서
# 얼굴이 어둡게 남는 문제를 고치려고, 그늘진 곳만 밝히고 색을 더 진하게 하는 단계를 더했다("보통" 강도).
#   1. 레벨: 가장 밝은 (100-p_hi)%를 흰색으로 편다. 어두운 끝(p_lo%)은 밝은 끝이 흰색에서 모자란 만큼만
#      검정으로 내린다 (뿌연 사진은 대비를 넓히고, 이미 대비가 큰 역광 사진은 그늘을 더 어둡게 만들지 않는다)
#   2. 그늘 밝히기: 주변(사진 크기의 몇 %)보다 어두운 곳일수록 1-(1-v)^g 곡선으로 밝힌다. 밝은 곳은 그대로
#   3. 채도: 휘도는 두고 색만 sat배
TONE = {"p_lo": 0.2, "p_hi": 99.5, "lift": 1.0, "t": 0.55, "sat": 1.18}
_LUMA = [[0.299, 0.587, 0.114]]


def _clip01(x: pyvips.Image) -> pyvips.Image:
    x = (x < 0).ifthenelse(0, x)
    return (x > 1).ifthenelse(1, x)


def _auto_tone(img: pyvips.Image) -> pyvips.Image:
    """sRGB 8비트 이미지의 밝기·대비·채도를 고친다 (흑백은 그대로)."""
    if img.bands < 3:
        return img
    t = TONE
    counts = struct.unpack(f"<{256 * img.bands}I", img.hist_find().write_to_memory())  # 256 × 밴드
    pooled = [sum(counts[v * img.bands + b] for b in range(3)) for v in range(256)]
    total = sum(pooled)

    def pct(p):
        want, acc = total * p / 100, 0
        for v in range(256):
            acc += pooled[v]
            if acc >= want:
                return v
        return 255

    hi = pct(t["p_hi"])
    lo = min(pct(t["p_lo"]) * min(1.0, max(0.0, (255 - hi) / 25)), hi - 1)
    lev = [min(1.0, max(0.0, (v - lo) / (hi - lo))) for v in range(256)]
    lut = pyvips.Image.new_from_memory(struct.pack("<256f", *lev), 256, 1, 1, "float")
    x = img.extract_band(0, n=3).maplut(lut)

    # 주변 밝기 지도: 16×16 칸 평균 → 상자 흐림 3번 → 쌍선형으로 다시 키운다
    f = 16
    sw, sh = max(1, img.width // f), max(1, img.height // f)
    small = x.recomb(_LUMA).crop(0, 0, min(img.width, sw * f), min(img.height, sh * f)).shrink(f, f).copy_memory()
    r = max(1, int(max(sw, sh) * 0.03))
    mask = pyvips.Image.new_from_list([[1] * (2 * r + 1)], scale=2 * r + 1)
    for _ in range(3):
        small = (small.embed(r, r, sw + 2 * r, sh + 2 * r, extend="copy")
                 .convsep(mask, precision="float").crop(r, r, sw, sh).copy_memory())
    base = small.resize(f, kernel="linear").embed(0, 0, img.width, img.height, extend="copy")

    gain = _clip01(base * (-1 / t["t"]) + 1) * t["lift"] + 1
    x = 1 - (1 - x) ** gain
    lum = x.recomb(_LUMA)
    out = ((lum + (x - lum) * t["sat"]) * 255 + 0.5).cast("uchar")
    if img.bands > 3:
        out = out.bandjoin(img.extract_band(3, n=img.bands - 3))
    return out.copy(interpretation="srgb")


def _load(data: bytes) -> pyvips.Image:
    # EXIF 회전은 _resize가 축소한 뒤 반영한다. 순차 읽기 원본을 먼저 돌리면
    # 줄 순서가 어긋나 축소 없이(배율 1) 읽을 때 실패한다
    return pyvips.Image.new_from_buffer(data, "", access="sequential")


def _resize(img: pyvips.Image, scale: float, sharpen: bool, tone: bool = False) -> pyvips.Image:
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
    out = out.copy_memory()
    if "orientation" in out.get_fields() and out.get("orientation") > 1:
        out = out.autorot().copy_memory()  # EXIF 회전 정보를 실제 픽셀에 반영
    if tone:
        out = _auto_tone(out).copy_memory()
    return out


def _strip_gps(img: pyvips.Image) -> pyvips.Image:
    img = img.copy()
    for name in img.get_fields():
        if name.startswith("exif-ifd3-"):  # IFD3 = GPS
            img.remove(name)
    return img


def _encode(img: pyvips.Image, q: int, chroma420: bool = False) -> bytes:
    return img.jpegsave_buffer(
        Q=q,
        subsample_mode="on" if chroma420 else "off",  # 기본 4:4:4 크로마: 빨간색·글자 경계 보존
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
        buf = _encode(img, q, opts.chroma420)
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
    # 변환 전에 원본의 위치 정보를 메모리에 담아 두고, 변환이 끝나면 결과에 다시 넣는다
    gps = read_gps(data) if opts.keep_gps else None
    # HDR 사진(게인맵)이면 게인맵도 꺼내 두었다가 결과 크기에 맞춰 다시 붙인다
    hdr = read_gain_map(data)

    # 원본 해상도: 해상도 그대로 다시 저장. 원본 JPEG보다 커지면 원본을 그대로 쓴다
    if opts.mode == "original":
        buf, w, h = _reencode(data, opts)
        buf = put_gps(buf, gps) if opts.keep_gps else scrub_gps(buf)[0]
        if hdr:  # 해상도·방향이 그대로이므로 원본 게인맵을 그대로 붙인다
            buf = attach_gain_map(buf, hdr["gm"], hdr)
        if is_jpeg and len(buf) >= len(data):
            return _keep_original(data, opts, t0)
        return buf, Result(width=w, height=h, src_width=w, src_height=h, quality=REENCODE_Q, size=len(buf),
                           src_size=len(data), seconds=round(time.perf_counter() - t0, 2),
                           note="해상도는 그대로 두고 용량만 줄였습니다", preset=opts.preset)

    # 이미 용량 상한 안의 JPEG는 다시 압축하지 않는다. 긴 변 프리셋도 마찬가지다: 상한 안이면
    # 원본이 같은 용량에 해상도가 더 높다
    # 자동 보정(리마스터)은 색이 바뀌므로 원본을 그대로 돌려주지 않는다
    small = len(data) <= opts.max_mb * MB
    if small and is_jpeg and not opts.tone:
        return _keep_original(data, opts, t0)

    src = _load(data)
    src_w, src_h = _oriented_size(src)

    if opts.mode == "edge":
        # 긴 변을 long_edge 이하로(또는 화소 수를 area_mp 이하로). 상한을 못 맞추면 85%, 70%로 한 단계씩 더 줄인다
        if opts.area_mp:
            s = min(1.0, math.sqrt(opts.area_mp * 1e6 / (src_w * src_h)))
        else:
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
        img = _resize(src if i == 0 else _load(data), scale, opts.sharpen, opts.tone)
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
        q, buf = opts.min_q, _encode(img, opts.min_q, opts.chroma420)
        note = "목표 상한을 넘었습니다 (최소 해상도·최저 품질 적용)"
    if opts.keep_gps:
        buf = put_gps(buf, gps)
    else:
        buf, _ = scrub_gps(buf)  # 엔진은 EXIF GPS만 지우므로 XMP의 GPS도 지운다
    if hdr:
        try:
            orientation = src.get("orientation") if "orientation" in src.get_fields() else 1
            gm = _resize_gain_map(hdr["gm"], (src_w, src_h), (img.width, img.height), orientation)
            buf = attach_gain_map(buf, insert_segments(gm, gain_map_meta(hdr["gm"])), hdr)
        except pyvips.Error:
            pass  # 게인맵이 없어도 사진은 정상
    # 그래도 원본보다 크면 원본을 그대로 쓴다 (자동 보정은 색이 바뀌었으므로 제외)
    if is_jpeg and not opts.tone and len(buf) >= len(data):
        return _keep_original(data, opts, t0)

    result = Result(
        width=img.width, height=img.height,
        src_width=src_w, src_height=src_h,
        quality=q, size=len(buf), src_size=len(data),
        seconds=round(time.perf_counter() - t0, 2),
        note=note, tries=tries, preset=opts.preset,
    )
    return buf, result
