/* ============================================================
   API HELPER + SESSION
   ============================================================ */

async function api(action, payload) {
  const session = getSession();
  const body = Object.assign({ action, token: session ? session.token : undefined }, payload || {});
  const res = await fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  });
  return res.json();
}

function getSession() {
  const raw = localStorage.getItem("disp_crm_session");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function setSession(session) {
  if (session) localStorage.setItem("disp_crm_session", JSON.stringify(session));
  else localStorage.removeItem("disp_crm_session");
}

function statusClass(status) {
  return "status-" + String(status || "").toLowerCase().replace(/\s+/g, "-");
}

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* ============================================================
   BOOT / ROUTING
   ============================================================ */

const els = {};
["login-view", "rep-view", "admin-view", "who-label", "logout-btn"].forEach(function (id) {
  els[id] = document.getElementById(id);
});

function showView(session) {
  els["login-view"].hidden = !!session;
  els["rep-view"].hidden = true;
  els["admin-view"].hidden = true;
  els["who-label"].hidden = !session;
  els["logout-btn"].hidden = !session;

  if (!session) return;
  els["who-label"].textContent = session.name + (session.isAdmin ? " (Admin)" : "");

  if (session.isAdmin) {
    els["admin-view"].hidden = false;
    initAdminView();
  } else {
    els["rep-view"].hidden = false;
    initRepView();
  }
}

document.getElementById("logout-btn").addEventListener("click", function () {
  setSession(null);
  showView(null);
});

document.getElementById("login-btn").addEventListener("click", doLogin);
document.getElementById("login-password").addEventListener("keydown", function (e) {
  if (e.key === "Enter") doLogin();
});

async function doLogin() {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.classList.remove("show");
  if (!username || !password) {
    errorEl.textContent = "Enter both a username and password.";
    errorEl.classList.add("show");
    return;
  }
  const res = await api("login", { username: username, password: password });
  if (!res.ok) {
    errorEl.textContent = res.error || "Login failed.";
    errorEl.classList.add("show");
    return;
  }
  setSession(res);
  showView(res);
}

showView(getSession());

/* ============================================================
   REP VIEW
   ============================================================ */

let repDeals = [];
let statusOptionsCache = [];

async function initRepView() {
  const statusRes = await api("getStatusOptions", {});
  if (statusRes.ok) statusOptionsCache = statusRes.statuses;

  const res = await api("getDeals", {});
  if (!res.ok) {
    setSession(null);
    showView(null);
    return;
  }
  repDeals = res.deals;
  renderRepDeals();
}

document.getElementById("rep-search-input").addEventListener("input", renderRepDeals);

function renderRepDeals() {
  const q = document.getElementById("rep-search-input").value.trim().toLowerCase();
  const container = document.getElementById("rep-deals-container");
  const empty = document.getElementById("rep-deals-empty");
  const filtered = repDeals.filter(function (d) {
    if (!q) return true;
    return [d.DealCode, d.City, d.State, d.County, d.AssetType].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; });
  });
  empty.hidden = filtered.length > 0;
  container.innerHTML = filtered.map(function (d) {
    const heading = esc(d.DealCode || "Deal") + (d.City ? " &middot; " + esc(d.City) + (d.State ? ", " + esc(d.State) : "") : "");
    return '<div class="deal-card" data-deal-id="' + esc(d.DealID) + '">' +
      '<div class="addr">' + heading + '</div>' +
      '<div class="meta">' + esc(d.AssetType || "") + (d.Price ? " &middot; " + esc(d.Price) : "") +
      ' <span class="status-pill ' + statusClass(d.Status) + '">' + esc(d.Status || "") + '</span></div>' +
      '</div>';
  }).join("");
  Array.from(container.querySelectorAll(".deal-card")).forEach(function (card) {
    card.addEventListener("click", function () { openRepDealDetail(card.getAttribute("data-deal-id")); });
  });
}

