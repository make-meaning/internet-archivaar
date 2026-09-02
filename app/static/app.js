"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
};

const fmtBytes = (n) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + u[i];
};
const toast = (msg, isErr) => {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
};

/* ------------------------------------------------------------------ tabs */
$$("nav button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  if (name === "queue") refreshJobs();
  if (name === "settings") loadSettings();
}

/* --------------------------------------------------------------- browsing */
const state = { view: "search", q: "", type: "collection", sort: "",
  page: 1, total: 0, collectionId: null };

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#search-input").value.trim();
  if (looksLikeIdentifier(raw)) { resolveAndOpen(raw); return; }
  state.q = raw;
  state.type = $$("input[name=stype]").find((r) => r.checked).value;
  state.sort = $("#sort-select").value;
  state.page = 1;
  state.view = "search";
  state.collectionId = null;
  runSearch();
});

// Paste an archive.org link and it jumps straight there.
$("#search-input").addEventListener("paste", (e) => {
  const t = (e.clipboardData || window.clipboardData).getData("text").trim();
  if (/archive\.org\//i.test(t)) {
    e.preventDefault();
    $("#search-input").value = t;
    resolveAndOpen(t);
  }
});

const looksLikeIdentifier = (s) => /archive\.org\//i.test(s) || /^https?:\/\//i.test(s);

