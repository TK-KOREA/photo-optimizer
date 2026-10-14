// 화면 처리. 변환은 worker.js가 이 기기 안에서 한다.
const $ = id => document.getElementById(id);
const MB = 1048576;
const TOL = 3;  // 목표 용량 ± 허용 오차 (MB)
const supported = window.crossOriginIsolated;

const items = [];      // { file, name, status: wait|work|done|fail, ... }
let sel = -1;          // 무대에 보이는 사진
let follow = true;     // 사용자가 썸네일을 직접 고르기 전까지는 처리 중인 사진을 따라간다
let queue = Promise.resolve();

// ---------- 작은 도우미 ----------
const fmtMb = n => (n / MB).toFixed(1);
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const outName = name => name.replace(/\.[^.]+$/, "") + "_optimized.jpg";
const blobUrl = (buf, type) => URL.createObjectURL(new Blob([buf], { type }));
// 199.8MP → "2억", 49.9MP → "4,990만"
function koPixels(w, h) {
  const n = w * h;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + "억";
  return (Math.round(n / 1e5) * 10).toLocaleString("ko-KR") + "만";
}
const CHECK = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0m3.6 5.2a.75.75 0 0 0-1.06.05L7.2 9.06 5.43 7.33a.75.75 0 1 0-1.05 1.07l2.33 2.28a.75.75 0 0 0 1.08-.03l3.86-4.39a.75.75 0 0 0-.05-1.06"/></svg>`;
const INFO = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0m0 10.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2M8 3.5a1 1 0 0 0-1 1v4a1 1 0 0 0 2 0v-4a1 1 0 0 0-1-1"/></svg>`;

// 빈 화면의 사진 더미 그림 (풍경 일러스트)
(() => {
  const pal = [["#1e2a5a", "#f6a46b", "#ffe1b0", "#3b3f68", "#22243f"], ["#77b7f2", "#e8f3ff", "#fffbe6", "#5f8fb5", "#2f5d7c"], ["#2c5e3f", "#d8efc2", "#fff6c9", "#3f7a4c", "#1f4a2f"]];
  const stack = document.querySelector(".stack");
  pal.forEach(([s1, s2, sun, m1, m2], i) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s1}"/><stop offset="1" stop-color="${s2}"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="282" cy="128" r="30" fill="${sun}"/><path d="M0 196 54 150 96 172 160 112 226 178 292 140 348 168 400 150V300H0Z" fill="${m1}"/><path d="M0 222 70 186 138 214 214 176 300 220 360 200 400 212V300H0Z" fill="${m2}"/></svg>`;
    stack.style.setProperty(`--ph${i + 1}`, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  });
})();

// ---------- 목표 용량: 하나만 고르고 ±3MB 허용 ----------
const targetInput = $("targetMb");
function target() {
  const t = Math.round(+targetInput.value);
  return t >= 1 && t <= 47 ? t : null;
}
function showTarget() {
  const t = target();
  $("targetRange").textContent = t ? `${Math.max(0.5, t - TOL)}–${t + TOL}MB 안에서 맞춥니다` : "1~47MB 사이로 정해 주세요";
  $("minus").disabled = !t || t <= 1;
  $("plus").disabled = !t || t >= 47;
  targetInput.style.width = `${String(targetInput.value || "0").length + 0.2}ch`;
}
$("minus").onclick = () => { targetInput.value = Math.max(1, (target() ?? 8) - 1); showTarget(); };
$("plus").onclick = () => { targetInput.value = Math.min(47, (target() ?? 6) + 1); showTarget(); };
targetInput.oninput = showTarget;
targetInput.onblur = () => { if (!target()) targetInput.value = 7; showTarget(); };
showTarget();

// 옵션 패널: 바깥을 누르면 닫는다
document.addEventListener("click", e => { if (!$("opts").contains(e.target)) $("opts").open = false; });

// ---------- 파일 받기 ----------
if (!supported) {
  // coi-serviceworker가 첫 방문 때 페이지를 한 번 새로 고친다. 그래도 안 되면 브라우저 문제.
  setTimeout(() => { if (!window.crossOriginIsolated) $("unsupported").hidden = false; }, 3000);
}
const pick = $("pick"), drop = $("drop");
const openPicker = () => supported && pick.click();
pick.onchange = () => { addFiles(pick.files); pick.value = ""; };
drop.onclick = openPicker;
drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } };
document.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", openPicker));
// 페이지 어디에 놓아도 받는다
let dragDepth = 0;
addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; drop.classList.add("over"); });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("over"); } });
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
addEventListener("paste", e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) addFiles(files);
});

