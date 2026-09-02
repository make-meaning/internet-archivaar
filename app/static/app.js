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
  if (name === "browse") loadRecent();
}

/* --------------------------------------------------------------- browsing */
const state = { view: "search", q: "", type: "collection", sort: "",
  page: 1, total: 0, collectionId: null,
  accountId: null, accountSection: "uploads" };

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#search-input").value.trim();
  if (!raw) { toast("Enter a search term, an @user, or paste an archive.org link"); return; }
  const stype = $$("input[name=stype]").find((r) => r.checked).value;
  if (raw.startsWith("@") || (stype === "account" && isHandle(raw))) {
    resolveAndOpen(raw.startsWith("@") ? raw : "@" + raw, stype !== "account");
    return;
  }
  if (isUrl(raw)) { resolveAndOpen(raw, false); return; }
  if (isBareIdentifier(raw)) { resolveAndOpen(raw, true); return; }
  doSearch(raw);
});

// Paste an archive.org link and it jumps straight there.
$("#search-input").addEventListener("paste", (e) => {
  const t = (e.clipboardData || window.clipboardData).getData("text").trim();
  if (/archive\.org\//i.test(t)) {
    e.preventDefault();
    $("#search-input").value = t;
    resolveAndOpen(t, false);
  }
});

const isUrl = (s) => /archive\.org\//i.test(s) || /^https?:\/\//i.test(s);
const isBareIdentifier = (s) => /^[A-Za-z0-9][\w.-]{2,}$/.test(s) && !s.includes(" ");
const isHandle = (s) => /^@?[A-Za-z0-9][\w.-]*$/.test(s) && !s.includes(" ");

function doSearch(raw) {
  state.q = raw;
  state.type = $$("input[name=stype]").find((r) => r.checked).value;
  if (state.type === "account") state.type = "video";   // free text ≠ a handle
  state.sort = $("#sort-select").value;
  state.page = 1;
  state.view = "search";
  state.collectionId = null;
  state.accountId = null;
  runSearch();
}

async function resolveAndOpen(raw, fallbackToSearch) {
  setResultsLoading();
  $("#crumbs").hidden = true;
  let r;
  try {
    r = await api(`/api/resolve?input=${encodeURIComponent(raw)}`);
  } catch (e) {
    if (fallbackToSearch) return doSearch(raw);
    return showError(e);
  }
  $("#search-input").value = "";
  if (r.kind === "account") {
    openAccount(r.identifier, r);
  } else if (r.kind === "collection") {
    $$("input[name=stype]").forEach((x) => (x.checked = x.value === "collection"));
    openCollection(r.identifier);
  } else {
    openItem(r.identifier);
    toast(`Opened item · ${r.video_files} video file${r.video_files === 1 ? "" : "s"}`);
  }
}
$("#sort-select").addEventListener("change", () => {
  if (state.view === "account") return;   // the user view has its own sort control
  state.sort = $("#sort-select").value;
  state.page = 1;
  state.view === "collection" ? openCollection(state.collectionId, true) : runSearch();
});
$("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page--; rerun(); } });
$("#next-page").addEventListener("click", () => { state.page++; rerun(); });
const rerun = () =>
  state.view === "account" ? renderAccountSection()
    : state.view === "collection" ? openCollection(state.collectionId, true)
      : runSearch();

function setResultsLoading() {
  $("#browse-empty").hidden = true;
  $("#recent").hidden = true;
  $("#results").className = "grid";
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
    if (state.page === 1)
      recordHistory({
        kind: "search", key: `${state.type}|${state.q.toLowerCase()}`,
        label: state.q,
        data: { q: state.q, type: state.type, sort: state.sort },
      });
  } catch (e) { showError(e); }
}