async function resolveAndOpen(raw) {
  setResultsLoading();
  $("#crumbs").hidden = true;
  try {
    const r = await api(`/api/resolve?input=${encodeURIComponent(raw)}`);
    $("#search-input").value = "";
    if (r.kind === "collection") {
      $$("input[name=stype]").forEach((x) => (x.checked = x.value === "collection"));
      openCollection(r.identifier);
    } else {
      openItem(r.identifier);
      toast(`Opened item · ${r.video_files} video file${r.video_files === 1 ? "" : "s"}`);
    }
  } catch (e) { showError(e); }
}
$("#sort-select").addEventListener("change", () => {
  state.sort = $("#sort-select").value;
  state.page = 1;
  state.view === "collection" ? openCollection(state.collectionId, true) : runSearch();
});
$("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page--; rerun(); } });
$("#next-page").addEventListener("click", () => { state.page++; rerun(); });
const rerun = () => (state.view === "collection" ? openCollection(state.collectionId, true) : runSearch());

function setResultsLoading() {
  $("#browse-empty").hidden = true;
  $("#results").innerHTML = '<div class="spinner">Loading…</div>';
  $("#pager").hidden = true;
}

async function runSearch() {
  if (!state.q) { toast("Enter a search term"); return; }
  setResultsLoading();
  $("#crumbs").hidden = true;
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(state.q)}&type=${state.type}&page=${state.page}&sort=${encodeURIComponent(state.sort)}`);
    state.total = res.total;
    renderResults(res.docs, state.type === "collection" ? "collection" : "video");
    updatePager(res.total);
  } catch (e) { showError(e); }
}

async function openCollection(cid, keepPage) {
  state.view = "collection";
  state.collectionId = cid;
  if (!keepPage) state.page = 1;
  setResultsLoading();
  try {
    const res = await api(`/api/collection/${encodeURIComponent(cid)}?page=${state.page}&sort=${encodeURIComponent(state.sort)}`);
    const title = (res.collection && res.collection.title) || cid;
    $("#crumbs").hidden = false;
    $("#crumbs").innerHTML =
      `<a id="back-search">← Search</a> &nbsp;/&nbsp; <strong>${esc(title)}</strong> ` +
      `<button class="small" id="dl-collection">⬇ Download entire collection</button>`;
    $("#back-search").onclick = () => { state.view = "search"; runSearch(); };
    $("#dl-collection").onclick = () =>
      openModal({ kind: "collection", target: cid, title, formats: null });
    state.total = res.total;
    renderResults(res.docs, "video");
    updatePager(res.total);
  } catch (e) { showError(e); }
}

function renderResults(docs, kind) {
  const wrap = $("#results");
  if (!docs.length) {
    wrap.innerHTML = '<p class="empty">No results.</p>';
    return;
  }
  wrap.innerHTML = "";
  for (const d of docs) {
    const el = document.createElement("div");
    el.className = "card";
    const dls = d.downloads ? `${Number(d.downloads).toLocaleString()} downloads` : "";
    const yr = d.year || (d.publicdate || "").slice(0, 4) || "";
    el.innerHTML = `
      <div class="thumb" style="background-image:url('/api/thumb/${encodeURIComponent(d.identifier)}')"></div>
      <div class="body">
        <span class="tag">${kind === "collection" ? "Collection" : "Video"}</span>
        <div class="title">${esc(d.title || d.identifier)}</div>
        <div class="meta">${[yr, dls].filter(Boolean).map(esc).join(" · ")}</div>
        <div class="actions"></div>
      </div>`;
    const actions = $(".actions", el);
    if (kind === "collection") {
      const open = mkBtn("Open", () => openCollection(d.identifier));
      const dl = mkBtn("⬇ All", () =>
        openModal({ kind: "collection", target: d.identifier, title: d.title, formats: null }));
      dl.classList.add("ghost");
      actions.append(open, dl);
    } else {
      const open = mkBtn("Open", () => openItem(d.identifier));
      const dl = mkBtn("⬇", () => openItem(d.identifier, true));
      dl.classList.add("ghost");
      actions.append(open, dl);
    }
    wrap.append(el);
  }
}

async function openItem(identifier, autoModal) {
  setResultsLoading();
  try {
    const it = await api(`/api/item/${encodeURIComponent(identifier)}`);
    $("#crumbs").hidden = false;
    const inColl = state.view === "collection" && state.collectionId;
    const hasResults = state.view === "search" && state.q;
    const backLabel = inColl ? "← Collection" : hasResults ? "← Results" : "← Browse";
    $("#crumbs").innerHTML = `<a id="back-x">${backLabel}</a> &nbsp;/&nbsp; <strong>${esc(it.title)}</strong>`;
    $("#back-x").onclick = () => {
      if (inColl) return openCollection(state.collectionId, true);
      if (hasResults) return runSearch();
      $("#crumbs").hidden = true;
      $("#results").innerHTML = "";
      $("#browse-empty").hidden = false;
    };

    const CAP = 400;
    const files = [...it.files].sort((a, b) =>
      (a.kind === "video" ? 0 : 1) - (b.kind === "video" ? 0 : 1));
    const shown = files.slice(0, CAP);
    const rows = shown.map((f) => `
      <tr>
        <td>${esc(f.name)}</td>
        <td>${esc(f.format || "")}</td>
        <td>${esc(f.source || "")}</td>
        <td class="num">${f.size ? fmtBytes(f.size) : ""}</td>
        <td><button class="small ghost" data-file="${esc(f.name)}">⬇</button></td>
      </tr>`).join("") +
      (files.length > CAP
        ? `<tr><td colspan="5" class="muted">…and ${files.length - CAP} more — use “Download this item…” to grab them all.</td></tr>`
        : "");

    $("#results").innerHTML = `
      <div class="detail">
        <div class="detail-head">
          <img src="/api/thumb/${encodeURIComponent(identifier)}" alt="" onerror="this.style.display='none'">
          <div class="info">
            <h2>${esc(it.title)}</h2>
            <div class="meta muted">${[it.creator, it.year].filter(Boolean).map(esc).join(" · ")}</div>
            <p>${esc(stripHtml(it.description || "")).slice(0, 600)}</p>
            <button id="dl-item">⬇ Download this item…</button>
          </div>
        </div>
        <table class="file-table">
          <thead><tr><th>File</th><th>Format</th><th>Source</th><th class="num">Size</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    $("#pager").hidden = true;

    $("#dl-item").onclick = () =>
      openModal({ kind: "item", target: identifier, title: it.title, formats: it.formats });
    $$("#results [data-file]").forEach((b) =>
      b.onclick = () => queueJob({
        kind: "file", target: identifier, title: `${it.title} — ${b.dataset.file}`,
        options: { files: [b.dataset.file], subtitles: false },
      }));

    if (autoModal)
      openModal({ kind: "item", target: identifier, title: it.title, formats: it.formats });
  } catch (e) { showError(e); }
}

