// 화면 처리. 변환은 worker.js가 이 기기 안에서 한다.
// ?v= 는 index.html의 버전과 맞춘다 (캐시에 남은 옛 파일과 섞이지 않게)
import { isJpeg, jpegInfo, scrubGps } from "./jpeg-meta.js?v=11";
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
// Windows에서 쓸 수 없는 문자는 바꾼다 (ZIP을 풀 때 실패하지 않게)
const safeName = s => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "photo";
const outName = name => safeName(name.replace(/\.[^.]+$/, "")) + "_optimized.jpg";
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
// 1~47 사이의 정수만 받는다. 칸에 보이는 값과 실제로 쓰는 값이 항상 같아야 한다.
function target() {
  const v = targetInput.value.trim(), t = Number(v);
  return v !== "" && Number.isInteger(t) && t >= 1 && t <= 47 ? t : null;
}
function showTarget() {
  const t = target();
  $("targetRange").textContent = t ? `${Math.max(0.5, t - TOL)}–${t + TOL}MB로 맞춰요` : "1~47 사이의 정수로 정해 주세요";
  $("targetRange").classList.toggle("bad", !t);
  $("minus").disabled = t !== null && t <= 1;
  $("plus").disabled = t !== null && t >= 47;
  targetInput.style.width = `${String(targetInput.value || "0").length + 0.2}ch`;
  if (items[sel]?.status === "done") renderDone(items[sel]);  // "다시 줄이기" 버튼 갱신
}
// 잘못된 값은 가장 가까운 허용값으로 바로잡는다 (빈칸이면 기본 7)
function normalizeTarget() {
  const v = targetInput.value.trim(), t = Number(v);
  targetInput.value = v === "" || !Number.isFinite(t) ? 7 : Math.min(47, Math.max(1, Math.round(t)));
  showTarget();
  return +targetInput.value;
}
$("minus").onclick = () => { targetInput.value = Math.max(1, normalizeTarget() - 1); showTarget(); };
$("plus").onclick = () => { targetInput.value = Math.min(47, normalizeTarget() + 1); showTarget(); };
targetInput.oninput = showTarget;
targetInput.onblur = normalizeTarget;
targetInput.onkeydown = e => { if (e.key === "Enter") normalizeTarget(); };
showTarget();

// 지금 화면의 설정 (입력칸을 고치지 않고 읽기만). 값이 잘못됐으면 null
function peekOpts() {
  const t = target();
  return t && { target: t, keep_gps: !$("stripGps").checked, sharpen: $("sharpen").checked };
}
$("stripGps").addEventListener("change", showTarget);
$("sharpen").addEventListener("change", showTarget);

// 넣는 순간의 설정을 사진마다 고정한다 (대기 중에 설정을 바꿔도 이미 넣은 사진은 그대로)
function currentOpts() {
  const t = normalizeTarget();
  return {
    min_mb: Math.max(0.5, t - TOL), max_mb: t + TOL, target: t,
    min_q: 85, max_q: 95, max_scale: 0.5,
    sharpen: $("sharpen").checked, keep_gps: !$("stripGps").checked,
  };
}

// 펼침 메뉴(옵션, 모두 저장): 바깥을 누르거나 Esc를 누르면 닫는다
const menus = [$("opts"), $("saveAll")];
document.addEventListener("click", e => { for (const d of menus) if (!d.contains(e.target)) d.open = false; });
addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  for (const d of menus) if (d.open) { d.open = false; d.querySelector("summary").focus(); }
});