async function openRepDealDetail(dealId) {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const [dealRes, buyersRes, fbRes] = await Promise.all([
    api("getDeal", { dealId: dealId }),
    api("getInterestedBuyers", { dealId: dealId }),
    api("getMyFbRequests", { dealId: dealId })
  ]);
  if (!dealRes.ok) { overlay.hidden = true; return; }
  const deal = dealRes.deal;
  const buyers = buyersRes.ok ? buyersRes.buyers : [];
  const fbRequests = fbRes.ok ? fbRes.requests : [];

  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + esc(deal.DealCode || "Deal") + '</h2>' +
      '<p class="step-sub">' + [deal.City, deal.State].filter(Boolean).join(", ") + (deal.Zip ? " " + esc(deal.Zip) : "") +
      (deal.County ? " &middot; " + esc(deal.County) + " County" : "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +
    '<div class="banner info">' +
      '<span class="status-pill ' + statusClass(deal.Status) + '">' + esc(deal.Status || "") + '</span>' +
      (deal.AssetType ? '<div style="margin-top:8px;"><strong>Asset Type:</strong> ' + esc(deal.AssetType) + '</div>' : "") +
      (deal.Price ? '<div><strong>Price:</strong> ' + esc(deal.Price) + '</div>' : "") +
      (deal.Description ? '<div style="margin-top:8px;">' + esc(deal.Description) + '</div>' : "") +
      (deal.GeneralDriveLink ? '<div style="margin-top:8px;"><a href="' + esc(deal.GeneralDriveLink) + '" target="_blank" rel="noopener">Open Drive Folder</a></div>' : "") +
    '</div>' +

    '<div class="section-title">Step 1 &middot; Submit a Facebook Post for Approval</div>' +
    '<label class="field-label">Post text</label>' +
    '<textarea id="fb-post-text"></textarea>' +
    '<label class="field-label">Groups you intend to post it to</label>' +
    '<textarea id="fb-post-groups" placeholder="e.g. Phoenix Off-Market Deals, Investor Network AZ"></textarea>' +
    '<div class="error-text" id="fb-post-error"></div>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn primary" id="fb-post-submit">Submit for Approval</button>' +
    '</div>' +
    '<div id="fb-post-list">' + renderFbRequestList(fbRequests, false) + '</div>' +

    '<div class="section-title">Step 2 &middot; Interested Buyers</div>' +
    '<p class="small-muted">Log a buyer here as soon as they show interest — this emails admin immediately. Keep pasting conversation updates into their notes below as things progress, and mark the match Negotiating/Closing/Dead as it plays out.</p>' +
    '<label class="field-label">Buyer name</label>' +
    '<input type="text" id="buyer-name-input">' +
    '<label class="field-label">Contact (optional)</label>' +
    '<input type="text" id="buyer-contact-input">' +
    '<label class="field-label">Notes (optional)</label>' +
    '<textarea id="buyer-notes-input"></textarea>' +
    '<div class="error-text" id="buyer-add-error"></div>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn primary" id="buyer-add-submit">Add Interested Buyer</button>' +
    '</div>' +
    '<div id="buyer-list">' + renderBuyerMatchList(buyers) + '</div>';

  wireBuyerMatchListHandlers(document.getElementById("buyer-list"), function () { return refreshBuyerMatchList(dealId, "buyer-list"); });

  document.getElementById("close-detail-btn").addEventListener("click", function () { overlay.hidden = true; });

  document.getElementById("fb-post-submit").addEventListener("click", async function () {
    const postText = document.getElementById("fb-post-text").value.trim();
    const groups = document.getElementById("fb-post-groups").value.trim();
    const errorEl = document.getElementById("fb-post-error");
    errorEl.classList.remove("show");
    if (!postText) {
      errorEl.textContent = "Enter the post text you'd like approved.";
      errorEl.classList.add("show");
      return;
    }
    const res = await api("submitFbPostRequest", { dealId: dealId, postText: postText, targetGroups: groups });
    if (!res.ok) {
      errorEl.textContent = res.error || "Could not submit.";
      errorEl.classList.add("show");
      return;
    }
    document.getElementById("fb-post-text").value = "";
    document.getElementById("fb-post-groups").value = "";
    const fresh = await api("getMyFbRequests", { dealId: dealId });
    document.getElementById("fb-post-list").innerHTML = renderFbRequestList(fresh.ok ? fresh.requests : [], false);
  });

  document.getElementById("buyer-add-submit").addEventListener("click", async function () {
    const buyerName = document.getElementById("buyer-name-input").value.trim();
    const contact = document.getElementById("buyer-contact-input").value.trim();
    const notes = document.getElementById("buyer-notes-input").value.trim();
    const errorEl = document.getElementById("buyer-add-error");
    errorEl.classList.remove("show");
    if (!buyerName) {
      errorEl.textContent = "Enter the buyer's name.";
      errorEl.classList.add("show");
      return;
    }
    const res = await api("addInterestedBuyer", { dealId: dealId, buyerName: buyerName, buyerContact: contact, notes: notes });
    if (!res.ok) {
      errorEl.textContent = res.error || "Could not add buyer.";
      errorEl.classList.add("show");
      return;
    }
    document.getElementById("buyer-name-input").value = "";
    document.getElementById("buyer-contact-input").value = "";
    document.getElementById("buyer-notes-input").value = "";
    await refreshBuyerMatchList(dealId);
  });
}

async function refreshBuyerMatchList(dealId, containerId) {
  const fresh = await api("getInterestedBuyers", { dealId: dealId });
  const container = document.getElementById(containerId || "buyer-list");
  if (!container) return;
  container.innerHTML = renderBuyerMatchList(fresh.ok ? fresh.buyers : []);
  wireBuyerMatchListHandlers(container, function () { return refreshBuyerMatchList(dealId, containerId); });
}

function renderFbRequestList(requests, showAuthor) {
  if (requests.length === 0) return '<p class="small-muted">No post requests submitted yet.</p>';
  return requests.slice().reverse().map(function (r) {
    const pillClass = r.Status === "Approved" ? "status-active" : r.Status === "Rejected" ? "status-dead" : "status-onhold";
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(r.CreatedAt) + (showAuthor ? " &middot; " + esc(r.Username) : "") + '</span>' +
      '<span class="status-pill ' + pillClass + '">' + esc(r.Status) + '</span>' +
      '<div style="margin-top:6px;">' + esc(r.PostText) + '</div>' +
      (r.TargetGroups ? '<div class="small-muted" style="margin-top:4px;">Groups: ' + esc(r.TargetGroups) + '</div>' : "") +
      (r.AdminNote ? '<div class="small-muted" style="margin-top:4px;">Admin note: ' + esc(r.AdminNote) + '</div>' : "") +
      '</div>';
  }).join("");
}

const MATCH_STATUSES = ["Active Match", "Negotiating", "Closing", "Dead Match"];

// Shared by both the rep's deal detail and the admin's deal detail /
// Buyer Matches tab -- the backend enforces who's actually allowed to save
// (admin, or any rep with access to the deal), so the same markup and
// handlers work for both; the Admin Note field only renders for admin.
function renderBuyerMatchList(buyers) {
  if (buyers.length === 0) return '<p class="small-muted">No interested buyers logged yet.</p>';
  const session = getSession();
  const isAdmin = !!(session && session.isAdmin);
  return buyers.slice().reverse().map(function (b) {
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(b.CreatedAt) + ' &middot; added by ' + esc(b.Username) + '</span>' +
      '<div style="margin-top:6px;"><strong>' + esc(b.BuyerName) + '</strong>' +
      (b.BuyerContact ? ' &mdash; ' + esc(b.BuyerContact) : "") + '</div>' +
      '<div style="margin-top:8px; display:flex; gap:8px; align-items:center;">' +
        '<select class="match-status-select" data-buyer-id="' + esc(b.BuyerID) + '" style="flex:1;">' +
          MATCH_STATUSES.map(function (s) { return '<option value="' + esc(s) + '"' + (s === b.MatchStatus ? " selected" : "") + '>' + esc(s) + '</option>'; }).join("") +
        '</select>' +
        '<button class="btn secondary small match-status-save-btn" data-buyer-id="' + esc(b.BuyerID) + '">Update</button>' +
      '</div>' +
      '<label class="field-label">Conversation Notes</label>' +
      '<textarea class="match-notes-input" data-buyer-id="' + esc(b.BuyerID) + '">' + esc(b.Notes || "") + '</textarea>' +
      '<div class="nav-row" style="justify-content:flex-end; margin-top:6px;">' +
        '<button class="btn secondary small match-notes-save-btn" data-buyer-id="' + esc(b.BuyerID) + '">Save Notes</button>' +
      '</div>' +
      (isAdmin
        ? '<label class="field-label">Admin Note</label>' +
          '<input type="text" class="match-adminnote-input" data-buyer-id="' + esc(b.BuyerID) + '" value="' + esc(b.AdminNote || "") + '">'
        : (b.AdminNote ? '<div class="small-muted" style="margin-top:4px;">Admin note: ' + esc(b.AdminNote) + '</div>' : "")) +
      '</div>';
  }).join("");
}

// Caller passes the container element that just had renderBuyerMatchList's
// output set as its innerHTML, plus a refresh callback to re-render after a
// save. Kept separate from rendering so callers wire it explicitly, same
// pattern as every other list in this file.
function wireBuyerMatchListHandlers(container, onSaved) {
  Array.from(container.querySelectorAll(".match-status-save-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const buyerId = btn.getAttribute("data-buyer-id");
      const select = container.querySelector('.match-status-select[data-buyer-id="' + buyerId + '"]');
      const adminNoteInput = container.querySelector('.match-adminnote-input[data-buyer-id="' + buyerId + '"]');
      const payload = { buyerId: buyerId, matchStatus: select.value };
      if (adminNoteInput) payload.adminNote = adminNoteInput.value.trim();
      await api("updateInterestedBuyerMatchStatus", payload);
      await onSaved();
    });
  });
  Array.from(container.querySelectorAll(".match-notes-save-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const buyerId = btn.getAttribute("data-buyer-id");
      const textarea = container.querySelector('.match-notes-input[data-buyer-id="' + buyerId + '"]');
      await api("updateInterestedBuyerNotes", { buyerId: buyerId, notes: textarea.value.trim() });
    });
  });
}

/* ============================================================
   REP VIEW — BUYER LEADS
   ============================================================ */

let myPitches = [];

Array.from(document.querySelectorAll("#rep-view .tab-btn")).forEach(function (btn) {
  btn.addEventListener("click", function () { switchRepTab(btn.getAttribute("data-rep-tab")); });
});

function switchRepTab(tab) {
  Array.from(document.querySelectorAll("#rep-view .tab-btn")).forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-rep-tab") === tab);
  });
  document.getElementById("rep-tab-deals").hidden = tab !== "deals";
  document.getElementById("rep-tab-buyerleads").hidden = tab !== "buyerleads";
  if (tab === "buyerleads") loadMyPitches();
}

const LEAD_STATUS_PRIORITY = ["Follow-Up Due", "Follow-Up In Progress", "Awaiting Response", "Not Contacted", "Responded", "Fully Worked"];

async function loadMyPitches() {
  const res = await api("getMyPitches", {});
  if (!res.ok) return;
  myPitches = res.pitches;
  renderMyPitches();
}