function updatePager(total) {
  const perPage = 48;
  const pages = Math.max(1, Math.ceil(total / perPage));
  $("#pager").hidden = pages <= 1;
  $("#page-info").textContent = `Page ${state.page} of ${pages} · ${total.toLocaleString()} results`;
  $("#prev-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pages;
}

function showError(e) {
  $("#results").innerHTML = `<p class="empty">⚠ ${esc(e.message)}</p>`;
  toast(e.message, true);
}

/* --------------------------------------------------------------- modal */
let modalCtx = null;
function openModal(ctx) {
  modalCtx = ctx;
  $("#modal-title").textContent = "Download options";
  $("#modal-sub").textContent =
    (ctx.kind === "collection" ? "Entire collection: " : "Item: ") + ctx.title;
  $("#opt-maxitems-row").hidden = ctx.kind !== "collection";
  $("#opt-subfolder").value = "";
  $("#opt-maxitems").value = 0;
  $("#opt-subs").checked = true;
  $("#opt-thumbs").checked = false;
  $$('input[name=mode]').forEach((r) => (r.checked = r.value === "all"));
  $$('input[name=source]').forEach((r) => (r.checked = r.value === "any"));

  const box = $("#opt-formats");
  box.innerHTML = "";
  if (ctx.formats && ctx.formats.length) {
    $("#opt-formats-row").hidden = false;
    for (const f of ctx.formats) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = `${f.format} (${f.count}, ${fmtBytes(f.size)})`;
      c.dataset.format = f.format;
      c.onclick = () => c.classList.toggle("on");
      box.append(c);
    }
    const hint = document.createElement("small");
    hint.className = "muted";
    hint.textContent = "none selected = all video formats";
    box.append(hint);
  } else {
    $("#opt-formats-row").hidden = ctx.kind !== "collection";
    if (ctx.kind === "collection") {
      box.innerHTML = "";
      ["h.264", "MPEG4", "512Kb MPEG4", "Ogg Video", "Matroska", "QuickTime"]
        .forEach((name) => {
          const c = document.createElement("span");
          c.className = "chip";
          c.textContent = name;
          c.dataset.format = name;
          c.onclick = () => c.classList.toggle("on");
          box.append(c);
        });
      const hint = document.createElement("small");
      hint.className = "muted";
      hint.textContent = "none selected = all video formats";
      box.append(hint);
    }
  }
  $("#modal").hidden = false;
}
$("#modal-cancel").onclick = () => ($("#modal").hidden = true);
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").hidden = true; };
$("#modal-go").onclick = () => {
  const formats = $$("#opt-formats .chip.on").map((c) => c.dataset.format);
  const options = {
    formats,
    mode: $$('input[name=mode]').find((r) => r.checked).value,
    source: $$('input[name=source]').find((r) => r.checked).value,
    subtitles: $("#opt-subs").checked,
    thumbnails: $("#opt-thumbs").checked,
  };
  const sub = $("#opt-subfolder").value.trim();
  if (sub) options.subfolder = sub;
  if (modalCtx.kind === "collection")
    options.max_items = parseInt($("#opt-maxitems").value || "0", 10);
  $("#modal").hidden = true;
  queueJob({ kind: modalCtx.kind, target: modalCtx.target, title: modalCtx.title, options });
};