async function openCollection(cid, keepPage) {
  const fromAccount = (state.view === "account" || state.view === "collection")
    ? state.accountId : null;
  if (!fromAccount) state.accountId = null;
  state.view = "collection";
  state.collectionId = cid;
  if (!keepPage) state.page = 1;
  setResultsLoading();
  try {
    const res = await api(`/api/collection/${encodeURIComponent(cid)}?page=${state.page}&sort=${encodeURIComponent(state.sort)}`);
    const title = (res.collection && res.collection.title) || cid;
    $("#crumbs").hidden = false;
    const back = fromAccount
      ? `<a id="back-search">← ${esc(fromAccount)}</a>`
      : `<a id="back-search">← Search</a>`;
    $("#crumbs").innerHTML =
      `${back} &nbsp;/&nbsp; <strong>${esc(title)}</strong> ` +
      `<button class="small" id="dl-collection">⬇ Download entire collection</button>`;
    $("#back-search").onclick = () =>
      fromAccount ? openAccount(fromAccount) : (state.view = "search", runSearch());
    $("#dl-collection").onclick = () =>
      openModal({ kind: "collection", target: cid, title, formats: null });
    state.total = res.total;
    renderResults(res.docs, "video");
    updatePager(res.total);
    recordHistory({ kind: "collection", key: cid, label: title, data: { cid } });
  } catch (e) { showError(e); }
}

/* --------------------------------------------------------------- users */
const ACCOUNT_SECTIONS = [
  { key: "uploads", label: "Uploads", kind: "video" },
  { key: "collections", label: "Collections", kind: "collection" },
  { key: "favorites", label: "Favorites", kind: "video" },
  { key: "reviews", label: "Reviews", kind: "video" },
];
const ACCOUNT_SORTS = [
  ["publicdate:desc", "Newest"],
  ["publicdate:asc", "Oldest"],
  ["downloads:desc", "Most downloaded"],
  ["titleSorter:asc", "Title A–Z"],
];

async function openAccount(handle, prof) {
  handle = handle.startsWith("@") ? handle : "@" + handle;
  const fresh = handle !== state.accountId;
  state.view = "account";
  state.accountId = handle;
  if (fresh) { state.accountSection = "uploads"; state.accountSort = "publicdate:desc"; }
  state.page = 1;
  state.collectionId = null;
  setResultsLoading();
  $("#crumbs").hidden = true;
  try {
    if (!prof) prof = await api(`/api/account/${encodeURIComponent(handle)}`);
    state.accountProfile = prof;
    recordHistory({ kind: "account", key: handle,
      label: prof.title || handle, data: { handle } });
    renderAccountShell(prof);
    await renderAccountSection();
  } catch (e) { showError(e); }
}

function renderAccountShell(prof) {
  const counts = prof.counts || {};
  let tabs = ACCOUNT_SECTIONS.filter((s) => (counts[s.key] || 0) > 0);
  if (!tabs.length) tabs = [ACCOUNT_SECTIONS[0]];   // nothing public — show empty Uploads
  if (!tabs.find((s) => s.key === state.accountSection))
    state.accountSection = tabs[0].key;

  $("#crumbs").hidden = false;
  $("#crumbs").innerHTML =
    `<a id="back-search">← Search</a> &nbsp;/&nbsp; <strong>${esc(prof.title || prof.identifier)}</strong>`;
  $("#back-search").onclick = () => {
    state.view = "search"; state.accountId = null;
    if (state.q) return runSearch();
    $("#crumbs").hidden = true;
    $("#results").innerHTML = ""; $("#results").className = "grid";
    $("#browse-empty").hidden = false;
    loadRecent();
  };

  const meta = [
    prof.identifier,
    prof.member_since ? "member since " + String(prof.member_since).slice(0, 4) : "",
  ].filter(Boolean).map(esc).join(" · ");

  $("#results").className = "";
  $("#results").innerHTML = `
    <div class="detail">
      <div class="detail-head">
        <img src="/api/thumb/${encodeURIComponent(prof.identifier)}" alt="" onerror="this.style.display='none'">
        <div class="info">
          <h2>${esc(prof.title || prof.identifier)}</h2>
          <div class="meta muted">${meta}</div>
          <p>${esc(stripHtml(prof.description || "")).slice(0, 600)}</p>
          ${(counts.uploads || 0) > 0
            ? `<button id="dl-account">⬇ Download all uploads…</button>` : ""}
        </div>
      </div>
      <div class="acct-tabs">
        ${tabs.map((s) => `<button class="acct-tab" data-sec="${s.key}">${s.label}
          <span class="acct-tab-n">${(counts[s.key] || 0).toLocaleString()}</span></button>`).join("")}
      </div>
      <div class="grp-controls">
        <h3 id="acct-count" class="muted"></h3>
        <div class="grp-controls-r">
          <label>Sort
            <select id="acct-sort">
              ${ACCOUNT_SORTS.map(([v, l]) =>
                `<option value="${v}"${v === state.accountSort ? " selected" : ""}>${l}</option>`).join("")}
            </select>
          </label>
        </div>
      </div>
      <div id="acct-grid" class="grid"></div>
      <div id="acct-pager" class="pager" hidden></div>
    </div>`;
  $("#pager").hidden = true;

  if ((counts.uploads || 0) > 0)
    $("#dl-account").onclick = () => openModal({
      kind: "account", target: prof.identifier,
      title: (prof.title || prof.identifier) + " — uploads", formats: null,
    });
  $$("#results .acct-tab").forEach((b) => b.onclick = () => {
    if (b.dataset.sec === state.accountSection) return;
    state.accountSection = b.dataset.sec;
    state.page = 1;
    renderAccountSection();
  });
  $("#acct-sort").onchange = () => {
    state.accountSort = $("#acct-sort").value;
    state.page = 1;
    renderAccountSection();
  };
}

