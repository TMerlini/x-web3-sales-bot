const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const appView = $("app-view");

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showLogin() {
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
}

function showApp() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  loadCollections();
  loadSettings();
  startConsolePolling();
}

// --- Auth ---

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("login-error");
  errorEl.classList.add("hidden");
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("login-password").value }),
    });
    $("login-password").value = "";
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
});

$("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// --- Dry run / live mode toggle ---

let currentDryRun = true;

function renderMode() {
  const pill = $("mode-toggle");
  pill.classList.toggle("mode-dry", currentDryRun);
  pill.classList.toggle("mode-live", !currentDryRun);
  $("mode-label").textContent = currentDryRun ? "Dry run" : "Live";
  pill.title = currentDryRun
    ? "Dry run: tweets are only logged to the console. Click to go live."
    : "Live: tweets are posted to X. Click to switch to dry run.";
}

$("mode-toggle").addEventListener("click", async () => {
  const goingLive = currentDryRun;
  if (
    goingLive &&
    !confirm("Go LIVE? Sales will be posted to X for real from now on.")
  ) {
    return;
  }
  try {
    const { dryRun } = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ dryRun: !currentDryRun }),
    });
    currentDryRun = dryRun;
    renderMode();
  } catch (err) {
    alert(err.message);
  }
});

// --- Collections ---

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function makePill(label, active, clickable, onClick) {
  const pill = document.createElement("span");
  pill.className = `track-pill ${active ? "on" : "off"}${clickable ? " clickable" : ""}`;
  const dot = document.createElement("span");
  dot.className = "track-pill-dot";
  pill.appendChild(dot);
  pill.appendChild(document.createTextNode(label));
  if (clickable && onClick) {
    pill.title = active
      ? `${label} tracked. Click to disable.`
      : `${label} ignored. Click to enable.`;
    pill.addEventListener("click", onClick);
  }
  return pill;
}