function renderMyPitches() {
  const container = document.getElementById("buyerleads-list");
  const empty = document.getElementById("buyerleads-empty");
  empty.hidden = myPitches.length > 0;
  const sorted = myPitches.slice().sort(function (a, b) {
    if (a.dealStillActive !== b.dealStillActive) return a.dealStillActive ? -1 : 1;
    return LEAD_STATUS_PRIORITY.indexOf(a.status) - LEAD_STATUS_PRIORITY.indexOf(b.status);
  });
  container.innerHTML = sorted.map(function (p) {
    const typeHint = p.phoneType === "Landline" ? "Landline &middot; Call Only" : p.phoneType === "Mobile" ? "Mobile &middot; Call or Text" : (p.phoneType || "");
    return '<div class="deal-card" data-pitch-id="' + esc(p.PitchID) + '">' +
      '<div class="addr">' + esc(p.buyerName) + '</div>' +
      '<div class="meta">Re: ' + esc(p.dealCode || "Deal") + '</div>' +
      '<div class="meta">' + esc(p.phone) + (typeHint ? " &middot; " + typeHint : "") +
      (p.city ? " &middot; " + esc(p.city) + (p.state ? ", " + esc(p.state) : "") : "") + '</div>' +
      '<div style="margin-top:6px;">' +
      (p.dealStillActive
        ? '<span class="status-pill ' + statusClass(p.status) + '">' + esc(p.status) + '</span>'
        : '<span class="status-pill status-fully-worked">Deal ' + esc((p.dealStatus || "closed").toLowerCase()) + ' &mdash; no action needed</span>') +
      '</div>' +
      '</div>';
  }).join("");
  Array.from(container.querySelectorAll(".deal-card")).forEach(function (card) {
    card.addEventListener("click", function () { openPitchDetail(card.getAttribute("data-pitch-id")); });
  });
}

async function openPitchDetail(pitchId) {
  const pitch = myPitches.find(function (p) { return p.PitchID === pitchId; });
  if (!pitch) return;

  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const contactsRes = await api("getPitchContacts", { pitchId: pitchId });
  const contacts = contactsRes.ok ? contactsRes.contacts : [];
  const isLandline = pitch.phoneType === "Landline";

  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + esc(pitch.buyerName) + '</h2>' +
      '<p class="step-sub">' + esc(pitch.phone) + ' &middot; ' + esc(pitch.phoneType || "") +
      (pitch.city ? ' &middot; ' + esc(pitch.city) + (pitch.state ? ", " + esc(pitch.state) : "") : "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +
    '<div class="banner info">' +
      (pitch.dealStillActive
        ? '<span class="status-pill ' + statusClass(pitch.status) + '">' + esc(pitch.status) + '</span>'
        : '<span class="status-pill status-fully-worked">Deal ' + esc((pitch.dealStatus || "closed").toLowerCase()) + '</span>') +
      '<div style="margin-top:8px;"><strong>Re:</strong> ' + esc(pitch.dealCode || "Deal") + '</div>' +
      (isLandline ? '<div style="margin-top:8px;">Landline &mdash; call only, texting isn\'t possible.</div>' : '<div style="margin-top:8px;">Mobile &mdash; you can call or text.</div>') +
      (pitch.email ? '<div style="margin-top:8px;"><strong>Email:</strong> <a href="mailto:' + esc(pitch.email) + '">' + esc(pitch.email) + '</a></div>' : "") +
      (pitch.driveLink ? '<div style="margin-top:8px;"><strong>Documents:</strong> <a href="' + esc(pitch.driveLink) + '" target="_blank" rel="noopener">Open Drive Folder</a></div>' : "") +
    '</div>' +

    '<div class="section-title">General Buyer Notes</div>' +
    '<p class="small-muted">Shared across every deal this buyer is ever pitched — ARV%, price range, areas of interest, cash vs. financed, etc.</p>' +
    '<textarea id="general-notes-input">' + esc(pitch.generalNotes || "") + '</textarea>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="general-notes-save-btn">Save Notes</button>' +
    '</div>' +

    '<div class="section-title">Log a Contact</div>' +
    '<label class="field-label">Method</label>' +
    '<select id="contact-method-input">' +
      '<option value="Call">Call</option>' +
      (isLandline ? '' : '<option value="Text">Text</option>') +
    '</select>' +
    '<label class="checkbox-row"><input type="checkbox" id="contact-responded-input"> Buyer responded during this contact</label>' +
    '<label class="field-label">Notes (buyer feedback on this deal specifically)</label>' +
    '<textarea id="contact-notes-input"></textarea>' +
    '<div class="error-text" id="contact-add-error"></div>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn primary" id="contact-add-submit">Log Contact</button>' +
    '</div>' +
    '<div class="section-title">Contact History</div>' +
    '<div id="contact-history-list">' + renderContactHistory(contacts) + '</div>';

  document.getElementById("close-detail-btn").addEventListener("click", function () { overlay.hidden = true; loadMyPitches(); });

  document.getElementById("general-notes-save-btn").addEventListener("click", async function () {
    await api("updateBuyerLeadNotes", { buyerLeadId: pitch.BuyerLeadID, notes: document.getElementById("general-notes-input").value.trim() });
  });

  document.getElementById("contact-add-submit").addEventListener("click", async function () {
    const method = document.getElementById("contact-method-input").value;
    const responded = document.getElementById("contact-responded-input").checked;
    const notes = document.getElementById("contact-notes-input").value.trim();
    const errorEl = document.getElementById("contact-add-error");
    errorEl.classList.remove("show");
    const res = await api("addPitchContact", { pitchId: pitchId, method: method, responded: responded, notes: notes });
    if (!res.ok) {
      errorEl.textContent = res.error || "Could not log contact.";
      errorEl.classList.add("show");
      return;
    }
    document.getElementById("contact-notes-input").value = "";
    document.getElementById("contact-responded-input").checked = false;
    const fresh = await api("getPitchContacts", { pitchId: pitchId });
    document.getElementById("contact-history-list").innerHTML = renderContactHistory(fresh.ok ? fresh.contacts : []);
  });
}

function renderContactHistory(contacts) {
  if (contacts.length === 0) return '<p class="small-muted">No contact logged yet.</p>';
  return contacts.slice().reverse().map(function (c) {
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(c.ContactedAt) + ' &middot; ' + esc(c.Username) + ' &middot; ' + esc(c.Method) +
      (c.Responded === true || c.Responded === "TRUE" ? ' &middot; <strong>Responded</strong>' : '') + '</span>' +
      (c.Notes ? '<div style="margin-top:4px;">' + esc(c.Notes) + '</div>' : "") +
      '</div>';
  }).join("");
}

/* ============================================================
   ADMIN VIEW
   ============================================================ */

let adminDeals = [];
let adminReps = [];

Array.from(document.querySelectorAll("#admin-view .tabs .tab-btn")).forEach(function (btn) {
  btn.addEventListener("click", function () { switchAdminTab(btn.getAttribute("data-tab")); });
});

function switchAdminTab(tab) {
  Array.from(document.querySelectorAll("#admin-view .tabs .tab-btn")).forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  });
  ["deals", "team", "fb", "buyers", "buyerleads", "statuses"].forEach(function (t) {
    document.getElementById("tab-" + t).hidden = t !== tab;
  });
  if (tab === "team") loadReps();
  if (tab === "fb") loadFbRequests();
  if (tab === "buyers") loadBuyerRequests();
  if (tab === "buyerleads") initBuyerLeadsAdminTab();
  if (tab === "statuses") loadStatusOptions();
}

async function initAdminView() {
  await loadStatusOptions();
  await loadAdminDeals();
}

/* ---------- Deals tab ---------- */

async function loadAdminDeals() {
  const res = await api("getDeals", {});
  if (!res.ok) return;
  adminDeals = res.deals;
  renderAdminDeals();
}

document.getElementById("admin-deal-search").addEventListener("input", renderAdminDeals);

