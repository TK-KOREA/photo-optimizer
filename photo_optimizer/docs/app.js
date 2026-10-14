// 화면 처리. 변환은 worker.js가 이 기기 안에서 한다.
const $ = id => document.getElementById(id);
const drop = $("drop"), pick = $("pick"), list = $("list");
const done = [];  // { name, blob }
const MB = 1048576;

const mb = n => (n / 1048576).toFixed(1) + "MB";
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const outName = name => name.replace(/\.[^.]+$/, "") + "_optimized.jpg";

const supported = window.crossOriginIsolated;
if (!supported) {
  // coi-serviceworker가 첫 방문 때 페이지를 한 번 새로 고친다. 그래도 안 되면 브라우저 문제.
  setTimeout(() => {
    if (!window.crossOriginIsolated) $("unsupported").classList.remove("hidden");
  }, 3000);
}

// 단계마다 새 워커(= 새 1GB wasm 힙)를 띄우고, 끝나면 버린다. 이유는 worker.js 머리말 참고.
function step(msg, transfer, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker("worker.js", { type: "module" });
    w.onmessage = ({ data }) => {
      if (data.type === "progress") return onProgress(data.text);
      w.terminate();
      if (data.type === "error") reject(data);
      else resolve(data);
    };
    w.onerror = e => { w.terminate(); reject({ error: "변환 엔진을 불러오지 못했습니다.", detail: e.message }); };
    w.postMessage(msg, transfer);
  });
}

// core.py의 convert와 같은 흐름: 배율마다 축소 → Q 탐색, 상한 안에 들면 멈춘다
async function convert(file, opts, onProgress) {
  const t0 = performance.now();
  const data = new Uint8Array(await file.arrayBuffer());
  const tries = [];
  let scales, srcW, srcH, found, shrunk, lean = false;
  for (let i = 0; ; i++) {
    // 원본은 배율마다 복사해서 넘긴다 (넘긴 버퍼는 워커 쪽으로 옮겨진다)
    const input = data.slice();
    shrunk = await step({ op: "resize", data: input, scale: scales?.[i], ...opts }, [input.buffer], onProgress);
    ({ scales, srcW, srcH } = shrunk);
    const last = i === scales.length - 1;
    const enc = await step({
      op: "encode", pixels: shrunk.pixels, meta: shrunk.meta, width: shrunk.width, height: shrunk.height,
      bands: shrunk.bands, opts, scale: shrunk.scale, last,
    }, [shrunk.pixels.buffer], onProgress);
    tries.push(...enc.tries);
    lean ||= enc.lean;
    if (enc.found || last) { found = enc.found; break; }
  }

  let note = "";
  if (found.over) note = "목표 상한을 넘었습니다 (최소 해상도·최저 품질 적용)";
  else if (found.buf.length < opts.min_mb * MB) note = "최고 품질로도 목표 하한보다 작습니다 (원본 정보량이 적은 사진)";
  if (lean) note = (note ? note + " · " : "") + "기기 메모리가 부족해 메모리 절약 인코딩을 썼습니다";

  const size = found.buf.length, srcSize = data.byteLength;
  const r = {
    width: shrunk.width, height: shrunk.height, src_width: srcW, src_height: srcH,
    quality: found.q, size, src_size: srcSize, note, tries,
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    megapixels: +(shrunk.width * shrunk.height / 1e6).toFixed(1),
    src_megapixels: +(srcW * srcH / 1e6).toFixed(1),
    size_mb: +(size / MB).toFixed(2), src_size_mb: +(srcSize / MB).toFixed(2),
    saved_pct: srcSize ? +(100 * (1 - size / srcSize)).toFixed(1) : 0,
  };
  return { buf: found.buf, result: r };
}

drop.onclick = () => pick.click();
pick.onchange = () => { addFiles(pick.files); pick.value = ""; };
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); };

let queue = Promise.resolve();
function addFiles(files) {
  if (!supported) return;
  for (const f of files) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="row"><div style="min-width:0">
        <div class="name">${esc(f.name)}</div>
        <div class="meta">${mb(f.size)} · 대기 중</div></div></div>
      <div class="bar"><i></i></div>`;
    list.append(li);
    // 메모리 보호를 위해 한 장씩 순서대로 처리
    queue = queue.then(() => run(f, li));
  }
}

function run(file, li) {
  const meta = li.querySelector(".meta"), bar = li.querySelector(".bar");
  bar.classList.add("busy");
  const opts = {
    min_mb: +$("minMb").value, max_mb: +$("maxMb").value,
    min_q: 85, max_q: 95, max_scale: 0.5,
    sharpen: $("sharpen").checked, keep_gps: $("keepGps").checked,
  };
  if (!(opts.min_mb >= 0.5 && opts.min_mb < opts.max_mb && opts.max_mb <= 50)) {
    bar.remove();
    meta.insertAdjacentHTML("afterend", `<div class="err">목표 용량 범위가 올바르지 않습니다.</div>`);
    return;
  }
  return convert(file, opts, text => { meta.textContent = `${mb(file.size)} · ${text}`; })
    .then(({ buf, result: r }) => {
      bar.remove();
      const blob = new Blob([buf], { type: "image/jpeg" });
      const name = outName(file.name);
      meta.innerHTML = `${r.src_megapixels}MP → <b>${r.megapixels}MP</b> (${r.width}×${r.height}) · `
        + `${r.src_size_mb}MB → <b>${r.size_mb}MB</b> · 품질 ${r.quality} · ${r.saved_pct}% 절감 · ${r.seconds}초`;
      if (r.note) meta.insertAdjacentHTML("afterend", `<div class="note">${esc(r.note)}</div>`);
      const a = document.createElement("a");
      a.className = "btn"; a.textContent = "받기";
      a.href = URL.createObjectURL(blob); a.download = name;
      li.firstElementChild.append(a);
      done.push({ name, blob });
      $("allWrap").classList.toggle("hidden", done.length < 2);
      console.debug(file.name, r);
    })
    .catch(e => {
      bar.remove();
      console.warn(file.name, e.detail || e);
      meta.textContent = mb(file.size);
      meta.insertAdjacentHTML("afterend", `<div class="err">${esc(e.error || "변환에 실패했습니다.")}</div>`);
    });
}

$("allBtn").onclick = async () => {
  const zip = await makeZip(done);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zip); a.download = "photo-optimizer.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
};

// 무압축(STORE) ZIP. JPEG는 다시 압축해도 줄지 않는다.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [], used = new Set();
  let offset = 0;
  for (const f of files) {
    let name = f.name;
    while (used.has(name)) name = "_" + name;
    used.add(name);
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const fname = enc.encode(name), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);  // UTF-8 파일명
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true); local.setUint16(26, fname.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true); cen.setUint16(28, fname.length, true);
    cen.setUint32(42, offset, true);
    parts.push(local, fname, data);
    central.push(cen, fname);
    offset += 30 + fname.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