async function renderAccountSection() {
  const grid = $("#acct-grid");
  if (!grid) return openAccount(state.accountId, state.accountProfile);
  const meta = ACCOUNT_SECTIONS.find((s) => s.key === state.accountSection);
  $$("#results .acct-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.sec === state.accountSection));
  grid.innerHTML = '<div class="spinner">Loading…</div>';
  try {
    const res = await api(`/api/account/${encodeURIComponent(state.accountId)}/${state.accountSection}` +
      `?page=${state.page}&sort=${encodeURIComponent(state.accountSort)}`);
    renderResults(res.docs, meta.kind, grid);
    $("#acct-count").textContent =
      `${res.total.toLocaleString()} ${meta.label.toLowerCase()}`;
    const pages = Math.max(1, Math.ceil(res.total / 48));
    const pg = $("#acct-pager");
    pg.hidden = pages <= 1;
    pg.innerHTML =
      `<button id="acct-prev"${state.page <= 1 ? " disabled" : ""}>← Prev</button>` +
      `<span>Page ${state.page} of ${pages}</span>` +
      `<button id="acct-next"${state.page >= pages ? " disabled" : ""}>Next →</button>`;
    $("#acct-prev").onclick = () => { if (state.page > 1) { state.page--; renderAccountSection(); } };
    $("#acct-next").onclick = () => { state.page++; renderAccountSection(); };
    grid.scrollIntoView({ block: "nearest" });
  } catch (e) {
    grid.innerHTML = `<p class="empty">⚠ ${esc(e.message)}</p>`;
  }
}

function renderResults(docs, kind, wrap = $("#results")) {
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
      const play = mkBtn("▶", () =>
        openPlayer({ identifier: d.identifier, title: d.title || d.identifier }));
      play.classList.add("ghost");
      const dl = mkBtn("⬇", () => openItem(d.identifier, true));
      dl.classList.add("ghost");
      actions.append(open, play, dl);
    }
    wrap.append(el);
  }
}