function renderCollections(collections) {
  const table = $("collections-table");
  const empty = $("empty-state");
  const body = $("collections-body");
  body.innerHTML = "";

  if (collections.length === 0) {
    table.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  table.classList.remove("hidden");
  empty.classList.add("hidden");

  for (const col of collections) {
    const tr = document.createElement("tr");

    // Status
    const statusTd = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge ${col.paused ? "status-paused" : "status-active"}`;
    badge.textContent = col.paused ? "Paused" : "Active";
    statusTd.appendChild(badge);

    // Name
    const nameTd = document.createElement("td");
    nameTd.textContent = col.name;

    // Contract
    const contractTd = document.createElement("td");
    contractTd.className = "contract";
    const link = document.createElement("a");
    link.href = `https://etherscan.io/address/${col.contract_address}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = shortAddress(col.contract_address);
    link.title = col.contract_address;
    contractTd.appendChild(link);

    // Min price
    const priceTd = document.createElement("td");
    const priceInput = document.createElement("input");
    priceInput.type = "number";
    priceInput.min = "0";
    priceInput.step = "any";
    priceInput.className = "min-price-input";
    priceInput.value = col.min_price_eth || 0;
    priceInput.title = "Only tweet sales at or above this price (0 = all)";
    priceInput.addEventListener("change", async () => {
      const value = Number(priceInput.value);
      if (!Number.isFinite(value) || value < 0) {
        priceInput.value = col.min_price_eth || 0;
        return;
      }
      try {
        await api(`/api/collections/${col.id}`, {
          method: "PATCH",
          body: JSON.stringify({ minPriceEth: value }),
        });
      } catch (err) {
        alert(err.message);
        priceInput.value = col.min_price_eth || 0;
      }
    });
    priceTd.appendChild(priceInput);

    // Tracking pills
    const trackingTd = document.createElement("td");
    const pills = document.createElement("div");
    pills.className = "tracking-pills";

    const salesPill = makePill("Sales", !col.paused, false, null);
    const mintsPill = makePill("Mints", !!col.track_mints, true, async () => {
      try {
        await api(`/api/collections/${col.id}`, {
          method: "PATCH",
          body: JSON.stringify({ trackMints: !col.track_mints }),
        });
        loadCollections();
      } catch (err) {
        alert(err.message);
      }
    });

    pills.append(salesPill, mintsPill);
    trackingTd.appendChild(pills);

    // Phrases
    const phrasesTd = document.createElement("td");
    let phraseCount = 0;
    try {
      const parsed = JSON.parse(col.phrases || "[]");
      if (Array.isArray(parsed)) phraseCount = parsed.length;
    } catch { /* ignore */ }
    const phrasesBtn = document.createElement("button");
    phrasesBtn.className = "btn btn-sm";
    phrasesBtn.textContent = phraseCount > 0 ? `${phraseCount} phrases` : "Add phrases";
    phrasesBtn.title = "Custom phrases rotated on each sale tweet";
    phrasesBtn.addEventListener("click", () => openPhrasesModal(col));
    phrasesTd.appendChild(phrasesBtn);

    // Actions
    const actionsTd = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const pauseBtn = document.createElement("button");
    pauseBtn.className = "btn btn-sm";
    pauseBtn.textContent = col.paused ? "Resume" : "Pause";
    pauseBtn.addEventListener("click", async () => {
      try {
        await api(`/api/collections/${col.id}`, {
          method: "PATCH",
          body: JSON.stringify({ paused: !col.paused }),
        });
        loadCollections();
      } catch (err) {
        alert(err.message);
      }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-sm btn-danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Stop tracking "${col.name}"?`)) return;
      try {
        await api(`/api/collections/${col.id}`, { method: "DELETE" });
        loadCollections();
      } catch (err) {
        alert(err.message);
      }
    });

    actions.append(pauseBtn, deleteBtn);
    actionsTd.appendChild(actions);

    tr.append(statusTd, nameTd, contractTd, priceTd, trackingTd, phrasesTd, actionsTd);
    body.appendChild(tr);
  }
}

// --- Phrases modal ---

let phrasesCollectionId = null;

function openPhrasesModal(col) {
  phrasesCollectionId = col.id;
  $("phrases-title").textContent = `Phrases — ${col.name}`;
  let phrases = [];
  try {
    const parsed = JSON.parse(col.phrases || "[]");
    if (Array.isArray(parsed)) phrases = parsed;
  } catch { /* ignore */ }
  $("phrases-text").value = phrases.join("\n");
  $("phrases-error").classList.add("hidden");
  $("phrases-modal").classList.remove("hidden");
  $("phrases-text").focus();
}

function closePhrasesModal() {
  $("phrases-modal").classList.add("hidden");
  phrasesCollectionId = null;
}

$("phrases-cancel").addEventListener("click", closePhrasesModal);
$("phrases-modal").addEventListener("click", (e) => {
  if (e.target === $("phrases-modal")) closePhrasesModal();
});

$("phrases-save").addEventListener("click", async () => {
  if (phrasesCollectionId === null) return;
  const phrases = $("phrases-text")
    .value.split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  try {
    await api(`/api/collections/${phrasesCollectionId}`, {
      method: "PATCH",
      body: JSON.stringify({ phrases }),
    });
    closePhrasesModal();
    loadCollections();
  } catch (err) {
    const errorEl = $("phrases-error");
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
});

async function loadCollections() {
  try {
    renderCollections(await api("/api/collections"));
  } catch {
    /* 401 already handled */
  }
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("add-error");
  errorEl.classList.add("hidden");
  try {
    await api("/api/collections", {
      method: "POST",
      body: JSON.stringify({
        name: $("add-name").value.trim(),
        contractAddress: $("add-address").value.trim(),
        minPriceEth: Number($("add-min-price").value) || 0,
      }),
    });
    $("add-form").reset();
    loadCollections();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
});

// --- Bot settings (marketplaces + poll interval) ---

const MARKET_LABELS = {
  opensea: "OpenSea",
  blur: "Blur",
  looksrare: "LooksRare",
  x2y2: "X2Y2",
  "0xprotocol": "0x Protocol",
};

let currentMarketplaces = [];

function renderMarketplaces(all, selected) {
  const container = $("marketplaces-options");
  container.innerHTML = "";
  for (const mkt of all) {
    const label = document.createElement("label");
    label.className = "mkt-option";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = mkt;
    cb.checked = selected.includes(mkt);
    cb.addEventListener("change", saveMarketplaces);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + (MARKET_LABELS[mkt] || mkt)));
    container.appendChild(label);
  }
}

function selectedMarketplaces() {
  return [...$("marketplaces-options").querySelectorAll("input:checked")].map((c) => c.value);
}

async function saveMarketplaces() {
  const status = $("settings-status");
  const chosen = selectedMarketplaces();
  if (chosen.length === 0) {
    status.textContent = "Pick at least one marketplace.";
    renderMarketplaces(Object.keys(MARKET_LABELS), currentMarketplaces);
    return;
  }
  try {
    const s = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ marketplaces: chosen }),
    });
    currentMarketplaces = s.marketplaces;
    status.textContent =
      "Saved — tracking " + s.marketplaces.map((m) => MARKET_LABELS[m] || m).join(", ") + ".";
  } catch (err) {
    status.textContent = err.message;
    renderMarketplaces(Object.keys(MARKET_LABELS), currentMarketplaces);
  }
}

$("interval-save").addEventListener("click", async () => {
  const status = $("settings-status");
  const seconds = Number($("interval-input").value);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86400) {
    status.textContent = "Interval must be between 60 and 86400 seconds.";
    return;
  }
  try {
    const s = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ pollIntervalSeconds: seconds }),
    });
    $("interval-input").value = s.pollIntervalSeconds;
    status.textContent =
      "Saved — polling every " + s.pollIntervalSeconds + "s (applies next cycle).";
  } catch (err) {
    status.textContent = err.message;
  }
});

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    currentDryRun = s.dryRun;
    renderMode();
    currentMarketplaces = s.marketplaces || [];
    renderMarketplaces(s.allMarketplaces || Object.keys(MARKET_LABELS), currentMarketplaces);
    $("interval-input").value = s.pollIntervalSeconds || 600;
  } catch {
    /* 401 already handled */
  }
}

// --- Console (live health + retry queue) ---

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function fmtAgo(iso) {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function setChip(id, health) {
  const chip = $(id);
  chip.classList.remove("ok", "down", "warn", "unknown");
  chip.classList.add(health || "unknown");
}

function renderConsole(d) {
  const { moralis, x, queue = [], queueCount = 0, events = [], lastPollAt, postedCount = 0, lastPostedAt } = d;

  // Moralis
  setChip("status-moralis", moralis.health);
  $("moralis-detail").textContent =
    moralis.health === "ok"
      ? `OK · checked ${fmtAgo(moralis.lastCheckAt)}`
      : moralis.health === "down"
      ? moralis.detail === "quota"
        ? "Quota exhausted — not detecting sales"
        : "Error fetching trades"
      : "Waiting for first poll…";

  // X
  setChip("status-x", x.health);
  let xText;
  if (x.health === "ok") xText = `OK · posted ${fmtAgo(x.lastOkAt)}`;
  else if (x.health === "down") {
    if (x.detail === "credits") xText = "Out of credits — recharge X plan";
    else if (x.detail === "spend_cap") xText = "Spend cap reached" + (x.resetAt ? ` · resets ${esc(x.resetAt)}` : "");
    else if (x.detail === "rate_limit") xText = "Rate-limited";
    else if (x.detail === "auth") xText = "Auth failed — check credentials";
    else xText = esc(x.message || "Error");
  } else xText = "Waiting…";
  $("x-detail").textContent = xText;

  // Queue
  setChip("status-queue", queueCount > 0 ? "warn" : "ok");
  $("queue-detail").textContent =
    queueCount > 0 ? `${queueCount} sale${queueCount > 1 ? "s" : ""} pending retry` : "Empty";

  // Posted
  setChip("status-posted", postedCount > 0 ? "ok" : "unknown");
  $("posted-detail").textContent = lastPostedAt
    ? `${postedCount} this run · last ${fmtAgo(lastPostedAt)}`
    : "None yet this run";

  // Warning banner
  const warn = $("console-warning");
  const ws = [];
  if (moralis.health === "down")
    ws.push(
      moralis.detail === "quota"
        ? "⚠ Moralis quota exhausted — no new sales are being detected until it resets."
        : "⚠ Moralis is failing — sale detection is paused."
    );
  if (x.health === "down")
    ws.push(
      x.detail === "credits"
        ? "⚠ X API out of credits — recharge your X API plan. Detected sales are queued and auto-post once credits are restored."
        : x.detail === "spend_cap"
        ? `⚠ X API spend cap reached — posting is blocked${x.resetAt ? ` until ${esc(x.resetAt)}` : ""}. Detected sales are queued and auto-post when it clears.`
        : `⚠ X API ${esc(x.detail || "error")} — posting blocked; sales are being queued.`
    );
  if (ws.length) {
    warn.innerHTML = ws.map((w) => `<div>${w}</div>`).join("");
    warn.classList.remove("hidden");
  } else warn.classList.add("hidden");

  // Queue list
  const ql = $("queue-list");
  if (queue.length) {
    ql.innerHTML = queue
      .map(
        (q) =>
          `<div class="queue-item"><span class="qi-name">${esc(q.collection_name)}</span>` +
          `<a class="qi-tx" href="https://etherscan.io/tx/${esc(q.tx_hash)}" target="_blank" rel="noopener">${esc(q.tx_hash.slice(0, 10))}…</a>` +
          `<span class="qi-meta">${q.attempts} ${q.attempts === 1 ? "try" : "tries"}</span></div>`
      )
      .join("");
    ql.classList.remove("hidden");
  } else ql.classList.add("hidden");

  // Event log
  $("console-log").innerHTML =
    events.length
      ? events
          .map(
            (ev) =>
              `<li class="log-${esc(ev.level)}"><span class="log-time">${fmtAgo(ev.at)}</span> ${esc(ev.message)}</li>`
          )
          .join("")
      : "<li class='muted'>No events yet.</li>";

  $("console-updated").textContent = `updated ${fmtAgo(lastPollAt)}`;
}

let consoleTimer = null;
async function loadConsole() {
  try {
    renderConsole(await api("/api/console"));
  } catch {
    /* 401 already handled */
  }
}
function startConsolePolling() {
  loadConsole();
  if (consoleTimer) clearInterval(consoleTimer);
  consoleTimer = setInterval(loadConsole, 15000);
}

// --- Init ---

(async () => {
  try {
    const { authed } = await fetch("/api/session").then((r) => r.json());
    authed ? showApp() : showLogin();
  } catch {
    showLogin();
  }
})();