function renderAdminDeals() {
  const q = document.getElementById("admin-deal-search").value.trim().toLowerCase();
  const tbody = document.getElementById("admin-deals-tbody");
  const empty = document.getElementById("admin-deals-empty");
  const filtered = adminDeals.filter(function (d) {
    if (!q) return true;
    return [d.DealCode, d.Address, d.City, d.AssetType, d.Status].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; });
  });
  empty.hidden = filtered.length > 0;
  tbody.innerHTML = filtered.map(function (d) {
    return '<tr class="clickable" data-deal-id="' + esc(d.DealID) + '">' +
      '<td>' + (d.DealCode ? esc(d.DealCode) : "&mdash;") + '</td>' +
      '<td>' + esc(d.Address) + (d.City ? ", " + esc(d.City) : "") + '</td>' +
      '<td>' + esc(d.AssetType || "") + '</td>' +
      '<td>' + esc(d.Price || "") + '</td>' +
      '<td><span class="status-pill ' + statusClass(d.Status) + '">' + esc(d.Status || "") + '</span></td>' +
      '<td class="small-muted">Manage &rarr;</td>' +
      '</tr>';
  }).join("");
  Array.from(tbody.querySelectorAll("tr")).forEach(function (row) {
    row.addEventListener("click", function () { openAdminDealDetail(row.getAttribute("data-deal-id")); });
  });
}

document.getElementById("add-deal-btn").addEventListener("click", function () { openDealModal(); });

function openDealModal() {
  document.getElementById("deal-code-input").value = "";
  document.getElementById("deal-address-input").value = "";
  document.getElementById("deal-city-input").value = "";
  document.getElementById("deal-state-input").value = "";
  document.getElementById("deal-zip-input").value = "";
  document.getElementById("deal-county-input").value = "";
  document.getElementById("deal-assettype-input").value = "";
  document.getElementById("deal-price-input").value = "";
  document.getElementById("deal-description-input").value = "";
  document.getElementById("deal-general-drive-input").value = "";
  document.getElementById("deal-sensitive-drive-input").value = "";
  document.getElementById("deal-admin-notes-input").value = "";
  document.getElementById("deal-source-link-input").value = "";
  const statusSelect = document.getElementById("deal-status-input");
  statusSelect.innerHTML = statusOptionsCache.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join("");
  document.getElementById("deal-modal-error").classList.remove("show");
  document.getElementById("deal-modal").hidden = false;
}

document.getElementById("deal-modal-cancel").addEventListener("click", function () {
  document.getElementById("deal-modal").hidden = true;
});

document.getElementById("deal-modal-save").addEventListener("click", async function () {
  const address = document.getElementById("deal-address-input").value.trim();
  const errorEl = document.getElementById("deal-modal-error");
  errorEl.classList.remove("show");
  if (!address) {
    errorEl.textContent = "Address is required.";
    errorEl.classList.add("show");
    return;
  }
  const data = {
    dealCode: document.getElementById("deal-code-input").value.trim(),
    address: address,
    city: document.getElementById("deal-city-input").value.trim(),
    state: document.getElementById("deal-state-input").value.trim(),
    zip: document.getElementById("deal-zip-input").value.trim(),
    county: document.getElementById("deal-county-input").value.trim(),
    assetType: document.getElementById("deal-assettype-input").value.trim(),
    price: document.getElementById("deal-price-input").value.trim(),
    status: document.getElementById("deal-status-input").value,
    description: document.getElementById("deal-description-input").value.trim(),
    generalDriveLink: document.getElementById("deal-general-drive-input").value.trim(),
    sensitiveDriveLink: document.getElementById("deal-sensitive-drive-input").value.trim(),
    adminPrivateNotes: document.getElementById("deal-admin-notes-input").value.trim(),
    sourceLink: document.getElementById("deal-source-link-input").value.trim()
  };
  const res = await api("adminAddDeal", { data: data });
  if (!res.ok) {
    errorEl.textContent = res.error || "Could not save deal.";
    errorEl.classList.add("show");
    return;
  }
  document.getElementById("deal-modal").hidden = true;
  await loadAdminDeals();
});

async function openAdminDealDetail(dealId) {
  const deal = adminDeals.find(function (d) { return d.DealID === dealId; });
  if (!deal) return;

  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const [repsRes, assignRes, buyersRes, fbRes] = await Promise.all([
    api("adminGetReps", {}),
    api("adminGetAssignments", { dealId: dealId }),
    api("getInterestedBuyers", { dealId: dealId }),
    api("adminGetFbRequests", { dealId: dealId })
  ]);
  const allReps = repsRes.ok ? repsRes.reps.filter(function (r) { return r.active && !r.allAccess; }) : [];
  const assignedUsernames = assignRes.ok ? assignRes.usernames : [];
  const buyers = buyersRes.ok ? buyersRes.buyers : [];
  const fbRequests = fbRes.ok ? fbRes.requests : [];

  renderAdminDealDetail(deal, allReps, assignedUsernames, buyers, fbRequests);
}