async function openItem(identifier, autoModal) {
  if (String(identifier).startsWith("@")) return openAccount(identifier);
  setResultsLoading();
  try {
    const it = await api(`/api/item/${encodeURIComponent(identifier)}`);
    recordHistory({ kind: "item", key: identifier, label: it.title, data: { identifier } });
    $("#crumbs").hidden = false;
    const inColl = state.view === "collection" && state.collectionId;
    const inAccount = !inColl && state.accountId;
    const hasResults = state.view === "search" && state.q;
    const backLabel = inColl ? "← Collection"
      : inAccount ? `← ${state.accountId}`
        : hasResults ? "← Results" : "← Browse";
    $("#crumbs").innerHTML = `<a id="back-x">${backLabel}</a> &nbsp;/&nbsp; <strong>${esc(it.title)}</strong>`;
    $("#back-x").onclick = () => {
      if (inColl) return openCollection(state.collectionId, true);
      if (inAccount) return openAccount(state.accountId, state.accountProfile);
      if (hasResults) return runSearch();
      $("#crumbs").hidden = true;
      $("#results").innerHTML = "";
      $("#browse-empty").hidden = false;
      loadRecent();
    };

    const CAP = 800;
    const groups = groupFiles(it.files);
    const totalFiles = it.files.length;

    const fmtList = (it.formats || []).map((f) => `
      <div class="fmt-row">
        <span class="fmt-name">${esc(f.format)}</span>
        <span class="fmt-meta">${f.count} file${f.count === 1 ? "" : "s"} · ${fmtBytes(f.size)}${f.source ? " · " + esc(f.source) : ""}</span>
        <button class="small" data-fmt="${esc(f.format)}">⬇ Download all</button>
      </div>`).join("");

    $("#results").className = "";
    $("#results").innerHTML = `
      <div class="detail">
        <div class="detail-head">
          <img src="/api/thumb/${encodeURIComponent(identifier)}" alt="" onerror="this.style.display='none'">
          <div class="info">
            <h2>${esc(it.title)}</h2>
            <div class="meta muted">${[it.creator, it.year].filter(Boolean).map(esc).join(" · ")}</div>
            <p>${esc(stripHtml(it.description || "")).slice(0, 600)}</p>
            <button id="play-item" class="ghost">▶ Play</button>
            <button id="dl-item">⬇ Download this item…</button>
          </div>
        </div>
        ${fmtList ? `<div class="fmt-list"><h3>Download by format</h3>${fmtList}</div>` : ""}
        <div class="grp-section">
          <div class="grp-controls">
            <h3>${groups.length.toLocaleString()} video${groups.length === 1 ? "" : "s"}
              <span class="muted">· ${totalFiles.toLocaleString()} files</span></h3>
            <div class="grp-controls-r">
              <label>Sort
                <select id="grp-sort">
                  <option value="title">Title</option>
                  <option value="size">Total size</option>
                  <option value="formats">Formats</option>
                </select>
              </label>
              <button id="grp-toggle" class="small ghost">Expand all</button>
            </div>
          </div>
          <div id="grp-list" class="grp-list"></div>
        </div>
      </div>`;
    $("#pager").hidden = true;

    let expanded = false;
    const sortGroups = (key) => {
      const g = [...groups];
      if (key === "size") g.sort((a, b) => b.bytes - a.bytes);
      else if (key === "formats") g.sort((a, b) => b.formats.length - a.formats.length
        || a.title.localeCompare(b.title, undefined, { numeric: true }));
      else g.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
      return g;
    };
    const renderGroups = () => {
      const g = sortGroups($("#grp-sort").value);
      const shown = g.slice(0, CAP);
      $("#grp-list").innerHTML = shown.map((grp, i) => `
        <details class="grp"${expanded ? " open" : ""}>
          <summary>
            <span class="grp-title">${esc(grp.title)}</span>
            <span class="grp-meta">${grp.formats.length} format${grp.formats.length === 1 ? "" : "s"} · ${fmtBytes(grp.bytes)}</span>
            <button class="small ghost grp-play" data-grp="${i}" title="Play in browser">▶</button>
            <button class="small grp-dl" data-grp="${i}" title="Download every format of this video">⬇ All</button>
          </summary>
          <table class="grp-files">
            ${grp.files.map((f) => `
              <tr>
                <td>${esc(f.format || (f.kind === "subtitle" ? "Subtitle" : "—"))}</td>
                <td class="muted">${esc(f.source || "")}</td>
                <td class="muted fname">${esc(f.name.split("/").pop())}</td>
                <td class="num">${f.size ? fmtBytes(f.size) : ""}</td>
                <td class="act">${f.kind === "video" ? `<button class="small ghost" data-play="${esc(f.name)}" title="Play in browser">▶</button> ` : ""}<button class="small ghost" data-file="${esc(f.name)}">⬇</button></td>
              </tr>`).join("")}
          </table>
        </details>`).join("") +
        (g.length > CAP
          ? `<p class="muted grp-more">…and ${(g.length - CAP).toLocaleString()} more videos — use “Download by format” or “Download this item…” to grab them all.</p>`
          : "");

      $$("#grp-list .grp-play").forEach((b) => b.onclick = (e) => {
        e.preventDefault();
        const grp = shown[+b.dataset.grp];
        const f = grp.files.find((x) => x.kind === "video");
        openPlayer({ identifier, title: `${it.title} — ${grp.title}`, file: f });
      });
      $$("#grp-list [data-play]").forEach((b) => b.onclick = (e) => {
        e.preventDefault();
        const name = b.dataset.play;
        openPlayer({
          identifier, title: `${it.title} — ${name.split("/").pop()}`,
          file: { name },
        });
      });
      $$("#grp-list .grp-dl").forEach((b) => b.onclick = (e) => {
        e.preventDefault();
        const grp = shown[+b.dataset.grp];
        queueJob({
          kind: "file", target: identifier, title: `${it.title} — ${grp.title}`,
          options: { files: grp.files.map((f) => f.name), subtitles: false },
        });
      });
      $$("#grp-list [data-file]").forEach((b) => b.onclick = (e) => {
        e.preventDefault();
        queueJob({
          kind: "file", target: identifier,
          title: `${it.title} — ${b.dataset.file.split("/").pop()}`,
          options: { files: [b.dataset.file], subtitles: false },
        });
      });
    };
    $("#grp-sort").onchange = renderGroups;
    $("#grp-toggle").onclick = () => {
      expanded = !expanded;
      $("#grp-toggle").textContent = expanded ? "Collapse all" : "Expand all";
      $$("#grp-list .grp").forEach((d) => (d.open = expanded));
    };
    renderGroups();

    $("#play-item").onclick = () =>
      openPlayer({ identifier, title: it.title });
    $("#dl-item").onclick = () =>
      openModal({ kind: "item", target: identifier, title: it.title, formats: it.formats });
    $$("#results [data-fmt]").forEach((b) =>
      b.onclick = () => queueJob({
        kind: "item", target: identifier,
        title: `${it.title} — ${b.dataset.fmt}`,
        options: { formats: [b.dataset.fmt], source: "any", mode: "all", subtitles: false },
      }));

    if (autoModal)
      openModal({ kind: "item", target: identifier, title: it.title, formats: it.formats });
  } catch (e) { showError(e); }
}