function addFiles(list) {
  if (!supported) return;
  const files = [...list].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|tiff?)$/i.test(f.name));
  if (!files.length) return;
  const first = items.length;
  follow = true;
  for (const file of files) {
    const it = { file, name: file.name, status: "wait", p: 0 };
    items.push(it);
    queue = queue.then(() => run(it));  // 메모리 보호를 위해 한 장씩 순서대로
  }
  const working = items.findIndex(i => i.status === "work");
  sel = working >= 0 ? working : first;
  render();
}

// ---------- 변환 ----------
// 단계마다 새 워커(= 새 1GB wasm 힙)를 띄우고, 끝나면 버린다. 이유는 worker.js 머리말 참고.
function step(msg, transfer, onMsg) {
  return new Promise((resolve, reject) => {
    const w = new Worker("worker.js", { type: "module" });
    w.onmessage = ({ data }) => {
      if (data.type === "progress" || data.type === "preview") return onMsg(data);
      w.terminate();
      data.type === "error" ? reject(data) : resolve(data);
    };
    w.onerror = e => { w.terminate(); reject({ error: "변환 엔진을 불러오지 못했습니다.", detail: e.message }); };
    w.postMessage(msg, transfer);
  });
}

// core.py의 convert와 같은 흐름: 배율마다 축소 → Q 탐색, 상한 안에 들면 멈춘다
async function convert(it, opts) {
  const t0 = performance.now();
  const data = new Uint8Array(await it.file.arrayBuffer());
  const onMsg = m => progress(it, m);
  let scales, shrunk, enc, lean = false;
  for (let i = 0; ; i++) {
    const input = data.slice();  // 넘긴 버퍼는 워커로 옮겨지므로 배율마다 복사
    shrunk = await step({ op: "resize", data: input, scale: scales?.[i], ...opts }, [input.buffer], onMsg);
    scales = shrunk.scales;
    it.src = { w: shrunk.srcW, h: shrunk.srcH };
    it.out = { w: shrunk.width, h: shrunk.height };
    const last = i === scales.length - 1;
    enc = await step({
      op: "encode", pixels: shrunk.pixels, meta: shrunk.meta, width: shrunk.width, height: shrunk.height,
      bands: shrunk.bands, opts, scale: shrunk.scale, last,
    }, [shrunk.pixels.buffer], onMsg);
    lean ||= enc.lean;
    if (enc.found || last) break;
  }
  return { ...enc, lean, seconds: Math.round((performance.now() - t0) / 1000) };
}

// 진행률: 읽고 줄이기 0→45%(시간에 따라 서서히), 화질 찾기는 시도마다 계단식, 완료 100%
function progress(it, m) {
  if (m.type === "preview") { it.preview = blobUrl(m.preview, "image/jpeg"); return render(); }
  if (m.phase === "resize") { it.phase = "resize"; it.p = Math.max(it.p, m.retry ? 40 : 2); it.q = null; }
  if (m.phase === "q") { it.phase = "q"; it.tries = (it.tries || 0) + 1; it.p = Math.min(94, 48 + it.tries * 11); it.q = m; }
  if (m.phase === "lean") { it.lean = true; it.tries = 0; }
  render();
}
setInterval(() => {
  const it = items.find(i => i.status === "work");
  if (it && it.phase === "resize" && it.p < 45) {
    it.p += (45 - it.p) * 0.035;
    if (it === items[sel]) { renderWork(it); renderDock(it); }
  }
}, 200);

async function run(it) {
  const t = target() ?? 7;
  const opts = {
    min_mb: Math.max(0.5, t - TOL), max_mb: t + TOL, target: t,
    min_q: 85, max_q: 95, max_scale: 0.5,
    sharpen: $("sharpen").checked, keep_gps: !$("stripGps").checked,
  };
  it.opts = opts;
  it.status = "work"; it.phase = "resize"; it.p = 1;
  if (follow) sel = items.indexOf(it);
  render();
  try {
    const r = await convert(it, opts);
    const f = r.found;
    it.result = { q: f.q, size: f.buf.length, over: !!f.over, lean: r.lean, seconds: r.seconds };
    it.blob = new Blob([f.buf], { type: "image/jpeg" });
    it.url = URL.createObjectURL(it.blob);
    if (r.ref) { it.ref = blobUrl(r.ref, "image/png"); it.res = blobUrl(r.res, "image/png"); }
    it.status = "done"; it.p = 100; it.fresh = true;
  } catch (e) {
    console.warn(it.name, e.detail || e);
    it.status = "fail";
    it.error = e.error || "변환에 실패했습니다.";
  }
  if (follow) sel = items.indexOf(it);
  render();
}