function renderAdminDealDetail(deal, allReps, assignedUsernames, buyers, fbRequests) {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");

  const availableReps = allReps.filter(function (r) { return assignedUsernames.indexOf(r.username) === -1; });

  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + esc(deal.Address) + '</h2>' +
      '<p class="step-sub">' + (deal.DealCode ? '<strong>' + esc(deal.DealCode) + '</strong> &middot; ' : "") +
        esc(deal.City || "") + (deal.State ? ", " + esc(deal.State) : "") + ' ' + esc(deal.Zip || "") +
        (deal.County ? ' &middot; ' + esc(deal.County) + ' County' : "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +

    '<label class="field-label">Status</label>' +
    '<select id="deal-status-select">' +
      statusOptionsCache.map(function (s) { return '<option value="' + esc(s) + '"' + (s === deal.Status ? " selected" : "") + '>' + esc(s) + '</option>'; }).join("") +
    '</select>' +

    '<div class="row3">' +
      '<div><label class="field-label">Deal Code <span class="small-muted">(shown to reps instead of the address)</span></label><input type="text" id="deal-code-edit" value="' + esc(deal.DealCode || "") + '" placeholder="e.g. A-1"></div>' +
      '<div><label class="field-label">County</label><input type="text" id="deal-county-edit" value="' + esc(deal.County || "") + '"></div>' +
      '<div></div>' +
    '</div>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary small" id="save-code-btn">Save Deal Code / County</button>' +
    '</div>' +

    '<div class="section-title">Access &mdash; who can work this deal</div>' +
    '<p class="small-muted">Team members with "all-deal access" can already see every deal and don\'t need to be listed here.</p>' +
    '<div class="chip-list" id="assigned-chip-list">' +
      assignedUsernames.map(function (u) {
        return '<span class="chip">' + esc(u) + '<button data-username="' + esc(u) + '" class="unassign-btn">&times;</button></span>';
      }).join("") +
    '</div>' +
    (availableReps.length > 0
      ? '<div style="display:flex; gap:8px; margin-top:10px;">' +
          '<select id="assign-rep-select" style="flex:1;">' +
            availableReps.map(function (r) { return '<option value="' + esc(r.username) + '">' + esc(r.name) + ' (' + esc(r.username) + ')</option>'; }).join("") +
          '</select>' +
          '<button class="btn secondary small" id="assign-rep-btn">Add Access</button>' +
        '</div>'
      : '<p class="small-muted" style="margin-top:8px;">Every non all-access team member is already assigned.</p>') +

    '<div class="section-title">Facebook Post Requests</div>' +
    '<div id="admin-fb-list">' + renderAdminFbList(fbRequests) + '</div>' +

    '<div class="section-title">Interested Buyers &mdash; Matches</div>' +
    '<div id="admin-buyer-list">' + renderBuyerMatchList(buyers) + '</div>' +

    '<label class="field-label" style="margin-top:24px;">Description / Notes</label>' +
    '<textarea id="deal-desc-edit">' + esc(deal.Description || "") + '</textarea>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="save-desc-btn">Save Notes</button>' +
    '</div>' +

    '<div class="section-title">Documents (Google Drive)</div>' +
    '<label class="field-label">General Drive Link <span class="small-muted">(visible to your team)</span></label>' +
    '<input type="text" id="deal-general-drive-edit" value="' + esc(deal.GeneralDriveLink || "") + '" placeholder="https://drive.google.com/...">' +
    '<label class="field-label">Sensitive Drive Link <span class="small-muted">(admin only)</span></label>' +
    '<input type="text" id="deal-sensitive-drive-edit" value="' + esc(deal.SensitiveDriveLink || "") + '" placeholder="https://drive.google.com/...">' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="save-drive-links-btn">Save Drive Links</button>' +
    '</div>' +

    '<div class="section-title">Private Admin Notes</div>' +
    '<div class="banner danger">Only you (admin) can see anything in this section &mdash; no rep ever receives it, in the UI or the API.</div>' +
    '<label class="field-label">Source Link <span class="small-muted">(where you found this deal online)</span></label>' +
    '<input type="text" id="deal-source-link-edit" value="' + esc(deal.SourceLink || "") + '" placeholder="https://...">' +
    '<label class="field-label">Private Notes</label>' +
    '<textarea id="deal-admin-notes-edit">' + esc(deal.AdminPrivateNotes || "") + '</textarea>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="save-admin-notes-btn">Save Private Notes</button>' +
    '</div>';

  document.getElementById("close-detail-btn").addEventListener("click", function () { overlay.hidden = true; loadAdminDeals(); });

  wireBuyerMatchListHandlers(document.getElementById("admin-buyer-list"), function () {
    return refreshBuyerMatchList(deal.DealID, "admin-buyer-list");
  });

  document.getElementById("save-code-btn").addEventListener("click", async function () {
    await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        DealCode: document.getElementById("deal-code-edit").value.trim(),
        County: document.getElementById("deal-county-edit").value.trim()
      }
    });
    await loadAdminDeals();
    openAdminDealDetail(deal.DealID);
  });

  document.getElementById("save-admin-notes-btn").addEventListener("click", async function () {
    await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        SourceLink: document.getElementById("deal-source-link-edit").value.trim(),
        AdminPrivateNotes: document.getElementById("deal-admin-notes-edit").value.trim()
      }
    });
  });

  document.getElementById("deal-status-select").addEventListener("change", async function (e) {
    await api("adminUpdateDealStatus", { dealId: deal.DealID, status: e.target.value });
    deal.Status = e.target.value;
  });

  Array.from(panel.querySelectorAll(".unassign-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      await api("adminUnassignRep", { dealId: deal.DealID, username: btn.getAttribute("data-username") });
      openAdminDealDetail(deal.DealID);
    });
  });

  const assignBtn = document.getElementById("assign-rep-btn");
  if (assignBtn) {
    assignBtn.addEventListener("click", async function () {
      const username = document.getElementById("assign-rep-select").value;
      await api("adminAssignRep", { dealId: deal.DealID, username: username });
      openAdminDealDetail(deal.DealID);
    });
  }

  document.getElementById("save-desc-btn").addEventListener("click", async function () {
    await api("adminUpdateDeal", { dealId: deal.DealID, data: { Description: document.getElementById("deal-desc-edit").value.trim() } });
    await loadAdminDeals();
  });

  document.getElementById("save-drive-links-btn").addEventListener("click", async function () {
    await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        GeneralDriveLink: document.getElementById("deal-general-drive-edit").value.trim(),
        SensitiveDriveLink: document.getElementById("deal-sensitive-drive-edit").value.trim()
      }
    });
    await loadAdminDeals();
  });

  Array.from(panel.querySelectorAll(".fb-decide-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const requestId = btn.getAttribute("data-request-id");
      const decision = btn.getAttribute("data-decision");
      const note = document.getElementById("fb-note-" + requestId).value.trim();
      await api("adminDecideFbRequest", { requestId: requestId, decision: decision, note: note });
      openAdminDealDetail(deal.DealID);
    });
  });
}

function renderAdminFbList(requests) {
  if (requests.length === 0) return '<p class="small-muted">No Facebook post requests for this deal yet.</p>';
  return requests.slice().reverse().map(function (r) {
    const pillClass = r.Status === "Approved" ? "status-active" : r.Status === "Rejected" ? "status-dead" : "status-onhold";
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(r.CreatedAt) + " &middot; " + esc(r.Username) + '</span>' +
      '<span class="status-pill ' + pillClass + '">' + esc(r.Status) + '</span>' +
      '<div style="margin-top:6px;">' + esc(r.PostText) + '</div>' +
      (r.TargetGroups ? '<div class="small-muted" style="margin-top:4px;">Groups: ' + esc(r.TargetGroups) + '</div>' : "") +
      (r.Status === "Pending"
        ? '<div style="margin-top:8px;">' +
            '<input type="text" id="fb-note-' + esc(r.RequestID) + '" placeholder="Optional note" style="margin-bottom:6px;">' +
            '<div class="actions">' +
              '<button class="btn small primary fb-decide-btn" data-request-id="' + esc(r.RequestID) + '" data-decision="Approved">Approve</button>' +
              '<button class="btn small danger fb-decide-btn" data-request-id="' + esc(r.RequestID) + '" data-decision="Rejected">Reject</button>' +
            '</div>' +
          '</div>'
        : (r.AdminNote ? '<div class="small-muted" style="margin-top:4px;">Admin note: ' + esc(r.AdminNote) + '</div>' : "")) +
      '</div>';
  }).join("");
}

/* ---------- Team tab ---------- */

async function loadReps() {
  const res = await api("adminGetReps", {});
  if (!res.ok) return;
  adminReps = res.reps;
  renderReps();
}

function renderReps() {
  const tbody = document.getElementById("reps-tbody");
  const empty = document.getElementById("reps-empty");
  empty.hidden = adminReps.length > 0;
  tbody.innerHTML = adminReps.map(function (r) {
    return '<tr>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td>' + esc(r.username) + '</td>' +
      '<td><label class="toggle-row"><input type="checkbox" class="rep-toggle" data-username="' + esc(r.username) + '" data-field="allAccess"' + (r.allAccess ? " checked" : "") + '></label></td>' +
      '<td><label class="toggle-row"><input type="checkbox" class="rep-toggle" data-username="' + esc(r.username) + '" data-field="isAdmin"' + (r.isAdmin ? " checked" : "") + '></label></td>' +
      '<td><label class="toggle-row"><input type="checkbox" class="rep-toggle" data-username="' + esc(r.username) + '" data-field="active"' + (r.active ? " checked" : "") + '></label></td>' +
      '<td class="small-muted">' + [r.preferredCity, r.preferredState, r.preferredZip].filter(Boolean).join(", ") + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<button class="btn secondary small reset-pw-btn" data-username="' + esc(r.username) + '" data-name="' + esc(r.name) + '">Reset Password</button> ' +
        '<button class="btn secondary small area-btn" data-username="' + esc(r.username) + '" data-name="' + esc(r.name) + '" data-city="' + esc(r.preferredCity) + '" data-state="' + esc(r.preferredState) + '" data-zip="' + esc(r.preferredZip) + '">Set Area</button>' +
      '</td>' +
      '</tr>';
  }).join("");

  Array.from(tbody.querySelectorAll(".rep-toggle")).forEach(function (cb) {
    cb.addEventListener("change", async function () {
      const payload = { username: cb.getAttribute("data-username") };
      payload[cb.getAttribute("data-field")] = cb.checked;
      await api("adminSetRepAccess", payload);
    });
  });

  Array.from(tbody.querySelectorAll(".reset-pw-btn")).forEach(function (btn) {
    btn.addEventListener("click", function () { openResetModal(btn.getAttribute("data-username"), btn.getAttribute("data-name")); });
  });

  Array.from(tbody.querySelectorAll(".area-btn")).forEach(function (btn) {
    btn.addEventListener("click", function () {
      openAreaModal(btn.getAttribute("data-username"), btn.getAttribute("data-name"),
        btn.getAttribute("data-city"), btn.getAttribute("data-state"), btn.getAttribute("data-zip"));
    });
  });
}

