// JPEG 머리 정보 읽기와 GPS 무손실 제거. 픽셀 데이터는 건드리지 않는다.
// 원본을 다시 압축할 필요가 없을 때(이미 목표 크기 안) 위치 정보만 지우는 데 쓴다.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const XMP_ID = "http://ns.adobe.com/xap/1.0/\0";
// XMP 속성(exif:GPSLatitude="…") 또는 요소(<exif:GPSLatitude>…</exif:GPSLatitude>, <exif:GPS… />)
const XMP_GPS = /\sexif:GPS\w*="[^"]*"|<exif:GPS(\w*)\b[^>]*?\/>|<exif:GPS(\w*)\b[^>]*>[\s\S]*?<\/exif:GPS\2>/g;

export const isJpeg = u8 => u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8;
const latin1 = (u8, a, b) => String.fromCharCode(...u8.subarray(a, Math.min(b, u8.length)));

// 마커 구간(SOS 전까지)을 차례로 넘겨준다
function* segments(u8) {
  let p = 2;
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xff) return;
    if (u8[p + 1] === 0xff) { p++; continue; }  // 채움 바이트
    const marker = u8[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return;  // SOS, EOI
    const end = p + 2 + ((u8[p + 2] << 8) | u8[p + 3]);
    if (end > u8.length) return;
    yield { marker, start: p + 4, end };
    p = end;
  }
}

function tiffReader(u8, tiff) {
  const le = u8[tiff] === 0x49;  // "II"
  return {
    r16: o => (le ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1]),
    r32: o => (le ? u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)
                  : (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0,
  };
}

// IFD0에서 찾는 태그의 항목 위치
function findTag(u8, tiff, end, tag) {
  const { r16, r32 } = tiffReader(u8, tiff);
  const ifd0 = tiff + r32(tiff + 4);
  if (ifd0 + 2 > end) return -1;
  for (let i = 0, n = r16(ifd0); i < n; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > end) return -1;
    if (r16(e) === tag) return e;
  }
  return -1;
}

// 가로·세로(EXIF 회전 반영), 회전값
export function jpegInfo(u8) {
  let w = 0, h = 0, orientation = 1;
  for (const s of segments(u8)) {
    const m = s.marker;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      h = (u8[s.start + 1] << 8) | u8[s.start + 2];
      w = (u8[s.start + 3] << 8) | u8[s.start + 4];
    } else if (m === 0xe1 && latin1(u8, s.start, s.start + 6) === "Exif\0\0") {
      const tiff = s.start + 6, e = findTag(u8, tiff, s.end, 0x0112);
      if (e >= 0) orientation = tiffReader(u8, tiff).r16(e + 8);
    }
  }
  if (orientation >= 5 && orientation <= 8) [w, h] = [h, w];
  return { w, h, orientation };
}

// EXIF GPS IFD는 내용을 0으로 채우고 항목 수를 0으로, XMP의 exif:GPS*는 같은 길이의 공백으로 바꾼다.
// 길이가 바뀌지 않으므로 다른 오프셋이 어긋나지 않는다. 지운 것이 없으면 입력을 그대로 돌려준다.
export function scrubGps(input) {
  if (!isJpeg(input)) return { bytes: input, removed: false };
  const u8 = input.slice();
  let removed = false;
  for (const s of segments(u8)) {
    if (s.marker !== 0xe1) continue;
    if (latin1(u8, s.start, s.start + 6) === "Exif\0\0") {
      const tiff = s.start + 6, e = findTag(u8, tiff, s.end, 0x8825);
      if (e < 0) continue;
      const { r16, r32 } = tiffReader(u8, tiff);
      const gps = tiff + r32(e + 8);
      if (gps + 2 > s.end) continue;
      const n = r16(gps);
      for (let j = 0; j < n; j++) {
        const g = gps + 2 + j * 12;
        if (g + 12 > s.end) break;
        const size = (TYPE_SIZE[r16(g + 2)] || 1) * r32(g + 4);
        const off = tiff + r32(g + 8);
        if (size > 4 && off + size <= s.end) u8.fill(0, off, off + size);
      }
      u8.fill(0, gps, Math.min(s.end, gps + 2 + n * 12 + 4));  // 항목 수, 항목, 다음 IFD 위치
      removed ||= n > 0;
    } else if (latin1(u8, s.start, s.start + XMP_ID.length) === XMP_ID) {
      const from = s.start + XMP_ID.length;
      for (const m of latin1(u8, from, s.end).matchAll(XMP_GPS)) {
        u8.fill(0x20, from + m.index, from + m.index + m[0].length);
        removed = true;
      }
    }
  }
  return { bytes: removed ? u8 : input, removed };
}