/* Group an item's files by the underlying video (derivatives + subtitles fold
   into their source). */
function fileStem(name) {
  return String(name).split("/").pop()
    .replace(/\.(mp4|m4v|mkv|avi|ogv|ogg|mov|webm|mpe?g|m2v|mj2|flv|wmv|asf|ts|3gp|divx|rm|vob|srt|vtt|sub|ass|ssa|scc)$/i, "")
    .replace(/\.(autogenerated|auto|asr|en|eng|und)$/i, "")
    .replace(/[._-](\d{1,4}kb|hi-?res|hd|sd|edit|ia|web|small|large|512kb|64kb)$/i, "")
    .trim();
}

function groupFiles(files) {
  const map = new Map();
  for (const f of files) {
    const key = fileStem(f.original || f.name) || (f.name || "file");
    let g = map.get(key);
    if (!g) { g = { title: key, files: [], formats: [], bytes: 0 }; map.set(key, g); }
    g.files.push(f);
    g.bytes += f.size || 0;
    if (f.kind === "video" && f.format && !g.formats.includes(f.format))
      g.formats.push(f.format);
  }
  for (const g of map.values()) {
    g.files.sort((a, b) =>
      (a.kind === "video" ? 0 : 1) - (b.kind === "video" ? 0 : 1) ||
      (b.size || 0) - (a.size || 0));
  }
  return [...map.values()].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { numeric: true }));
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
const isBulkKind = (k) => k === "collection" || k === "account";
function openModal(ctx) {
  modalCtx = ctx;
  $("#modal-title").textContent = "Download options";
  $("#modal-sub").textContent =
    ({ collection: "Entire collection: ", account: "All uploads by: " }[ctx.kind]
      || "Item: ") + ctx.title;
  $("#opt-maxitems-row").hidden = !isBulkKind(ctx.kind);
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
    $("#opt-formats-row").hidden = !isBulkKind(ctx.kind);
    if (isBulkKind(ctx.kind)) {
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
  if (isBulkKind(modalCtx.kind))
    options.max_items = parseInt($("#opt-maxitems").value || "0", 10);
  $("#modal").hidden = true;
  queueJob({ kind: modalCtx.kind, target: modalCtx.target, title: modalCtx.title, options });
};

/* --------------------------------------------------------------- player */
function openPlayer({ identifier, title, file }) {
  $("#player-title").textContent = title || identifier;
  // archive.org's own embed player — handles every format and multi-file
  // items via its built-in playlist. Optionally deep-link to one file.
  let src = `https://archive.org/embed/${encodeURIComponent(identifier)}`;
  if (file && file.name) {
    src += "/" + String(file.name).split("/").map(encodeURIComponent).join("/");
  }
  $("#player-media").innerHTML =
    `<iframe src="${esc(src)}" allow="fullscreen; autoplay; encrypted-media" allowfullscreen></iframe>`;
  $("#player").hidden = false;
}
function closePlayer() {
  $("#player").hidden = true;
  $("#player-media").innerHTML = "";   // stop playback / free the connection
}
$("#player-close").onclick = closePlayer;
$("#player").onclick = (e) => { if (e.target.id === "player") closePlayer(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#player").hidden) closePlayer();
});

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

/* --------------------------------------------------------------- history */
async function recordHistory(entry) {
  try {
    await api("/api/history", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch (e) { /* history is best-effort */ }
  loadRecent();
}

async function loadRecent() {
  const box = $("#recent");
  // only meaningful on the browse landing view
  if (state.view !== "search" || state.q || state.collectionId) { box.hidden = true; return; }
  let items = [];
  try { items = (await api("/api/history?limit=30")).history; } catch (e) { return; }
  if (!items.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = `<div class="recent-head">Recent</div><div class="recent-list"></div>`;
  const list = $(".recent-list", box);
  const icon = { search: "🔍", collection: "📁", item: "🎬", account: "👤" };
  for (const it of items) {
    const chip = mkBtn("", null, "recent-chip");
    chip.innerHTML = `<span class="ri">${icon[it.kind] || "·"}</span><span>${esc(it.label)}</span>`;
    chip.title = it.kind === "search" ? `Search: ${it.label}` : it.label;
    chip.onclick = () => replayHistory(it);
    list.append(chip);
  }
  box.hidden = false;
}

function replayHistory(it) {
  const d = it.data || {};
  if (it.kind === "search") {
    const q = d.q || it.label;
    $("#search-input").value = q;
    $$("input[name=stype]").forEach((x) => (x.checked = x.value === (d.type || "collection")));
    if (d.sort !== undefined) $("#sort-select").value = d.sort;
    doSearch(q);
  } else if (it.kind === "collection") {
    $$("input[name=stype]").forEach((x) => (x.checked = x.value === "collection"));
    openCollection(d.cid || it.key);
  } else if (it.kind === "account") {
    $$("input[name=stype]").forEach((x) => (x.checked = x.value === "account"));
    openAccount(d.handle || it.key);
  } else {
    openItem(d.identifier || it.key);
  }
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
    const n = s.history_count || 0;
    $("#set-history").textContent = n
      ? `${n.toLocaleString()} entr${n === 1 ? "y" : "ies"} stored`
      : "Nothing stored yet";
    $("#clear-history").disabled = !n;
  } catch (e) { toast(e.message, true); }
}

$("#clear-history").onclick = async () => {
  if (!confirm("Clear all search and browsing history?")) return;
  try {
    await api("/api/history", { method: "DELETE" });
    toast("History cleared");
    loadSettings();
    loadRecent();
  } catch (e) { toast(e.message, true); }
};
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
loadRecent();