function openAreaModal(username, name, city, state, zip) {
  document.getElementById("area-modal-who").textContent = name + " (" + username + ")";
  document.getElementById("area-city-input").value = city || "";
  document.getElementById("area-state-input").value = state || "";
  document.getElementById("area-zip-input").value = zip || "";
  document.getElementById("area-modal").hidden = false;
  document.getElementById("area-modal-save").setAttribute("data-username", username);
}

document.getElementById("area-modal-cancel").addEventListener("click", function () {
  document.getElementById("area-modal").hidden = true;
});

document.getElementById("area-modal-save").addEventListener("click", async function () {
  const username = this.getAttribute("data-username");
  await api("adminSetRepPreferredArea", {
    username: username,
    city: document.getElementById("area-city-input").value.trim(),
    state: document.getElementById("area-state-input").value.trim(),
    zip: document.getElementById("area-zip-input").value.trim()
  });
  document.getElementById("area-modal").hidden = true;
  await loadReps();
});

document.getElementById("add-rep-btn").addEventListener("click", function () {
  document.getElementById("rep-name-input").value = "";
  document.getElementById("rep-username-input").value = "";
  document.getElementById("rep-password-input").value = "";
  document.getElementById("rep-allaccess-input").checked = false;
  document.getElementById("rep-isadmin-input").checked = false;
  document.getElementById("rep-modal-error").classList.remove("show");
  document.getElementById("rep-modal").hidden = false;
});

document.getElementById("rep-modal-cancel").addEventListener("click", function () {
  document.getElementById("rep-modal").hidden = true;
});

document.getElementById("rep-modal-save").addEventListener("click", async function () {
  const errorEl = document.getElementById("rep-modal-error");
  errorEl.classList.remove("show");
  const data = {
    name: document.getElementById("rep-name-input").value.trim(),
    username: document.getElementById("rep-username-input").value.trim(),
    password: document.getElementById("rep-password-input").value,
    allAccess: document.getElementById("rep-allaccess-input").checked,
    isAdmin: document.getElementById("rep-isadmin-input").checked
  };
  if (!data.name || !data.username || !data.password) {
    errorEl.textContent = "Name, username, and password are all required.";
    errorEl.classList.add("show");
    return;
  }
  const res = await api("adminAddRep", { data: data });
  if (!res.ok) {
    errorEl.textContent = res.error || "Could not add team member.";
    errorEl.classList.add("show");
    return;
  }
  document.getElementById("rep-modal").hidden = true;
  await loadReps();
});

function openResetModal(username, name) {
  document.getElementById("reset-modal-who").textContent = "New password for " + name + " (" + username + ")";
  document.getElementById("reset-password-input").value = "";
  document.getElementById("reset-modal-error").classList.remove("show");
  document.getElementById("reset-modal").hidden = false;
  document.getElementById("reset-modal-save").setAttribute("data-username", username);
}

document.getElementById("reset-modal-cancel").addEventListener("click", function () {
  document.getElementById("reset-modal").hidden = true;
});

document.getElementById("reset-modal-save").addEventListener("click", async function () {
  const username = this.getAttribute("data-username");
  const newPassword = document.getElementById("reset-password-input").value;
  const errorEl = document.getElementById("reset-modal-error");
  errorEl.classList.remove("show");
  if (!newPassword) {
    errorEl.textContent = "Enter a new password.";
    errorEl.classList.add("show");
    return;
  }
  const res = await api("adminResetPassword", { username: username, newPassword: newPassword });
  if (!res.ok) {
    errorEl.textContent = res.error || "Could not reset password.";
    errorEl.classList.add("show");
    return;
  }
  document.getElementById("reset-modal").hidden = true;
});

/* ---------- Facebook Approvals tab ---------- */

async function loadFbRequests() {
  const res = await api("adminGetFbRequests", {});
  const list = document.getElementById("fb-list");
  const empty = document.getElementById("fb-empty");
  if (!res.ok) return;
  const requests = res.requests.slice().sort(function (a, b) {
    if (a.Status === "Pending" && b.Status !== "Pending") return -1;
    if (a.Status !== "Pending" && b.Status === "Pending") return 1;
    return new Date(b.CreatedAt) - new Date(a.CreatedAt);
  });
  empty.hidden = requests.length > 0;
  list.innerHTML = requests.map(function (r) {
    const pillClass = r.Status === "Approved" ? "status-active" : r.Status === "Rejected" ? "status-dead" : "status-onhold";
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(r.CreatedAt) + " &middot; " + esc(r.Username) + " &middot; " + esc(r.address) + '</span>' +
      '<span class="status-pill ' + pillClass + '">' + esc(r.Status) + '</span>' +
      '<div style="margin-top:6px;">' + esc(r.PostText) + '</div>' +
      (r.TargetGroups ? '<div class="small-muted" style="margin-top:4px;">Groups: ' + esc(r.TargetGroups) + '</div>' : "") +
      (r.Status === "Pending"
        ? '<div style="margin-top:8px;">' +
            '<input type="text" id="fbtab-note-' + esc(r.RequestID) + '" placeholder="Optional note" style="margin-bottom:6px;">' +
            '<div class="actions">' +
              '<button class="btn small primary fbtab-decide-btn" data-request-id="' + esc(r.RequestID) + '" data-decision="Approved">Approve</button>' +
              '<button class="btn small danger fbtab-decide-btn" data-request-id="' + esc(r.RequestID) + '" data-decision="Rejected">Reject</button>' +
            '</div>' +
          '</div>'
        : (r.AdminNote ? '<div class="small-muted" style="margin-top:4px;">Admin note: ' + esc(r.AdminNote) + '</div>' : "")) +
      '</div>';
  }).join("");

  Array.from(list.querySelectorAll(".fbtab-decide-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const requestId = btn.getAttribute("data-request-id");
      const decision = btn.getAttribute("data-decision");
      const note = document.getElementById("fbtab-note-" + requestId).value.trim();
      await api("adminDecideFbRequest", { requestId: requestId, decision: decision, note: note });
      loadFbRequests();
    });
  });
}

/* ---------- Buyer Approvals tab ---------- */

const BUYER_MATCH_PRIORITY = ["Negotiating", "Closing", "Active Match", "Dead Match"];

async function loadBuyerRequests() {
  const res = await api("adminGetBuyerRequests", {});
  const list = document.getElementById("buyers-list");
  const empty = document.getElementById("buyers-empty");
  if (!res.ok) return;
  const requests = res.requests.slice().sort(function (a, b) {
    const diff = BUYER_MATCH_PRIORITY.indexOf(a.MatchStatus) - BUYER_MATCH_PRIORITY.indexOf(b.MatchStatus);
    if (diff !== 0) return diff;
    return new Date(b.CreatedAt) - new Date(a.CreatedAt);
  });
  empty.hidden = requests.length > 0;
  list.innerHTML = requests.map(function (b) {
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(b.CreatedAt) + " &middot; logged by " + esc(b.Username) + " &middot; " +
        (b.dealCode ? esc(b.dealCode) : esc(b.address)) + '</span>' +
      '<div style="margin-top:6px;"><strong>' + esc(b.BuyerName) + '</strong>' +
      (b.BuyerContact ? ' &mdash; ' + esc(b.BuyerContact) : "") + '</div>' +
      '<div style="margin-top:8px; display:flex; gap:8px; align-items:center;">' +
        '<select class="match-status-select" data-buyer-id="' + esc(b.BuyerID) + '" style="flex:1;">' +
          MATCH_STATUSES.map(function (s) { return '<option value="' + esc(s) + '"' + (s === b.MatchStatus ? " selected" : "") + '>' + esc(s) + '</option>'; }).join("") +
        '</select>' +
        '<button class="btn secondary small match-status-save-btn" data-buyer-id="' + esc(b.BuyerID) + '">Update</button>' +
      '</div>' +
      (b.Notes ? '<div style="margin-top:8px;">' + esc(b.Notes) + '</div>' : "") +
      '<input type="text" class="match-adminnote-input" data-buyer-id="' + esc(b.BuyerID) + '" value="' + esc(b.AdminNote || "") + '" placeholder="Admin note" style="margin-top:8px;">' +
      '</div>';
  }).join("");

  wireBuyerMatchListHandlers(list, loadBuyerRequests);
}