// 변환 중이거나 아직 저장하지 않은 결과가 있으면 새로고침·닫기 전에 확인한다 (결과는 메모리에만 있다)
addEventListener("beforeunload", e => {
  if (items.some(i => i.status === "work" || i.status === "wait" || (i.status === "done" && !i.saved))) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------- 파일 받기 ----------
if (!supported) {
  // sw.js(coi-serviceworker)가 첫 방문 때 페이지를 한 번 새로 고친다. 그래도 안 되면 브라우저 문제.
  setTimeout(() => { if (!window.crossOriginIsolated) $("unsupported").hidden = false; }, 3000);
}
// 예전 coi-serviceworker.js가 등록된 기기도 공유 받기가 되는 sw.js로 바꾼다.
// sw.js의 창 쪽 코드는 이미 격리된 페이지에서는 등록을 건너뛰기 때문에 여기서 직접 한다.
const swc = navigator.serviceWorker;
if (swc?.controller && !swc.controller.scriptURL.endsWith("/sw.js")) swc.register("sw.js").catch(e => console.warn(e));

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

// 갤러리의 "공유"로 들어온 사진: sw.js가 Cache Storage에 넣어 둔 파일을 꺼내 바로 시작한다
async function takeShared() {
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(null, "", location.pathname);  // 새로고침해도 다시 넣지 않게
  try {
    const cache = await caches.open("share-target"), files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      files.push(new File([await res.blob()], decodeURIComponent(res.headers.get("x-name") || "shared.jpg"), { type: res.headers.get("content-type") || "" }));
      await cache.delete(req);
    }
    if (files.length) addFiles(files);
  } catch (e) { console.warn("공유받은 사진을 읽지 못했습니다", e); }
}

function addFiles(list) {
  if (!supported) return;
  const files = [...list].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|tiff?)$/i.test(f.name));
  if (!files.length) return;
  const first = items.length, opts = currentOpts();
  follow = true;
  for (const file of files) {
    const it = { file, name: file.name, status: "wait", p: 0, opts };
    items.push(it);
    queue = queue.then(() => run(it));  // 메모리 보호를 위해 한 장씩 순서대로
  }
  const working = items.findIndex(i => i.status === "work");
  sel = working >= 0 ? working : first;
  render();
}

// ---------- 변환 ----------
// app.js?v=N 과 같은 버전의 worker.js를 쓴다 (index.html의 ?v= 참고)
const WORKER_URL = `worker.js?v=${new URL(import.meta.url).searchParams.get("v") ?? ""}`;
// 단계마다 새 워커(= 새 1GB wasm 힙)를 띄우고, 끝나면 버린다. 이유는 worker.js 머리말 참고.
function step(msg, transfer, onMsg) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { type: "module" });
    w.onmessage = ({ data }) => {
      if (data.type === "progress" || data.type === "preview") return onMsg(data);
      w.terminate();
      data.type === "error" ? reject(data) : resolve(data);
    };
    w.onerror = e => { w.terminate(); reject({ error: "변환 엔진을 불러오지 못했어요. 새로고침해 주세요.", detail: e.message }); };
    w.postMessage(msg, transfer);
  });
}

// core.py의 convert와 같은 흐름: 배율마다 축소 → Q 탐색, 상한 안에 들면 멈춘다
async function convert(it, opts) {
  const t0 = performance.now();
  const seconds = () => Math.round((performance.now() - t0) / 1000);
  const data = new Uint8Array(await it.file.arrayBuffer());
  const small = data.length <= opts.max_mb * MB;
  // 이미 상한 안의 JPEG는 다시 압축하지 않는다. 다시 압축하면 해상도만 잃거나 오히려 커진다.
  // 위치 정보 지우기가 켜져 있으면 픽셀은 그대로 두고 GPS만 지운다.
  if (small && isJpeg(data)) {
    const info = jpegInfo(data);
    if (info.w && info.h) {
      const { bytes, removed } = opts.keep_gps ? { bytes: data, removed: false } : scrubGps(data);
      it.src = it.out = { w: info.w, h: info.h };
      return { kept: true, gpsRemoved: removed, found: { q: null, buf: bytes }, seconds: seconds() };
    }
  }
  // JPEG가 아니어도 이미 상한 안이면 해상도를 줄이지 않고 원래 크기부터 시작한다
  const runOpts = small ? { ...opts, max_scale: 1 } : opts;
  const onMsg = m => progress(it, m);
  let scales, shrunk, enc, lean = false;
  for (let i = 0; ; i++) {
    const input = data.slice();  // 넘긴 버퍼는 워커로 옮겨지므로 배율마다 복사
    shrunk = await step({ op: "resize", data: input, scale: scales?.[i], ...runOpts }, [input.buffer], onMsg);
    scales = shrunk.scales;
    it.src = { w: shrunk.srcW, h: shrunk.srcH };
    it.out = { w: shrunk.width, h: shrunk.height };
    it.phase = "prep"; it.p = Math.max(it.p, 46); it.q = null;
    render();
    const last = i === scales.length - 1;
    enc = await step({
      op: "encode", pixels: shrunk.pixels, meta: shrunk.meta, width: shrunk.width, height: shrunk.height,
      bands: shrunk.bands, opts: runOpts, scale: shrunk.scale, last,
    }, [shrunk.pixels.buffer], onMsg);
    lean ||= enc.lean;
    if (enc.found || last) break;
  }
  // 엔진은 EXIF의 GPS만 지운다. XMP에 들어 있는 GPS(라이트룸 등에서 내보낸 사진)도 지운다.
  if (enc.found && !opts.keep_gps) enc.found.buf = scrubGps(enc.found.buf).bytes;
  return { ...enc, lean, seconds: seconds() };
}

