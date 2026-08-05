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
    return [d.Address, d.City, d.AssetType].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; });
  });
  empty.hidden = filtered.length > 0;
  container.innerHTML = filtered.map(function (d) {
    return '<div class="deal-card" data-deal-id="' + esc(d.DealID) + '">' +
      '<div class="addr">' + esc(d.Address) + (d.City ? ", " + esc(d.City) : "") + '</div>' +
      '<div class="meta">' + esc(d.AssetType || "") + (d.Price ? " &middot; " + esc(d.Price) : "") +
      ' <span class="status-pill ' + statusClass(d.Status) + '">' + esc(d.Status || "") + '</span></div>' +
      '</div>';
  }).join("");
  Array.from(container.querySelectorAll(".deal-card")).forEach(function (card) {
    card.addEventListener("click", function () { openRepDealDetail(card.getAttribute("data-deal-id")); });
  });
}

async function openRepDealDetail(dealId) {
  const deal = repDeals.find(function (d) { return d.DealID === dealId; });
  if (!deal) return;

  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const [buyersRes, fbRes] = await Promise.all([
    api("getInterestedBuyers", { dealId: dealId }),
    api("getMyFbRequests", { dealId: dealId })
  ]);
  const buyers = buyersRes.ok ? buyersRes.buyers : [];
  const fbRequests = fbRes.ok ? fbRes.requests : [];

  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + esc(deal.Address) + '</h2>' +
      '<p class="step-sub">' + esc(deal.City || "") + (deal.State ? ", " + esc(deal.State) : "") + ' ' + esc(deal.Zip || "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +
    '<div class="banner info">' +
      '<span class="status-pill ' + statusClass(deal.Status) + '">' + esc(deal.Status || "") + '</span>' +
      (deal.AssetType ? '<div style="margin-top:8px;"><strong>Asset Type:</strong> ' + esc(deal.AssetType) + '</div>' : "") +
      (deal.Price ? '<div><strong>Price:</strong> ' + esc(deal.Price) + '</div>' : "") +
      (deal.Description ? '<div style="margin-top:8px;">' + esc(deal.Description) + '</div>' : "") +
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
    '<div id="buyer-list">' + renderBuyerList(buyers) + '</div>';

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
    const fresh = await api("getInterestedBuyers", { dealId: dealId });
    document.getElementById("buyer-list").innerHTML = renderBuyerList(fresh.ok ? fresh.buyers : []);
  });
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

function renderBuyerList(buyers) {
  if (buyers.length === 0) return '<p class="small-muted">No interested buyers logged yet.</p>';
  return buyers.slice().reverse().map(function (b) {
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(b.CreatedAt) + ' &middot; added by ' + esc(b.Username) + '</span>' +
      '<strong>' + esc(b.BuyerName) + '</strong>' +
      (b.BuyerContact ? ' &mdash; ' + esc(b.BuyerContact) : "") +
      (b.Notes ? '<div style="margin-top:4px;">' + esc(b.Notes) + '</div>' : "") +
      '</div>';
  }).join("");
}

/* ============================================================
   ADMIN VIEW
   ============================================================ */

let adminDeals = [];
let adminReps = [];

Array.from(document.querySelectorAll(".tab-btn")).forEach(function (btn) {
  btn.addEventListener("click", function () { switchAdminTab(btn.getAttribute("data-tab")); });
});

function switchAdminTab(tab) {
  Array.from(document.querySelectorAll(".tab-btn")).forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  });
  ["deals", "team", "fb", "statuses"].forEach(function (t) {
    document.getElementById("tab-" + t).hidden = t !== tab;
  });
  if (tab === "team") loadReps();
  if (tab === "fb") loadFbRequests();
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
    return [d.Address, d.City, d.AssetType, d.Status].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; });
  });
  empty.hidden = filtered.length > 0;
  tbody.innerHTML = filtered.map(function (d) {
    return '<tr class="clickable" data-deal-id="' + esc(d.DealID) + '">' +
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
  document.getElementById("deal-address-input").value = "";
  document.getElementById("deal-city-input").value = "";
  document.getElementById("deal-state-input").value = "";
  document.getElementById("deal-zip-input").value = "";
  document.getElementById("deal-assettype-input").value = "";
  document.getElementById("deal-price-input").value = "";
  document.getElementById("deal-description-input").value = "";
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
    address: address,
    city: document.getElementById("deal-city-input").value.trim(),
    state: document.getElementById("deal-state-input").value.trim(),
    zip: document.getElementById("deal-zip-input").value.trim(),
    assetType: document.getElementById("deal-assettype-input").value.trim(),
    price: document.getElementById("deal-price-input").value.trim(),
    status: document.getElementById("deal-status-input").value,
    description: document.getElementById("deal-description-input").value.trim()
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
      '<p class="step-sub">' + esc(deal.City || "") + (deal.State ? ", " + esc(deal.State) : "") + ' ' + esc(deal.Zip || "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +

    '<label class="field-label">Status</label>' +
    '<select id="deal-status-select">' +
      statusOptionsCache.map(function (s) { return '<option value="' + esc(s) + '"' + (s === deal.Status ? " selected" : "") + '>' + esc(s) + '</option>'; }).join("") +
    '</select>' +

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

    '<div class="section-title">Interested Buyers</div>' +
    renderBuyerList(buyers) +

    '<label class="field-label" style="margin-top:24px;">Description / Notes</label>' +
    '<textarea id="deal-desc-edit">' + esc(deal.Description || "") + '</textarea>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="save-desc-btn">Save Notes</button>' +
    '</div>';

  document.getElementById("close-detail-btn").addEventListener("click", function () { overlay.hidden = true; loadAdminDeals(); });

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
      '<td><button class="btn secondary small reset-pw-btn" data-username="' + esc(r.username) + '" data-name="' + esc(r.name) + '">Reset Password</button></td>' +
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
}

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