// ---------- 위치 정보 옮겨 심기 ----------
// 변환 엔진이 메타데이터를 다시 쓰는 과정에서 GPS를 잃을 때가 있다. 그래서 변환 전에 원본의
// GPS IFD를 읽어 메모리에 담아 두고(readGps), 변환이 끝난 JPEG에 다시 넣는다(putGps).
// 값은 엔디언과 무관하게 빅엔디언 바이트로 담아, 결과 파일의 엔디언에 맞춰 다시 쓴다.

// 한 원소의 바이트 수 (RATIONAL은 4바이트 둘이라 4바이트씩 뒤집는다)
const unitSize = type => (type === 5 || type === 10 ? 4 : TYPE_SIZE[type] || 1);

function exifSegment(u8) {
  for (const s of segments(u8)) {
    if (s.marker === 0xe1 && latin1(u8, s.start, s.start + 6) === "Exif\0\0") return s;
  }
  return null;
}

// 원본의 GPS 항목들 [{ tag, type, count, bytes }] (없으면 null)
export function readGps(u8) {
  if (!isJpeg(u8)) return null;
  const s = exifSegment(u8);
  if (!s) return null;
  const tiff = s.start + 6, e = findTag(u8, tiff, s.end, 0x8825);
  if (e < 0) return null;
  const le = u8[tiff] === 0x49, { r16, r32 } = tiffReader(u8, tiff);
  const gps = tiff + r32(e + 8);
  if (gps + 2 > s.end) return null;
  const out = [];
  for (let j = 0, n = r16(gps); j < n; j++) {
    const g = gps + 2 + j * 12;
    if (g + 12 > s.end) break;
    const type = r16(g + 2), count = r32(g + 4);
    if (!TYPE_SIZE[type]) continue;
    const size = TYPE_SIZE[type] * count;
    const from = size <= 4 ? g + 8 : tiff + r32(g + 8);
    if (from + size > s.end) continue;
    const bytes = u8.slice(from, from + size);
    const u = unitSize(type);
    if (le && u > 1) for (let k = 0; k < size; k += u) bytes.subarray(k, k + u).reverse();
    out.push({ tag: r16(g), type, count, bytes });
  }
  return out.length ? out : null;
}

// TIFF 조각을 쓰는 도구 (le = 리틀엔디언)
function tiffWriter(le) {
  const bytes = [];
  const w16 = v => (le ? bytes.push(v & 255, v >> 8 & 255) : bytes.push(v >> 8 & 255, v & 255));
  const w32 = v => (le ? bytes.push(v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24)
                       : bytes.push(v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255));
  return { bytes, w16, w32 };
}

// GPS IFD를 offset(TIFF 머리 기준) 위치에 놓을 바이트로 만든다
function gpsIfd(gps, offset, le) {
  const w = tiffWriter(le);
  const list = [...gps].sort((a, b) => a.tag - b.tag);
  let data = offset + 2 + list.length * 12 + 4;
  const extra = [];
  w.w16(list.length);
  for (const g of list) {
    const b = g.bytes.slice(), u = unitSize(g.type);
    if (le && u > 1) for (let k = 0; k < b.length; k += u) b.subarray(k, k + u).reverse();
    w.w16(g.tag); w.w16(g.type); w.w32(g.count);
    if (b.length <= 4) { w.bytes.push(...b); for (let k = b.length; k < 4; k++) w.bytes.push(0); }
    else {
      w.w32(data);
      extra.push(...b);
      if (b.length & 1) extra.push(0);  // 오프셋은 짝수로 맞춘다
      data += b.length + (b.length & 1);
    }
  }
  w.w32(0);
  w.bytes.push(...extra);
  return w.bytes;
}

