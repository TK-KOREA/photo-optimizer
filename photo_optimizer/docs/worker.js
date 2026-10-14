// 브라우저 안에서 core.py와 같은 방식으로 변환한다 (wasm-vips = libvips의 WebAssembly 빌드).
// 사진은 이 기기 밖으로 나가지 않는다.
//
// 이 빌드의 wasm 힙은 1GB 고정이고, 2억 화소를 디코딩하고 나면 힙이 조각나 큰 연속 블록을
// 잡을 수 없다. 그런데 최고 품질 JPEG 인코딩(optimize_coding + trellis)은 5천만 화소 기준
// 성분마다 100MB짜리 계수 버퍼를 2벌씩 잡는다. 그래서 워커 하나가 한 단계만 하고 끝난다.
//   resize: 원본 디코딩 → 선형광 Lanczos3 축소 → 픽셀과 메타데이터를 돌려준다
//   encode: 새 힙에서 픽셀을 받아 Q 이진 탐색
import Vips from "./vendor/wasm-vips/vips-es6.js";

const MB = 1024 * 1024;
// 시도할 축소 배율 (가로/세로 기준). 0.5 = 면적 1/4 = 2억 → 5천만 화소
const SCALE_STEPS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25];
// 브라우저 메모리 보호: 이보다 큰 이미지는 거절한다
const MAX_PIXELS = 300e6;

const ready = Vips({ dynamicLibraries: [] }).then(v => {
  v.concurrency(Math.min(navigator.hardwareConcurrency || 4, 4));
  v.Cache.max(0);
  return v;
});
let vips;

// 체인 중간 결과까지 모두 직접 해제해야 wasm 메모리가 회수된다
class Scope {
  items = [];
  add(x) { this.items.push(x); return x; }
  free() { for (const x of this.items) if (!x.isDeleted()) x.delete(); this.items = []; }
}

class UserError extends Error {}

// 진행 상황: phase = "resize" | "q" | "lean"
const progress = info => postMessage({ type: "progress", ...info });

// ---------- resize ----------

function stripGps(s, img) {
  const out = s.add(img.copy());
  const fields = out.getFields();
  for (let i = 0; i < fields.size(); i++) {
    const name = fields.get(i);
    if (name.startsWith("exif-ifd3-")) out.remove(name);  // IFD3 = GPS
  }
  fields.delete();
  return out;
}

function pickScales(w, h, maxScale) {
  const scales = [1.0, ...SCALE_STEPS].filter(x => x <= maxScale);
  // 출력이 너무 작아지는(장변 2000px 미만) 배율은 제외
  const usable = scales.filter(x => Math.max(w, h) * x >= 2000);
  return usable.length ? usable : [scales[0]];
}

// scale을 안 주면 원본 크기로 배율 목록을 정하고 첫 배율로 축소한다
function resize({ data, scale, max_scale, sharpen, keep_gps }) {
  const s = new Scope();
  try {
    let img = s.add(vips.Image.newFromBuffer(data, "", { access: "sequential" }));
    img = s.add(img.autorot());  // EXIF 회전 정보를 실제 픽셀에 반영
    const srcW = img.width, srcH = img.height;
    if (srcW * srcH > MAX_PIXELS) {
      throw new UserError(`3억 화소까지 줄일 수 있어요. 이 사진은 ${(srcW * srcH / 1e8).toFixed(1).replace(/\.0$/, "")}억 화소예요.`);
    }
    const scales = pickScales(srcW, srcH, max_scale);
    scale ??= scales[0];

    // 선형 광(linear light) 공간에서 Lanczos3로 축소한다 (core.py의 _resize와 동일)
    if (img.hasAlpha()) img = s.add(img.flatten({ background: [255, 255, 255] }));
    if (img.interpretation !== "srgb" && img.interpretation !== "b-w") img = s.add(img.colourspace("srgb"));
    if (!keep_gps) img = stripGps(s, img);
    // 메타데이터만 담은 1×1 JPEG. encode 워커가 이 이미지의 메타데이터를 결과에 붙인다.
    // 원본은 순차 읽기라 픽셀을 먼저 읽으면 안 된다. 검은 점을 덮어 그 1×1만 잘라 저장한다
    // (다중 입력 연산은 첫 입력 img의 메타데이터를 물려받고, 픽셀은 덮은 점에서만 읽는다).
    const dot = s.add(vips.Image.black(1, 1, { bands: img.bands }));
    const meta = s.add(s.add(img.insert(dot, 0, 0)).crop(0, 0, 1, 1)).jpegsaveBuffer({ Q: 50, keep: 1 | 2 | 4 | 8 });

    let out = img;
    if (scale < 1) {
      out = s.add(s.add(s.add(img.colourspace("scrgb")).resize(scale, { kernel: "lanczos3" })).colourspace("srgb"));
    }
    if (sharpen) out = s.add(out.sharpen({ sigma: 0.5, x1: 2, m1: 0, m2: 2 }));
    out = s.add(out.cast("uchar"));
    const pixels = out.writeToMemory();
    return { srcW, srcH, scales, scale, width: out.width, height: out.height, bands: out.bands, pixels, meta };
  } finally {
    s.free();
  }
}

// ---------- encode ----------