/* ---------- Buyer Leads tab ---------- */

let adminBuyerLeads = [];
let buyerLeadsActiveDeals = [];
let buyerLeadsActiveReps = [];

async function initBuyerLeadsAdminTab() {
  await Promise.all([loadBuyerLeadsAdmin(), loadAutoFeedSettings(), populateBulkGiveSelects()]);
}

async function populateBulkGiveSelects() {
  const [repsRes, dealsRes] = await Promise.all([api("adminGetReps", {}), api("getDeals", {})]);
  if (repsRes.ok) {
    buyerLeadsActiveReps = repsRes.reps.filter(function (r) { return r.active && !r.isAdmin; });
    document.getElementById("bulk-give-rep-select").innerHTML = buyerLeadsActiveReps.map(function (r) {
      return '<option value="' + esc(r.username) + '">' + esc(r.name) + ' (' + esc(r.username) + ')</option>';
    }).join("");
  }
  if (dealsRes.ok) {
    buyerLeadsActiveDeals = dealsRes.deals.filter(function (d) { return d.Status !== "Sold" && d.Status !== "Dead"; });
    document.getElementById("bulk-give-deal-select").innerHTML = buyerLeadsActiveDeals.map(function (d) {
      return '<option value="' + esc(d.DealID) + '">' + esc(d.Address) + '</option>';
    }).join("");
  }
}

document.getElementById("buyerleads-import-btn").addEventListener("click", async function () {
  const text = document.getElementById("buyerleads-import-text").value;
  const errorEl = document.getElementById("buyerleads-import-error");
  const resultEl = document.getElementById("buyerleads-import-result");
  errorEl.classList.remove("show");
  resultEl.textContent = "";
  if (!text.trim()) {
    errorEl.textContent = "Paste at least one row first.";
    errorEl.classList.add("show");
    return;
  }
  const res = await api("adminImportBuyerLeads", { pasteText: text });
  if (!res.ok) {
    errorEl.textContent = res.error || "Import failed.";
    errorEl.classList.add("show");
    return;
  }
  resultEl.textContent = "Imported " + res.imported + " buyer(s)." + (res.skippedDuplicates ? " Skipped " + res.skippedDuplicates + " duplicate phone number(s)." : "");
  document.getElementById("buyerleads-import-text").value = "";
  await loadBuyerLeadsAdmin();
});

document.getElementById("bulk-give-btn").addEventListener("click", async function () {
  const resultEl = document.getElementById("bulk-give-result");
  const dealId = document.getElementById("bulk-give-deal-select").value;
  const username = document.getElementById("bulk-give-rep-select").value;
  const count = document.getElementById("bulk-give-count").value;
  if (!dealId || !username || !count) { resultEl.textContent = "Pick a deal, a team member, and a count."; return; }
  const res = await api("adminGiveBuyerLeadsBulk", {
    dealId: dealId, username: username, count: count,
    city: document.getElementById("bulk-give-city").value.trim(),
    state: document.getElementById("bulk-give-state").value.trim(),
    zip: document.getElementById("bulk-give-zip").value.trim()
  });
  if (!res.ok) { resultEl.textContent = res.error || "Could not give leads."; return; }
  resultEl.textContent = "Gave " + res.givenCount + " lead(s) for this deal. " + res.remainingInPool + " still unpitched for it matching that filter.";
  await loadBuyerLeadsAdmin();
});

async function loadAutoFeedSettings() {
  const res = await api("adminGetAutoFeedSettings", {});
  if (!res.ok) return;
  document.getElementById("autofeed-enabled-input").checked = res.enabled;
  document.getElementById("autofeed-batchsize-input").value = res.batchSize;
}

document.getElementById("autofeed-save-btn").addEventListener("click", async function () {
  const resultEl = document.getElementById("autofeed-result");
  await api("adminSetAutoFeed", {
    enabled: document.getElementById("autofeed-enabled-input").checked,
    batchSize: document.getElementById("autofeed-batchsize-input").value
  });
  resultEl.textContent = "Settings saved.";
});

document.getElementById("autofeed-run-btn").addEventListener("click", async function () {
  const resultEl = document.getElementById("autofeed-result");
  resultEl.textContent = "Running…";
  const res = await api("adminRunAutoFeedNow", {});
  if (!res.ok) { resultEl.textContent = res.error || "Could not run auto-feed."; return; }
  if (res.reason) { resultEl.textContent = res.reason; return; }
  resultEl.textContent = res.fed.length === 0
    ? "Nobody needed more leads right now."
    : res.fed.map(function (f) { return f.name + " (" + f.dealAddress + "): +" + f.count; }).join(", ");
  await loadBuyerLeadsAdmin();
});

document.getElementById("buyerleads-search").addEventListener("input", renderBuyerLeadsAdmin);

async function loadBuyerLeadsAdmin() {
  const res = await api("adminGetBuyerLeads", {});
  if (!res.ok) return;
  adminBuyerLeads = res.leads;
  renderBuyerLeadsAdmin();
}

function renderBuyerLeadsAdmin() {
  const q = document.getElementById("buyerleads-search").value.trim().toLowerCase();
  const tbody = document.getElementById("buyerleads-tbody");
  const empty = document.getElementById("buyerleads-admin-empty");
  const filtered = adminBuyerLeads.filter(function (l) {
    if (!q) return true;
    return [l.BuyerName, l.Phone, l.Email, l.City, l.State, l.Zip].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; });
  });
  empty.hidden = filtered.length > 0;
  tbody.innerHTML = filtered.map(function (l) {
    const notesPreview = l.GeneralNotes ? (l.GeneralNotes.length > 60 ? l.GeneralNotes.slice(0, 60) + "…" : l.GeneralNotes) : "";
    return '<tr>' +
      '<td>' + esc(l.BuyerName) + '</td>' +
      '<td>' + esc(l.Phone) + '</td>' +
      '<td>' + esc(l.Email || "") + '</td>' +
      '<td>' + esc(l.PhoneType || "") + '</td>' +
      '<td>' + [l.City, l.State, l.Zip].filter(Boolean).join(", ") + '</td>' +
      '<td class="small-muted">' + esc(notesPreview) + '</td>' +
      '<td>' + (l.openPitches.length || "&mdash;") + '</td>' +
      '<td style="white-space:nowrap;"><button class="btn secondary small view-buyer-btn" data-lead-id="' + esc(l.BuyerLeadID) + '">View / Give</button></td>' +
      '</tr>';
  }).join("");

  Array.from(tbody.querySelectorAll(".view-buyer-btn")).forEach(function (btn) {
    btn.addEventListener("click", function () { openAdminBuyerLeadDetail(btn.getAttribute("data-lead-id")); });
  });
}