// 변환 결과에 GPS를 넣는다. 이미 있으면 메모리에 담아 둔 원본 값으로 바꾼다.
// 기존 EXIF 내용은 그대로 두고 끝에 새 IFD0(GPS 항목 포함)과 GPS IFD를 덧붙인 뒤
// 머리의 IFD0 위치만 바꾼다. 그래서 다른 항목의 오프셋은 하나도 움직이지 않는다.
export function putGps(u8, gps) {
  if (!gps?.length || !isJpeg(u8)) return u8;
  const s = exifSegment(u8);
  let head, tail, seg;
  if (s) {
    const tiff = s.start + 6, le = u8[tiff] === 0x49, { r16, r32 } = tiffReader(u8, tiff);
    const ifd0 = tiff + r32(tiff + 4);
    if (ifd0 + 2 > s.end) return u8;
    const n = r16(ifd0);
    if (ifd0 + 2 + n * 12 + 4 > s.end) return u8;
    const entries = [];
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + i * 12;
      if (r16(e) !== 0x8825) entries.push({ tag: r16(e), raw: u8.subarray(e, e + 12) });
    }
    let base = s.end - tiff;
    const pad = base & 1;
    base += pad;
    const gpsAt = base + 2 + (entries.length + 1) * 12 + 4;
    const w = tiffWriter(le);
    const ptr = tiffWriter(le);
    ptr.w16(0x8825); ptr.w16(4); ptr.w32(1); ptr.w32(gpsAt);
    entries.push({ tag: 0x8825, raw: ptr.bytes });
    entries.sort((a, b) => a.tag - b.tag);
    for (let k = 0; k < pad; k++) w.bytes.push(0);
    w.w16(entries.length);
    for (const e of entries) w.bytes.push(...e.raw);
    w.bytes.push(...u8.subarray(ifd0 + 2 + n * 12, ifd0 + 2 + n * 12 + 4));  // 다음 IFD(썸네일) 위치
    w.bytes.push(...gpsIfd(gps, gpsAt, le));
    const old = u8.subarray(s.start, s.end).slice();
    const at = tiffWriter(le); at.w32(base);
    old.set(at.bytes, 6 + 4);  // 머리의 IFD0 위치
    seg = new Uint8Array(old.length + w.bytes.length);
    seg.set(old); seg.set(w.bytes, old.length);
    head = u8.subarray(0, s.start - 4); tail = u8.subarray(s.end);
  } else {
    // EXIF가 아예 없으면 GPS만 담은 EXIF를 새로 만든다 (JFIF APP0 뒤, 없으면 SOI 뒤)
    const w = tiffWriter(false);
    w.bytes.push(0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42); w.w32(8);
    w.w16(1); w.w16(0x8825); w.w16(4); w.w32(1); w.w32(26); w.w32(0);
    w.bytes.push(...gpsIfd(gps, 26, false));
    seg = Uint8Array.from(w.bytes);
    let at = 2;
    for (const t of segments(u8)) { if (t.marker === 0xe0) at = t.end; break; }
    head = u8.subarray(0, at); tail = u8.subarray(at);
  }
  const len = seg.length + 2;
  if (len > 0xffff) return u8;  // APP1 한 구간에 다 들어가지 않으면 손대지 않는다
  const out = new Uint8Array(head.length + 4 + seg.length + tail.length);
  out.set(head);
  out.set([0xff, 0xe1, len >> 8, len & 255], head.length);
  out.set(seg, head.length + 4);
  out.set(tail, head.length + 4 + seg.length);
  return out;
}