// 진행률: 읽고 줄이기 0→45%(시간에 따라 서서히), 화질 찾기는 시도마다 계단식, 완료 100%
function progress(it, m) {
  if (m.type === "preview") { it.preview = blobUrl(m.preview, "image/jpeg"); return render(); }
  if (m.phase === "resize") { it.phase = "resize"; it.retry = m.retry; it.p = Math.max(it.p, m.retry ? 40 : 2); it.q = null; }
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

const isHeic = f => /\.(heic|heif)$/i.test(f.name) || /^image\/hei[cf]/i.test(f.type);
const HEIC_MSG = "HEIC 사진은 아직 열 수 없어요. 카메라 설정에서 '고효율 사진'을 끄고 찍거나 JPEG로 저장해 주세요.";

async function run(it) {
  const opts = it.opts;
  it.status = "work"; it.phase = "resize"; it.p = 1;
  if (follow) sel = items.indexOf(it);
  render();
  try {
    if (isHeic(it.file)) throw { error: HEIC_MSG };
    const r = await convert(it, opts);
    const f = r.found;
    it.result = { q: f.q, size: f.buf.length, over: !!f.over, lean: r.lean, seconds: r.seconds, kept: !!r.kept, gpsRemoved: r.gpsRemoved };
    it.blob = new Blob([f.buf], { type: "image/jpeg" });
    it.url = URL.createObjectURL(it.blob);
    if (r.kept) it.preview = it.url;  // 원본 JPEG는 그대로 화면에 띄울 수 있다
    if (r.ref) { it.ref = blobUrl(r.ref, "image/png"); it.res = blobUrl(r.res, "image/png"); }
    it.status = "done"; it.p = 100; it.fresh = true;
  } catch (e) {
    console.warn(it.name, e.detail || e);
    it.status = "fail";
    it.error = e.error || "이 파일은 열 수 없어요. JPEG·PNG·WebP·TIFF 사진인지 확인해 주세요.";
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
  renderTitle();
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
  if (it.status === "wait") { step = "차례를 기다리는 중"; detail = "앞 사진이 끝나면 바로 시작해요"; }
  else if (it.phase === "resize") {
    step = "사진 읽고 줄이는 중";
    detail = it.retry ? "목표보다 커서 조금 더 작게 줄이는 중" : "고해상도 사진은 30초쯤 걸려요";
  } else if (it.phase === "prep") {
    step = "가장 좋은 화질 찾는 중";
    detail = `${koPixels(it.src.w, it.src.h)} → ${koPixels(it.out.w, it.out.h)} 화소로 줄였어요`;
  } else {
    step = it.lean ? "메모리를 아껴 화질 찾는 중" : "가장 좋은 화질 찾는 중";
    detail = it.q ? `화질 ${it.q.q} · ${it.q.mb}MB, ${it.q.fits ? "목표 안이에요" : "목표보다 커요"}` : `${koPixels(it.out.w, it.out.h)} 화소 · ${it.out.w} × ${it.out.h}`;
  }
  $("workStep").textContent = step;
  $("workDetail").textContent = detail;
  $("workBar").style.width = (it.status === "wait" ? 0 : it.p) + "%";
  const stage = it.status === "wait" ? -1 : it.phase === "resize" ? 0 : 1;  // prep, q는 "화질 찾기"
  [...$("workDots").children].forEach((li, i) => li.className = i < stage ? "ok" : i === stage ? "on" : "");
}

function renderDone(it) {
  const r = it.result, o = it.opts;
  const mb = r.size / MB, inRange = r.kept || (!r.over && mb >= o.min_mb);
  $("okLine").className = "ok" + (inRange ? "" : " warnc");
  $("okLine").innerHTML = (inRange ? CHECK : INFO) + (
    r.kept ? "이미 충분히 작아서 그대로 두었어요"
    : inRange ? `목표 크기(${o.min_mb}–${o.max_mb}MB)에 맞췄어요`
    : r.over ? "목표보다 커요" : "목표보다 작게 나왔어요");
  $("fromMb").textContent = r.kept ? "" : fmtMb(it.file.size) + "MB";
  const pct = Math.round(100 * (1 - r.size / it.file.size));
  $("saved").textContent = r.kept ? (r.gpsRemoved ? "화질은 그대로, 위치 정보만 지웠어요" : "다시 압축할 필요가 없었어요")
    : pct > 0 ? `${pct}% 가벼워졌어요` : pct === 0 ? "용량이 거의 같아요" : `원본보다 ${-pct}% 커졌어요`;
  $("factList").innerHTML = [
    ["해상도", r.kept ? `${koPixels(it.src.w, it.src.h)} 화소 (그대로)` : `${koPixels(it.src.w, it.src.h)} → ${koPixels(it.out.w, it.out.h)} 화소`],
    ["크기", `${it.out.w} × ${it.out.h}`],
    ["화질(JPEG)", r.kept ? "원본 그대로" : r.q],
    ["촬영 위치", o.keep_gps ? "유지" : r.kept && !r.gpsRemoved ? "원래 없음" : "지움"],
    ["걸린 시간", `${r.seconds}초`],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(String(v))}</dd>`).join("");
  const notes = [];
  if (r.over) notes.push("가장 작게 줄여도 목표보다 커요. 목표 용량을 늘려 보세요.");
  else if (!inRange) notes.push("더 키워도 화질이 나아지지 않아 이 크기로 저장했어요.");
  if (r.lean) notes.push("기기 메모리가 부족해 메모리를 아끼는 방식으로 저장했어요.");
  $("note").hidden = !notes.length;
  $("note").textContent = notes.join(" ");

  // 지금 설정이 이 사진을 넣을 때와 다르면 같은 파일을 새 설정으로 다시 줄일 수 있게 한다
  const now = peekOpts(), redo = $("redoBtn");
  let changed = now && (now.target !== o.target || now.keep_gps !== o.keep_gps || now.sharpen !== o.sharpen);
  // 원본을 그대로 둔 사진은 새 상한에도 들어가고 위치 정보 설정이 같으면 다시 해도 결과가 같다
  if (changed && r.kept && it.file.size <= (now.target + TOL) * MB && now.keep_gps === o.keep_gps) changed = false;
  redo.hidden = !changed;
  if (changed) {
    redo.textContent = now.target !== o.target ? `${now.target}MB로 다시 줄이기` : "바뀐 옵션으로 다시 줄이기";
    redo.onclick = () => addFiles([it.file]);
  }

  const save = $("saveBtn");
  save.href = it.url; save.download = outName(it.name);
  save.onclick = () => { it.saved = true; };
  save.textContent = `저장 · ${fmtMb(r.size)}MB`;
  $("tagRes").textContent = `결과 ${fmtMb(r.size)}MB`;

  $("cmp").classList.toggle("noviews", !it.ref);
  $("fullImg").src = it.preview || it.url;
  if (it.ref && $("refImg").dataset.src !== it.ref) {
    $("refImg").src = $("refImg").dataset.src = it.ref;
    $("resImg").src = it.res;
  }
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
// 확대: 두 장을 같은 변환으로 움직인다. s = 이미지 1픽셀이 화면에서 차지하는 크기 (1 = 100%, 실제 픽셀)
const viewer = (() => {
  const cmp = $("cmp"), imgs = [$("refImg"), $("resImg")], slider = $("slider");
  const MAX = 8, STEPS = [1, 2, 4, 8];
  let s = 1, tx = 0, ty = 0, fit = 1, x = 50;
  const box = () => cmp.getBoundingClientRect();
  const size = () => ({ w: imgs[0].naturalWidth || 1, h: imgs[0].naturalHeight || 1 });
  const zoomed = () => s > fit * 1.001;

  function apply() {
    const { width: W, height: H } = box(), { w, h } = size();
    const dw = w * s, dh = h * s;
    tx = dw <= W ? (W - dw) / 2 : Math.min(0, Math.max(W - dw, tx));
    ty = dh <= H ? (H - dh) / 2 : Math.min(0, Math.max(H - dh, ty));
    for (const im of imgs) {
      im.style.width = w + "px"; im.style.height = h + "px";
      im.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    }
    const z = zoomed(), pct = Math.round(s * 100) + "%";
    cmp.classList.toggle("zoomed", z);
    cmp.classList.toggle("pixel", s >= 3);  // 크게 키우면 픽셀을 뭉개지 않고 그대로 보여 준다
    $("zoomLabel").textContent = z ? pct : "맞춤";
    $("zoomLabel").setAttribute("aria-label", z ? `${pct}, 눌러서 화면에 맞추기` : "화면에 맞춤, 눌러서 100%로");
    $("zoomOut").disabled = !z;
    $("zoomIn").disabled = s >= MAX;
  }
  // (px, py) 지점을 화면에 고정한 채 배율을 바꾼다
  function zoomAt(ns, px, py) {
    ns = Math.min(MAX, Math.max(fit, ns));
    tx = px - (px - tx) * ns / s; ty = py - (py - ty) * ns / s; s = ns;
    apply();
  }
  const center = () => { const b = box(); return [b.width / 2, b.height / 2]; };
  function stepZoom(dir) {
    const next = dir > 0 ? (STEPS.find(v => v > s * 1.01) ?? MAX) : ([...STEPS].reverse().find(v => v < s * 0.99) ?? fit);
    zoomAt(next, ...center());
  }
  function reset() {
    const { width: W, height: H } = box(), { w, h } = size();
    fit = Math.max(W / w, H / h);  // 상자를 꽉 채우는 배율
    s = fit; tx = (W - w * s) / 2; ty = (H - h * s) / 2;  // 가운데 맞춤
    apply();
  }
  const oneToOne = () => Math.max(1, fit * 2);
  function setX(v) { x = Math.max(2, Math.min(98, v)); cmp.style.setProperty("--x", x + "%"); slider.value = x; }

  $("zoomIn").onclick = () => stepZoom(1);
  $("zoomOut").onclick = () => stepZoom(-1);
  $("zoomLabel").onclick = () => (zoomed() ? reset() : zoomAt(oneToOne(), ...center()));
  slider.oninput = () => setX(+slider.value);

  // 더블클릭(더블탭): 맞춤 ↔ 100%
  cmp.addEventListener("dblclick", e => {
    if (e.target.closest("button") || cmp.matches(".whole, .noviews")) return;
    const b = box();
    zoomed() ? reset() : zoomAt(oneToOne(), e.clientX - b.left, e.clientY - b.top);
  });
  // Ctrl/⌘ + 휠, 트랙패드 핀치(브라우저가 ctrlKey 휠로 보낸다). 일반 휠은 페이지 스크롤에 둔다.
  cmp.addEventListener("wheel", e => {
    if (!(e.ctrlKey || e.metaKey) || cmp.matches(".whole, .noviews")) return;
    e.preventDefault();
    const b = box();
    zoomAt(s * Math.exp(-e.deltaY * 0.01), e.clientX - b.left, e.clientY - b.top);
  }, { passive: false });

  // 끌기: 경계선 근처면 경계선 이동, 확대 상태면 화면 이동, 맞춤 상태면 경계선 이동. 두 손가락은 확대.
  const pts = new Map();
  let mode = null, last = null, pinch = null;
  cmp.addEventListener("pointerdown", e => {
    if (e.target.closest("button") || cmp.matches(".whole, .noviews")) return;
    try { cmp.setPointerCapture(e.pointerId); } catch {}
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const b = box();
    if (pts.size === 2) {
      const [[x1, y1], [x2, y2]] = [...pts.values()];
      pinch = { d: Math.hypot(x2 - x1, y2 - y1) || 1, s, cx: (x1 + x2) / 2 - b.left, cy: (y1 + y2) / 2 - b.top };
      mode = "pinch";
      return;
    }
    const nearBar = Math.abs(e.clientX - b.left - b.width * x / 100) < 28;
    mode = nearBar || !zoomed() ? "split" : "pan";
    last = [e.clientX, e.clientY];
    if (mode === "split") setX((e.clientX - b.left) / b.width * 100);
    cmp.classList.toggle("panning", mode === "pan");
  });
  cmp.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const b = box();
    if (mode === "pinch" && pts.size === 2) {
      const [[x1, y1], [x2, y2]] = [...pts.values()];
      zoomAt(pinch.s * Math.hypot(x2 - x1, y2 - y1) / pinch.d, pinch.cx, pinch.cy);
    } else if (mode === "split") setX((e.clientX - b.left) / b.width * 100);
    else if (mode === "pan") { tx += e.clientX - last[0]; ty += e.clientY - last[1]; last = [e.clientX, e.clientY]; apply(); }
  });
  const end = e => {
    pts.delete(e.pointerId);
    if (!pts.size) { mode = null; cmp.classList.remove("panning"); }
    else if (mode === "pinch") { mode = "pan"; last = [...pts.values()][0]; }
  };
  cmp.addEventListener("pointerup", end);
  cmp.addEventListener("pointercancel", end);

  // 이미지가 바뀌거나 상자 크기가 바뀌면(화면 전환·회전) 다시 맞춘다. 확대 중이면 배율은 유지한다.
  imgs[0].addEventListener("load", reset);
  const refit = () => {
    if (!cmp.offsetWidth) return;
    const keep = zoomed() ? s : null;
    reset();
    if (keep) zoomAt(keep, ...center());
  };
  new ResizeObserver(refit).observe(cmp);
  addEventListener("resize", refit);  // 화면을 그리지 않는 동안에는 ResizeObserver가 늦을 수 있어 함께 받는다

  return { reset };
})();

$("modeBtn").onclick = () => {
  const whole = $("cmp").classList.toggle("whole");
  $("modeBtn").textContent = whole ? "실제 크기로 비교" : "전체 사진";
  if (!whole) viewer.reset();
};

function badge(it) {
  if (it.result.kept) return "그대로";
  const pct = Math.round(100 * (1 - it.result.size / it.file.size));
  return pct >= 0 ? `−${pct}%` : `+${-pct}%`;
}

function renderStrip() {
  $("stripWrap").hidden = items.length < 2;
  $("strip").innerHTML = items.map((it, i) => {
    const inner = it.status === "done" ? `<img src="${it.preview || it.url}" alt=""><span class="badge">${badge(it)}</span>`
      : it.status === "fail" ? `<span class="badge bad">실패</span>`
      : it.status === "work" ? (it.preview ? `<img src="${it.preview}" alt="">` : "") + `<span class="spin"></span>`
      : `<span class="wait">대기</span>`;
    return `<button class="thumb ${i === sel ? "sel" : ""}" data-i="${i}" role="listitem" aria-label="${esc(it.name)}">${inner}</button>`;
  }).join("") + `<button class="thumb add" aria-label="사진 추가">+</button>`;
  $("strip").querySelectorAll(".thumb[data-i]").forEach(b => b.onclick = () => { sel = +b.dataset.i; follow = false; render(); });
  $("strip").querySelector(".thumb.add").onclick = openPicker;
  const done = items.filter(i => i.status === "done");
  $("saveAll").hidden = done.length < 2;
  if (done.length < 2) $("saveAll").open = false;
  const total = done.reduce((n, i) => n + i.result.size, 0);
  $("saveCount").textContent = `(${done.length}장)`;
  $("saveEachSub").textContent = `JPEG ${done.length}개 · 합계 ${fmtMb(total)}MB`;
  $("saveZipSub").textContent = `photo-optimizer.zip · ${fmtMb(total)}MB`;
}

function renderDock(it) {
  const cta = $("cta"), alt = document.querySelector(".cta.alt");
  alt.hidden = !it;
  cta.disabled = false;
  if (!it) { cta.textContent = "사진 고르기"; cta.onclick = openPicker; }
  else if (it.status === "done") { cta.textContent = `저장 · ${fmtMb(it.result.size)}MB`; cta.onclick = () => $("saveBtn").click(); }
  else if (it.status === "fail") { cta.textContent = "다른 사진 고르기"; cta.onclick = openPicker; }
  else { cta.textContent = it.status === "wait" ? "차례를 기다리는 중" : `줄이는 중 · ${Math.round(it.p)}%`; cta.disabled = true; }
  // 보내기: 이 기기가 파일 공유를 지원할 때만 (카카오톡·메일 등 OS 공유 창)
  const share = $("shareBtn"), file = it?.status === "done" && shareFile(it);
  share.hidden = !file;
  if (file) share.onclick = () => navigator.share({ files: [file] }).then(() => { it.saved = true; }, () => {});
}

function shareFile(it) {
  if (!navigator.canShare) return null;
  it.shareFile ??= new File([it.blob], outName(it.name), { type: "image/jpeg" });
  return navigator.canShare({ files: [it.shareFile] }) ? it.shareFile : null;
}

// 탭 제목에 진행 상황: 다른 탭에서 일하다가도 끝났는지 알 수 있게
function renderTitle() {
  const done = items.filter(i => i.status === "done" || i.status === "fail").length;
  const busy = items.some(i => i.status === "work" || i.status === "wait");
  document.title = busy ? `(${done}/${items.length}) Photo Optimizer`
    : items.length ? `✓ ${items.filter(i => i.status === "done").length}장 완료 · Photo Optimizer` : "Photo Optimizer";
}

// ---------- 모두 저장: 각각 또는 ZIP ----------
function download(href, name) {
  const a = document.createElement("a");
  a.href = href; a.download = name;
  document.body.append(a); a.click(); a.remove();
}
// 한꺼번에 누르면 브라우저가 일부를 막으므로 간격을 두고 차례로 받는다.
// 처음 한 번은 브라우저가 "여러 파일 다운로드"를 허용할지 물을 수 있다.
$("saveEach").onclick = async () => {
  $("saveAll").open = false;
  const done = items.filter(i => i.status === "done");
  done.forEach(i => { i.saved = true; });
  for (const [k, it] of done.entries()) {
    if (k) await new Promise(r => setTimeout(r, 400));
    download(it.url, outName(it.name));
  }
};
// ZIP은 무압축으로 묶는다 (JPEG는 다시 압축해도 줄지 않는다)
$("saveZip").onclick = async () => {
  $("saveAll").open = false;
  const done = items.filter(i => i.status === "done");
  done.forEach(i => { i.saved = true; });
  const zip = await makeZip(done.map(i => ({ name: outName(i.name), blob: i.blob })));
  const url = URL.createObjectURL(zip);
  download(url, "photo-optimizer.zip");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
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
takeShared();