// ---------- 그리기 ----------
function render() {
  const it = items[sel];
  document.body.dataset.s = !it ? "empty" : it.status === "done" ? "done" : it.status === "fail" ? "fail" : "work";
  if (it?.status === "work" || it?.status === "wait") renderWork(it);
  if (it?.status === "done") renderDone(it);
  if (it?.status === "fail") { $("failName").textContent = it.name; $("failMsg").textContent = it.error; }
  renderStrip();
  renderDock(it);
}

function renderWork(it) {
  $("workName").textContent = `${it.name} · ${fmtMb(it.file.size)}MB`;
  const img = $("workImg");
  if (it.preview) {
    if (img.dataset.src !== it.preview) {
      img.classList.remove("in");
      img.onload = () => img.classList.add("in");
      img.src = img.dataset.src = it.preview;
    }
  } else { img.classList.remove("in"); img.removeAttribute("src"); delete img.dataset.src; }
  let step, detail;
  if (it.status === "wait") { step = "차례를 기다리는 중"; detail = "앞 사진이 끝나면 바로 시작합니다"; }
  else if (it.phase === "resize") {
    step = "사진 읽고 줄이는 중";
    detail = it.src ? `${koPixels(it.src.w, it.src.h)} 화소 · 더 작은 해상도로 다시 맞추는 중` : "고해상도 사진은 30초 안팎 걸립니다";
  } else {
    step = it.lean ? "메모리를 아껴 화질 찾는 중" : "가장 좋은 화질 찾는 중";
    detail = it.q ? `품질 ${it.q.q} → ${it.q.mb}MB · ${it.q.fits ? "목표 안" : "조금 큼"}` : `${koPixels(it.out.w, it.out.h)} 화소 · ${it.out.w} × ${it.out.h}`;
  }
  $("workStep").textContent = step;
  $("workDetail").textContent = detail;
  $("workBar").style.width = (it.status === "wait" ? 0 : it.p) + "%";
  const stage = it.status === "wait" ? -1 : it.phase === "resize" ? 0 : 1;
  [...$("workDots").children].forEach((li, i) => li.className = i < stage ? "ok" : i === stage ? "on" : "");
}