// 실제 촬영 위치가 들어 있는지. 안드로이드는 위치 읽기 권한이 없는 앱(브라우저 포함)에 사진을 넘길 때
// GPS 항목은 남기고 위도·경도 값만 0으로 채운다. 그런 사진은 위치가 없는 것으로 본다.
export function hasLocation(u8) {
  const gps = readGps(u8);
  const real = tag => gps?.find(g => g.tag === tag)?.bytes.some(b => b !== 0);
  if (real(2) || real(4)) return true;
  // XMP에만 위치가 있는 사진(라이트룸 등에서 내보낸 사진)
  return !gps && scrubGps(u8).removed;
}

// ---------- HDR 게인맵 (Ultra HDR) ----------
// 갤럭시·픽셀의 HDR 사진은 보통 JPEG 뒤에 밝기 배율을 담은 작은 흑백 JPEG(게인맵)를 하나 더 붙인다.
// 본 사진의 XMP(hdrgm, Container)와 MPF(APP2)가 그 위치를 가리킨다. 변환 엔진은 본 사진만 읽어 쓰므로
// 게인맵을 따로 꺼내 두었다가, 줄인 게인맵을 결과에 다시 붙인다(attachGainMap).

const MPF_ID = "MPF\0";
const ISO_GM_ID = "urn:iso:std:iso:ts:21496:-1\0";
const segBytes = (u8, s) => u8.subarray(s.start - 4, s.end);  // 마커부터 끝까지

// 원본의 게인맵 { gm: 게인맵 JPEG, xmp: 본 사진의 hdrgm XMP 구간, iso: ISO 21496-1 구간 | null }. 없으면 null
export function readGainMap(u8) {
  if (!isJpeg(u8)) return null;
  let xmp = null, iso = null, gm = null;
  for (const s of segments(u8)) {
    if (s.marker === 0xe1 && latin1(u8, s.start, s.start + XMP_ID.length) === XMP_ID) {
      const text = latin1(u8, s.start, s.end);
      if (text.includes("hdrgm:Version") && text.includes("GainMap")) xmp = segBytes(u8, s).slice();
    } else if (s.marker === 0xe2 && latin1(u8, s.start, s.start + ISO_GM_ID.length) === ISO_GM_ID) {
      iso = segBytes(u8, s).slice();
    } else if (s.marker === 0xe2 && latin1(u8, s.start, s.start + 4) === MPF_ID) {
      const tiff = s.start + 4, { r16, r32 } = tiffReader(u8, tiff);
      const ifd = tiff + r32(tiff + 4);
      for (let i = 0, n = r16(ifd); i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (r16(e) !== 0xb002 || r32(e + 4) < 32) continue;
        const list = tiff + r32(e + 8);
        const size = r32(list + 16 + 4), off = r32(list + 16 + 8);  // 두 번째 이미지
        if (off && tiff + off + size <= u8.length) gm = u8.slice(tiff + off, tiff + off + size);
      }
    }
  }
  if (!xmp || !gm || !isJpeg(gm) || !latin1(gm, 0, Math.min(gm.length, 4096)).includes("hdrgm")) return null;
  return { gm, xmp, iso };
}

// 게인맵 JPEG 자체의 메타데이터 구간(hdrgm XMP, ISO 21496-1). 다시 인코딩한 게인맵에 옮겨 붙인다
export function gainMapMeta(gm) {
  const out = [];
  for (const s of segments(gm)) {
    const xmp = s.marker === 0xe1 && latin1(gm, s.start, s.start + XMP_ID.length) === XMP_ID;
    const iso = s.marker === 0xe2 && latin1(gm, s.start, s.start + ISO_GM_ID.length) === ISO_GM_ID;
    if (xmp || iso) out.push(segBytes(gm, s).slice());
  }
  return out;
}