async function openAdminBuyerLeadDetail(buyerLeadId) {
  const lead = adminBuyerLeads.find(function (l) { return l.BuyerLeadID === buyerLeadId; });
  if (!lead) return;

  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const pitchesRes = await api("adminGetPitchesForBuyerLead", { buyerLeadId: buyerLeadId });
  const pitches = pitchesRes.ok ? pitchesRes.pitches : [];
  if (buyerLeadsActiveReps.length === 0 || buyerLeadsActiveDeals.length === 0) await populateBulkGiveSelects();

  const pitchedDealIds = {};
  pitches.forEach(function (p) { pitchedDealIds[p.DealID] = true; });
  const givableDeals = buyerLeadsActiveDeals.filter(function (d) { return !pitchedDealIds[d.DealID]; });

  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + esc(lead.BuyerName) + '</h2>' +
      '<p class="step-sub">' + esc(lead.Phone) + ' &middot; ' + esc(lead.PhoneType || "") +
      ([lead.City, lead.State, lead.Zip].filter(Boolean).length ? ' &middot; ' + [lead.City, lead.State, lead.Zip].filter(Boolean).join(", ") : "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +

    '<label class="field-label" style="margin-top:0;">Email</label>' +
    '<input type="text" id="admin-buyer-email-input" value="' + esc(lead.Email || "") + '" placeholder="buyer@example.com">' +
    '<label class="field-label">Buyer Documents Drive Link <span class="small-muted">(proof of funds, signed agreements, etc.)</span></label>' +
    '<input type="text" id="admin-buyer-drivelink-input" value="' + esc(lead.DriveLink || "") + '" placeholder="https://drive.google.com/...">' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="admin-buyer-profile-save-btn">Save Email / Drive Link</button>' +
    '</div>' +

    '<div class="section-title">General Buyer Notes</div>' +
    '<p class="small-muted">Shared across every deal this buyer is ever pitched — ARV%, price range, areas of interest, cash vs. financed, etc.</p>' +
    '<textarea id="admin-general-notes-input">' + esc(lead.GeneralNotes || "") + '</textarea>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="admin-general-notes-save-btn">Save Notes</button>' +
    '</div>' +

    '<div class="section-title">Give For a New Deal</div>' +
    (givableDeals.length > 0
      ? '<div class="row2">' +
          '<div><select id="give-new-deal-select">' + givableDeals.map(function (d) { return '<option value="' + esc(d.DealID) + '">' + esc(d.Address) + '</option>'; }).join("") + '</select></div>' +
          '<div><select id="give-new-rep-select">' + buyerLeadsActiveReps.map(function (r) { return '<option value="' + esc(r.username) + '">' + esc(r.name) + '</option>'; }).join("") + '</select></div>' +
        '</div>' +
        '<div class="nav-row" style="justify-content:flex-end;"><button class="btn primary small" id="give-new-pitch-btn">Give This Buyer Lead To</button></div>'
      : '<p class="small-muted">This buyer already has an open pitch on every active deal, or there are no active deals yet.</p>') +

    '<div class="section-title">Pitches</div>' +
    '<div id="pitches-list">' + renderAdminPitchesList(pitches) + '</div>';

  document.getElementById("close-detail-btn").addEventListener("click", function () { overlay.hidden = true; loadBuyerLeadsAdmin(); });

  document.getElementById("admin-general-notes-save-btn").addEventListener("click", async function () {
    await api("updateBuyerLeadNotes", { buyerLeadId: buyerLeadId, notes: document.getElementById("admin-general-notes-input").value.trim() });
    await loadBuyerLeadsAdmin();
  });

  document.getElementById("admin-buyer-profile-save-btn").addEventListener("click", async function () {
    await api("adminUpdateBuyerLeadProfile", {
      buyerLeadId: buyerLeadId,
      email: document.getElementById("admin-buyer-email-input").value.trim(),
      driveLink: document.getElementById("admin-buyer-drivelink-input").value.trim()
    });
    await loadBuyerLeadsAdmin();
  });

  const giveBtn = document.getElementById("give-new-pitch-btn");
  if (giveBtn) {
    giveBtn.addEventListener("click", async function () {
      const dealId = document.getElementById("give-new-deal-select").value;
      const username = document.getElementById("give-new-rep-select").value;
      const res = await api("adminGiveBuyerLeadToRep", { buyerLeadId: buyerLeadId, dealId: dealId, username: username });
      if (res.ok) openAdminBuyerLeadDetail(buyerLeadId);
    });
  }

  wireAdminPitchActions(buyerLeadId);
}

function renderAdminPitchesList(pitches) {
  if (pitches.length === 0) return '<p class="small-muted">No pitches given yet.</p>';
  return pitches.slice().reverse().map(function (p) {
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(p.GivenAt) + ' &middot; given to ' + esc(p.Username) + '</span>' +
      '<div style="margin-top:4px;"><strong>Re:</strong> ' + esc(p.dealAddress) + '</div>' +
      '<div style="margin-top:6px;">' +
        (p.dealStillActive
          ? '<span class="status-pill ' + statusClass(p.status) + '">' + esc(p.status) + '</span>'
          : '<span class="status-pill status-fully-worked">Deal ' + esc((p.dealStatus || "closed").toLowerCase()) + '</span>') +
      '</div>' +
      '<div style="display:flex; gap:8px; margin-top:8px;">' +
        '<select class="pitch-reassign-select" data-pitch-id="' + esc(p.PitchID) + '" style="flex:1;">' +
          buyerLeadsActiveReps.map(function (r) { return '<option value="' + esc(r.username) + '"' + (r.username === p.Username ? " selected" : "") + '>' + esc(r.name) + '</option>'; }).join("") +
        '</select>' +
        '<button class="btn secondary small pitch-reassign-btn" data-pitch-id="' + esc(p.PitchID) + '">Give to</button>' +
        '<button class="btn secondary small pitch-withdraw-btn" data-pitch-id="' + esc(p.PitchID) + '">Withdraw</button>' +
        '<button class="btn secondary small pitch-history-btn" data-pitch-id="' + esc(p.PitchID) + '">History</button>' +
      '</div>' +
      '<div class="pitch-history-container" data-pitch-id="' + esc(p.PitchID) + '" hidden></div>' +
      '</div>';
  }).join("");
}

function wireAdminPitchActions(buyerLeadId) {
  const panel = document.getElementById("detail-panel");
  Array.from(panel.querySelectorAll(".pitch-reassign-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const pitchId = btn.getAttribute("data-pitch-id");
      const select = panel.querySelector('.pitch-reassign-select[data-pitch-id="' + pitchId + '"]');
      await api("adminReassignPitch", { pitchId: pitchId, username: select.value });
      openAdminBuyerLeadDetail(buyerLeadId);
    });
  });
  Array.from(panel.querySelectorAll(".pitch-withdraw-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      await api("adminWithdrawPitch", { pitchId: btn.getAttribute("data-pitch-id") });
      openAdminBuyerLeadDetail(buyerLeadId);
    });
  });
  Array.from(panel.querySelectorAll(".pitch-history-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const pitchId = btn.getAttribute("data-pitch-id");
      const container = panel.querySelector('.pitch-history-container[data-pitch-id="' + pitchId + '"]');
      if (!container.hidden) { container.hidden = true; return; }
      const res = await api("adminGetPitchContacts", { pitchId: pitchId });
      container.innerHTML = renderContactHistory(res.ok ? res.contacts : []);
      container.hidden = false;
    });
  });
}

/* ---------- Status categories tab ---------- */

async function loadStatusOptions() {
  const res = await api("getStatusOptions", {});
  if (!res.ok) return;
  statusOptionsCache = res.statuses;
  const list = document.getElementById("status-chip-list");
  if (!list) return;
  list.innerHTML = statusOptionsCache.map(function (s) {
    return '<span class="chip">' + esc(s) + '<button data-status="' + esc(s) + '" class="remove-status-btn">&times;</button></span>';
  }).join("");
  Array.from(list.querySelectorAll(".remove-status-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      await api("adminRemoveStatusOption", { status: btn.getAttribute("data-status") });
      loadStatusOptions();
    });
  });
}

document.getElementById("add-status-btn").addEventListener("click", async function () {
  const input = document.getElementById("new-status-input");
  const status = input.value.trim();
  if (!status) return;
  const res = await api("adminAddStatusOption", { status: status });
  if (res.ok) {
    input.value = "";
    loadStatusOptions();
  }
});