// 새 힙에서도 계수 버퍼를 못 잡는 기기(휴대폰 등)면 계수를 버퍼링하지 않는 스트리밍 인코딩으로
// 바꾼다. 같은 Q에서 파일이 커지므로 이진 탐색을 처음부터 다시 한다.
let lean = false;
class LeanRetry extends Error {}

function encodeOnce(img, q) {
  try {
    return img.jpegsaveBuffer({
      Q: q,
      subsample_mode: "off",      // 4:4:4 크로마: 빨간색·글자 경계 보존
      optimize_coding: !lean,
      trellis_quant: !lean,       // mozjpeg 최적화
      overshoot_deringing: true,
      quant_table: 3,
      keep: 1 | 2 | 4 | 8,        // exif, xmp, iptc, icc
    });
  } catch (e) {
    if (lean || !/Insufficient memory/i.test(String(e?.message || e))) throw e;
    lean = true;
    throw new LeanRetry();
  }
}

function searchQ(img, opts, scale, tries) {
  const limit = opts.max_mb * MB;
  let lo = opts.min_q, hi = opts.max_q, best = null;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const buf = encodeOnce(img, q);
    tries.push({ scale, q, mb: +(buf.length / MB).toFixed(2), lean });
    progress({ phase: "q", q, mb: (buf.length / MB).toFixed(2), fits: buf.length <= limit });
    if (buf.length <= limit) { best = { q, buf }; lo = q + 1; }
    else hi = q - 1;
  }
  return best;
}

function withLeanRetry(fn) {
  try { return fn(); }
  catch (e) {
    if (!(e instanceof LeanRetry)) throw e;
    progress({ phase: "lean" });
    return fn();
  }
}

const PREVIEW_PX = 1600;
const CROP_W = 1600, CROP_H = 1200;

// "실제 크기로 비교"용 같은 영역 두 장 (가운데 1600×1200, 결과 픽셀 1:1). 화면에서 최대 800%까지 확대한다.
// ref는 JPEG로 압축하기 직전 픽셀(= 원본을 같은 크기로 본 모습), res는 실제 결과 JPEG를 디코딩한 것.
// 둘 다 무손실 PNG로 넘겨 비교에 다른 손실이 끼지 않게 한다.
function makeViews(s, img, buf) {
  const w = Math.min(CROP_W, img.width), h = Math.min(CROP_H, img.height);
  const x = (img.width - w) >> 1, y = (img.height - h) >> 1;
  const ref = s.add(img.crop(x, y, w, h)).pngsaveBuffer({ compression: 1 });
  const dec = s.add(vips.Image.newFromBuffer(buf, "", { access: "sequential" }));
  const res = s.add(dec.crop(x, y, w, h)).pngsaveBuffer({ compression: 1 });
  return { ref, res };
}

function encode({ pixels, width, height, bands, meta, opts, scale, last }) {
  const s = new Scope();
  const tries = [];
  try {
    const raw = s.add(vips.Image.newFromMemory(pixels, width, height, bands, "uchar"));
    const src = s.add(vips.Image.newFromBuffer(meta, ""));
    // 다중 입력 연산의 결과는 첫 번째 입력의 메타데이터를 물려받는다.
    // 1×1 메타데이터 이미지 위에 픽셀 전체를 덮어 크기·픽셀은 raw, 메타데이터는 원본을 쓴다.
    const joined = s.add(src.insert(raw, 0, 0, { expand: true }));
    const img = joined.copyMemory();
    s.free();  // 이후 Q 탐색에서 여러 번 인코딩하므로 결과만 메모리에 남긴다
    s.add(img);
    // 품질을 찾는 동안 화면에 띄울 미리보기
    const preview = s.add(img.resize(Math.min(1, PREVIEW_PX / Math.max(width, height)))).jpegsaveBuffer({ Q: 82 });
    postMessage({ type: "preview", preview }, [preview.buffer]);

    let found = withLeanRetry(() => searchQ(img, opts, scale, tries));
    if (!found && last) {
      // 최소 배율에서도 상한 초과: 최저 Q로 저장
      found = { q: opts.min_q, buf: withLeanRetry(() => encodeOnce(img, opts.min_q)), over: true };
    }
    let views = {};
    if (found) {
      try { views = makeViews(s, img, found.buf); }
      catch (e) { console.warn("미리보기 생성 실패", e); }  // 미리보기는 없어도 변환은 성공
    }
    return { found, tries, lean, ...views };
  } finally {
    s.free();
  }
}

// ---------- 메시지 ----------

onmessage = async ({ data: msg }) => {
  try {
    vips = await ready;
    if (msg.op === "resize") {
      progress({ phase: "resize", retry: msg.scale !== undefined });
      const r = resize(msg);
      postMessage({ type: "done", ...r }, [r.pixels.buffer, r.meta.buffer]);
    } else {
      const r = encode(msg);
      const transfer = r.found ? [r.found.buf.buffer] : [];
      if (r.ref) transfer.push(r.ref.buffer, r.res.buffer);
      postMessage({ type: "done", ...r }, transfer);
    }
  } catch (e) {
    const text = String(e?.message || e);
    postMessage({
      type: "error",
      error: e instanceof UserError ? text
        : /memory|alloc|out of bounds/i.test(text) ? "이 기기에서는 메모리가 부족해요. PC에서 열어 주세요."
        : "이 파일은 열 수 없어요. JPEG·PNG·WebP·TIFF 사진인지 확인해 주세요.",
      detail: text,
    });
  }
};