async function queueJob(body) {
  try {
    await api("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast("Added to queue");
    showTab("queue");
  } catch (e) { toast(e.message, true); }
}

/* --------------------------------------------------------------- queue */
const openJobs = new Set();
let jobsTimer = null;

async function refreshJobs() {
  try {
    const { jobs } = await api("/api/jobs");
    renderJobs(jobs);
  } catch (e) { /* transient */ }
}

function renderJobs(jobs) {
  const active = jobs.filter((j) => ["running", "resolving", "queued"].includes(j.status)).length;
  const badge = $("#queue-badge");
  badge.hidden = active === 0;
  badge.textContent = active;

  $("#queue-empty").hidden = jobs.length > 0;
  const wrap = $("#jobs");
  wrap.innerHTML = "";
  for (const j of jobs) {
    const pct = j.bytes_total ? Math.min(100, (j.bytes_done / j.bytes_total) * 100)
      : (j.files ? (j.files_done / j.files) * 100 : 0);
    const el = document.createElement("div");
    el.className = "job";
    el.innerHTML = `
      <div class="job-top">
        <div>
          <div class="job-title">${esc(j.title || j.target)}</div>
          <div class="job-sub">${j.kind} · ${esc(j.target)}</div>
        </div>
        <span class="job-status ${j.status}">${j.status}</span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="job-meta">
        <span>${j.files_done}/${j.files} files${j.files_errored ? ` · ${j.files_errored} failed` : ""}</span>
        <span>${fmtBytes(j.bytes_done)} / ${fmtBytes(j.bytes_total)}</span>
      </div>
      ${j.error ? `<div class="job-sub" style="color:var(--err)">${esc(j.error)}</div>` : ""}
      <div class="job-actions"></div>
      <div class="job-files" hidden></div>`;
    const acts = $(".job-actions", el);
    const canPause = ["running", "queued", "resolving"].includes(j.status);
    if (canPause) acts.append(mkBtn("Pause", () => jobAction(j.id, "pause"), "small ghost"));
    if (j.status === "paused") acts.append(mkBtn("Resume", () => jobAction(j.id, "resume"), "small"));
    if (["error", "cancelled", "paused"].includes(j.status))
      acts.append(mkBtn("Retry", () => jobAction(j.id, "retry"), "small"));
    if (canPause || j.status === "paused")
      acts.append(mkBtn("Cancel", () => jobAction(j.id, "cancel"), "small ghost"));
    acts.append(mkBtn("Remove", () => removeJob(j.id), "small ghost"));
    const toggle = mkBtn(openJobs.has(j.id) ? "Hide files" : "Files", () => {
      openJobs.has(j.id) ? openJobs.delete(j.id) : openJobs.add(j.id);
      refreshJobs();
    }, "small ghost");
    acts.append(toggle);

    if (openJobs.has(j.id)) {
      const fbox = $(".job-files", el);
      fbox.hidden = false;
      fbox.innerHTML = '<div class="muted">loading…</div>';
      api(`/api/jobs/${j.id}`).then((d) => {
        fbox.innerHTML = d.tasks.map((t) => `
          <div>
            <span class="st-${t.status}">${esc(t.identifier)}/${esc(t.file_name.split("/").pop())}</span>
            <span>${t.status}${t.size ? " · " + fmtBytes(t.bytes_done) + "/" + fmtBytes(t.size) : ""}</span>
          </div>`).join("") || '<div class="muted">no files</div>';
      });
    }
    wrap.append(el);
  }
}

async function jobAction(id, action) {
  try { await api(`/api/jobs/${id}/${action}`, { method: "POST" }); refreshJobs(); }
  catch (e) { toast(e.message, true); }
}
async function removeJob(id) {
  if (!confirm("Remove this job from the list? Downloaded files are kept.")) return;
  try { await api(`/api/jobs/${id}`, { method: "DELETE" }); refreshJobs(); }
  catch (e) { toast(e.message, true); }
}

/* --------------------------------------------------------------- settings */
async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("#set-concurrency").value = s.concurrency;
    $("#set-dir").textContent = s.download_dir;
    $("#set-cookies").placeholder = s.archive_cookies_set
      ? "•••••• (saved — paste again to replace)" : "logged-in-user=...; logged-in-sig=...";
    $("#set-disk").textContent =
      `${fmtBytes(s.disk_free)} free of ${fmtBytes(s.disk_total)} (${fmtBytes(s.disk_used)} used)`;
    $("#disk-info").textContent = `${fmtBytes(s.disk_free)} free`;
  } catch (e) { toast(e.message, true); }
}
$("#save-settings").onclick = async () => {
  const body = { concurrency: parseInt($("#set-concurrency").value, 10) };
  const ck = $("#set-cookies").value.trim();
  if (ck) body.archive_cookies = ck;
  try {
    await api("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("#set-cookies").value = "";
    const badge = $("#settings-saved");
    badge.hidden = false;
    setTimeout(() => (badge.hidden = true), 1800);
    loadSettings();
  } catch (e) { toast(e.message, true); }
};

/* --------------------------------------------------------------- helpers */
function mkBtn(label, onClick, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = cls || "";
  b.onclick = onClick;
  return b;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stripHtml = (s) => { const d = document.createElement("div"); d.innerHTML = s; return d.textContent || ""; };

/* --------------------------------------------------------------- boot */
jobsTimer = setInterval(() => {
  if ($("#tab-queue").classList.contains("active")) refreshJobs();
  else refreshJobs(); // keep badge fresh
}, 2000);
refreshJobs();