function renderDone(it) {
  const r = it.result, o = it.opts;
  const mb = r.size / MB, inRange = !r.over && mb >= o.min_mb;
  $("okLine").className = "ok" + (inRange ? "" : " warnc");
  $("okLine").innerHTML = (inRange ? CHECK : INFO) + (inRange ? `목표 ${o.target}MB ± ${TOL}MB 안에 들어왔습니다`
    : r.over ? "목표보다 큽니다" : "목표보다 작게 나왔습니다");
  $("fromMb").textContent = fmtMb(it.file.size) + "MB";
  const pct = Math.round(100 * (1 - r.size / it.file.size));
  $("saved").textContent = pct > 0 ? `${pct}% 가벼워졌어요` : "원본보다 크지 않게 맞췄어요";
  $("factList").innerHTML = [
    ["해상도", `${koPixels(it.src.w, it.src.h)} → ${koPixels(it.out.w, it.out.h)} 화소`],
    ["크기", `${it.out.w} × ${it.out.h}`],
    ["JPEG 품질", r.q],
    ["촬영 위치", o.keep_gps ? "유지" : "지움"],
    ["걸린 시간", `${r.seconds}초`],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(String(v))}</dd>`).join("");
  const notes = [];
  if (r.over) notes.push("가장 작은 해상도와 최저 품질로도 상한을 넘었습니다. 목표 용량을 늘려 보세요.");
  else if (!inRange) notes.push("최고 품질로도 이 크기입니다. 원본에 담긴 정보가 적은 사진이라 더 키울 필요가 없습니다.");
  if (r.lean) notes.push("기기 메모리가 부족해 메모리를 아끼는 방식으로 저장했습니다.");
  $("note").hidden = !notes.length;
  $("note").textContent = notes.join(" ");

  const save = $("saveBtn");
  save.href = it.url; save.download = outName(it.name);
  save.textContent = `저장 · ${fmtMb(r.size)}MB`;
  $("tagRes").textContent = `결과 ${fmtMb(r.size)}MB`;

  $("cmp").classList.toggle("noviews", !it.ref);
  $("fullImg").src = it.preview || it.url;
  if (it.ref) { $("refImg").src = it.ref; $("resImg").src = it.res; }
  // 완료 직후 결과 숫자를 원본 용량에서부터 줄여 보인다
  const toEl = $("toMb"), to = r.size / MB, from = it.file.size / MB, token = ++countToken;
  if (it.fresh && !document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    it.fresh = false;
    const t0 = performance.now();
    const tick = now => {
      if (token !== countToken) return;  // 다른 사진으로 바뀌면 이전 애니메이션은 멈춘다
      const k = Math.min(1, (now - t0) / 900), e = 1 - (1 - k) ** 3;
      toEl.textContent = (from - (from - to) * e).toFixed(1);
      if (k < 1) requestAnimationFrame(tick);
    };
    toEl.textContent = from.toFixed(1);
    requestAnimationFrame(tick);
    // 탭이 가려져 있으면 프레임이 멈추므로 최종값은 따로 보장한다
    setTimeout(() => { if (token === countToken) toEl.textContent = to.toFixed(1); }, 1000);
  } else toEl.textContent = to.toFixed(1);
}

let countToken = 0;

// 비교: "실제 크기로 비교"(가운데 1200×900, 결과 픽셀 1:1) ↔ "전체 사진"
const slider = $("slider");
slider.oninput = () => $("cmp").style.setProperty("--x", slider.value + "%");
$("modeBtn").onclick = () => {
  const whole = $("cmp").classList.toggle("whole");
  $("modeBtn").textContent = whole ? "실제 크기로 비교" : "전체 사진";
};

function renderStrip() {
  $("stripWrap").hidden = items.length < 2;
  $("strip").innerHTML = items.map((it, i) => {
    const inner = it.status === "done" ? `<img src="${it.preview || it.url}" alt=""><span class="badge">−${Math.max(0, Math.round(100 * (1 - it.result.size / it.file.size)))}%</span>`
      : it.status === "fail" ? `<span class="badge bad">실패</span>`
      : it.status === "work" ? (it.preview ? `<img src="${it.preview}" alt="">` : "") + `<span class="spin"></span>`
      : `<span class="wait">대기</span>`;
    return `<button class="thumb ${i === sel ? "sel" : ""}" data-i="${i}" role="listitem" aria-label="${esc(it.name)}">${inner}</button>`;
  }).join("") + `<button class="thumb add" aria-label="사진 추가">+</button>`;
  $("strip").querySelectorAll(".thumb[data-i]").forEach(b => b.onclick = () => { sel = +b.dataset.i; follow = false; render(); });
  $("strip").querySelector(".thumb.add").onclick = openPicker;
  const done = items.filter(i => i.status === "done");
  $("zipBtn").hidden = done.length < 2;
  $("zipCount").textContent = `(${done.length}장, ZIP)`;
}

function renderDock(it) {
  const cta = $("cta"), alt = document.querySelector(".cta.alt");
  alt.hidden = !it;
  cta.disabled = false;
  if (!it) { cta.textContent = "사진 고르기"; cta.onclick = openPicker; }
  else if (it.status === "done") { cta.textContent = `저장 · ${fmtMb(it.result.size)}MB`; cta.onclick = () => $("saveBtn").click(); }
  else if (it.status === "fail") { cta.textContent = "다른 사진 고르기"; cta.onclick = openPicker; }
  else { cta.textContent = it.status === "wait" ? "차례를 기다리는 중" : `변환하는 중 · ${Math.round(it.p)}%`; cta.disabled = true; }
}

// ---------- ZIP (무압축. JPEG는 다시 압축해도 줄지 않는다) ----------
$("zipBtn").onclick = async () => {
  const zip = await makeZip(items.filter(i => i.status === "done").map(i => ({ name: outName(i.name), blob: i.blob })));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zip); a.download = "photo-optimizer.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
};

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

render();
