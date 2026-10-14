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