// JPEG의 첫 APP0(JFIF) 뒤(없으면 SOI 뒤)에 구간들을 넣는다
export function insertSegments(u8, segs) {
  let at = 2;
  for (const s of segments(u8)) { if (s.marker === 0xe0) at = s.end; break; }
  return concat([u8.subarray(0, at), ...segs, u8.subarray(at)]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function app(marker, payload) {
  const len = payload.length + 2;
  return concat([Uint8Array.of(0xff, marker, len >> 8, len & 255), payload]);
}

// 변환 결과(primary)에 게인맵(gm)을 붙여 Ultra HDR JPEG로 만든다. src = readGainMap(원본)
export function attachGainMap(primary, gm, src) {
  if (!isJpeg(primary) || !isJpeg(gm) || !src) return primary;
  // 결과에 남은 옛 hdrgm XMP·MPF·ISO 구간은 빼고 새로 만든다. 다른 XMP가 있으면 겹치므로 손대지 않는다
  const keep = [];
  let lastApp = 2;
  for (const s of segments(primary)) {
    const head = latin1(primary, s.start, s.start + 40);
    const isXmp = s.marker === 0xe1 && head.startsWith(XMP_ID);
    if (isXmp && !latin1(primary, s.start, s.end).includes("hdrgm")) return primary;
    const drop = isXmp || (s.marker === 0xe2 && (head.startsWith(MPF_ID) || head.startsWith(ISO_GM_ID)));
    if (s.marker >= 0xe0 && s.marker <= 0xef) lastApp = s.end;
    keep.push({ s, drop });
  }
  const before = [], after = [];
  let p = 2;
  for (const { s, drop } of keep) {
    if (s.end > lastApp) break;
    if (!drop) before.push(primary.subarray(s.start - 4, s.end));
    p = s.end;
  }
  after.push(primary.subarray(p));

  // XMP: 게인맵 길이만 새 값으로
  const xmpText = latin1(src.xmp, 4, src.xmp.length).replace(
    /(Item:Semantic="GainMap"[^>]*?Item:Length=")\d+(")|(Item:Length=")\d+("[^>]*?Item:Semantic="GainMap")/,
    (m, a, b, c, d) => a ? `${a}${gm.length}${b}` : `${c}${gm.length}${d}`);
  const xmp = app(0xe1, Uint8Array.from(xmpText, ch => ch.charCodeAt(0)));
  const iso = src.iso ? [src.iso] : [];

  // MPF: 이미지 2장(본 사진, 게인맵)의 크기와 위치. 오프셋은 MPF의 TIFF 머리 기준 (리틀엔디언)
  const mp = new Uint8Array(4 + 82);
  const dv = new DataView(mp.buffer);
  mp.set([0x4d, 0x50, 0x46, 0, 0x49, 0x49, 0x2a, 0], 0);
  dv.setUint32(8, 8, true);
  dv.setUint16(12, 3, true);
  const entry = (i, tag, type, count, value) => {
    const e = 14 + i * 12;
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
    if (typeof value === "string") mp.set(Uint8Array.from(value, c => c.charCodeAt(0)), e + 8);
    else dv.setUint32(e + 8, value, true);
  };
  entry(0, 0xb000, 7, 4, "0100");
  entry(1, 0xb001, 4, 1, 2);
  entry(2, 0xb002, 7, 32, 50);
  dv.setUint32(14 + 36, 0, true);  // 다음 IFD 없음

  const head = concat([primary.subarray(0, 2), ...before]);
  const total = head.length + xmp.length + iso.reduce((n, s) => n + s.length, 0) + (mp.length + 4) + after[0].length;
  const tiffAbs = head.length + xmp.length + iso.reduce((n, s) => n + s.length, 0) + 4 + 4;
  // MP 항목 (16바이트씩): 속성, 크기, 오프셋, 종속 이미지 2개
  const list = 4 + 50;
  dv.setUint32(list, 0x030000, true); dv.setUint32(list + 4, total, true); dv.setUint32(list + 8, 0, true);
  dv.setUint32(list + 16, 0, true); dv.setUint32(list + 20, gm.length, true); dv.setUint32(list + 24, total - tiffAbs, true);
  const mpfSeg = app(0xe2, mp);
  return concat([head, xmp, ...iso, mpfSeg, after[0], gm]);
}
