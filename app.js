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

// A visible confirmation that a click actually registered -- separate from
// (and in addition to) any inline result text, since a small line of text
// under a button is easy to miss and is exactly what leads to a second,
// duplicate click "just in case."
function showToast(message, isError) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast" + (isError ? " error" : "");
  toast.innerHTML = '<span class="toast-icon">' + (isError ? "&#10005;" : "&#10003;") + '</span><span>' + esc(message) + '</span>';
  container.appendChild(toast);
  requestAnimationFrame(function () { toast.classList.add("show"); });
  setTimeout(function () {
    toast.classList.remove("show");
    setTimeout(function () { toast.remove(); }, 200);
  }, 2800);
}

// GrossMargin/AsIsEquity come from the backend as plain numbers (or null
// if the fields behind them aren't all set yet) -- this just formats
// either for display, with a distinct message for the "not enough info
// yet" case.
function formatComputedMargin(value, missingHint) {
  if (value === null || value === undefined) return "&mdash; (needs " + missingHint + ")";
  const rounded = Math.round(value);
  return (rounded < 0 ? "-$" + Math.abs(rounded).toLocaleString() : "$" + rounded.toLocaleString());
}
function formatGrossMargin(value) {
  return formatComputedMargin(value, "ARV, Rehab Estimate, and Price");
}
function formatAsIsEquity(value) {
  return formatComputedMargin(value, "As-Is Value and Price");
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
["login-view", "rep-view", "admin-view", "who-label", "header-support-label", "logout-btn", "switch-view-btn"].forEach(function (id) {
  els[id] = document.getElementById(id);
});

// Same "Want to Join?" phone number used pre-login and for the
// Wholesaler/Realtor/Other interested-buyer text-SOP -- also shown as a
// general support contact in the header once any rep is logged in, not
// just those two other places. Admin doesn't need to see it (they're the
// ones who set it). Called both from showView (session changes) and once
// loadJoinContact resolves, since whichever of the two loads last is what
// actually has the data to show.
function updateHeaderSupportLabel() {
  const session = getSession();
  if (session && !session.isAdmin && joinContactCache && joinContactCache.phone) {
    els["header-support-label"].textContent = "Support: " + joinContactCache.phone;
    els["header-support-label"].hidden = false;
  } else {
    els["header-support-label"].hidden = true;
  }
}

// Lets an admin drop into the same screens a rep uses -- handy while the
// rep side is still being built out / the team is still small, so admin
// can work deals themselves without needing a second login. Purely a
// display toggle: the session and its permissions never change, admin
// just chooses which UI to look at. Resets to the admin view on logout /
// next login rather than persisting, so it's always the default.
let adminActingAsRep = false;

function showView(session) {
  els["login-view"].hidden = !!session;
  els["rep-view"].hidden = true;
  els["admin-view"].hidden = true;
  els["who-label"].hidden = !session;
  els["logout-btn"].hidden = !session;
  els["switch-view-btn"].hidden = !session || !session.isAdmin;
  updateHeaderSupportLabel();

  if (!session) return;
  els["who-label"].textContent = session.name + (session.isAdmin ? " (Admin)" : "");

  if (session.isAdmin && !adminActingAsRep) {
    els["switch-view-btn"].textContent = "Work as Rep";
    els["admin-view"].hidden = false;
    initAdminView();
  } else {
    els["switch-view-btn"].textContent = "Back to Admin";
    els["rep-view"].hidden = false;
    initRepView();
  }
}

document.getElementById("switch-view-btn").addEventListener("click", function () {
  adminActingAsRep = !adminActingAsRep;
  showView(getSession());
});

document.getElementById("logout-btn").addEventListener("click", function () {
  adminActingAsRep = false;
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

/* ---------- Sign Up / Forgot Password (login screen) ---------- */

document.getElementById("show-signup-link").addEventListener("click", function () {
  document.getElementById("login-form-card").hidden = true;
  document.getElementById("signup-form-card").hidden = false;
});
document.getElementById("show-login-link").addEventListener("click", function () {
  document.getElementById("signup-form-card").hidden = true;
  document.getElementById("login-form-card").hidden = false;
});

// Same contact info as the "Want to Join?" card below -- support for
// forgot-password is deliberately this same admin-configurable contact,
// not a separate concept, and not a self-service reset link (there's no
// email-sending flow for that; someone has to know it's really you).
let joinContactCache = null;
document.getElementById("forgot-password-link").addEventListener("click", function () {
  const textEl = document.getElementById("forgot-password-text");
  const parts = [];
  if (joinContactCache) {
    if (joinContactCache.name) parts.push(esc(joinContactCache.name));
    if (joinContactCache.phone) parts.push(esc(joinContactCache.phone));
    if (joinContactCache.email) parts.push('<a href="mailto:' + esc(joinContactCache.email) + '">' + esc(joinContactCache.email) + '</a>');
  }
  textEl.innerHTML = parts.length > 0
    ? '<strong>Forgot your password?</strong> Contact ' + parts.join(" &middot; ") + ' to have it reset.'
    : '<strong>Forgot your password?</strong> Contact your admin to have it reset.';
  textEl.hidden = false;
});

document.getElementById("signup-btn").addEventListener("click", async function () {
  const btn = this;
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const phone = document.getElementById("signup-phone").value.trim();
  const personType = document.getElementById("signup-persontype").value;
  const password = document.getElementById("signup-password").value;
  const confirm = document.getElementById("signup-confirm").value;
  const errorEl = document.getElementById("signup-error");
  errorEl.classList.remove("show");
  if (!name || !email || !password) {
    errorEl.textContent = "Name, email, and password are required.";
    errorEl.classList.add("show");
    return;
  }
  if (!personType) {
    errorEl.textContent = "Select what best describes you.";
    errorEl.classList.add("show");
    return;
  }
  if (password.length < 8) {
    errorEl.textContent = "Password must be at least 8 characters.";
    errorEl.classList.add("show");
    return;
  }
  if (password !== confirm) {
    errorEl.textContent = "Passwords don't match.";
    errorEl.classList.add("show");
    return;
  }
  if (btn.disabled) return;
  btn.disabled = true;
  const signupRes = await api("publicSignup", { name: name, email: email, phone: phone, personType: personType, password: password });
  if (!signupRes.ok) {
    btn.disabled = false;
    errorEl.textContent = signupRes.error || "Could not create your account.";
    errorEl.classList.add("show");
    return;
  }
  // Active immediately -- log straight in with the same credentials
  // instead of bouncing them back to a login form to retype everything.
  const loginRes = await api("login", { username: email, password: password });
  btn.disabled = false;
  if (!loginRes.ok) {
    document.getElementById("signup-form-card").hidden = true;
    document.getElementById("login-form-card").hidden = false;
    document.getElementById("login-username").value = email;
    showToast("Account created — log in below.");
    return;
  }
  setSession(loginRes);
  showView(loginRes);
  showToast("Welcome! Your account is ready.");
});

showView(getSession());

// Shown on the login page for anyone without an account yet -- loads
// regardless of session state since it has to render before login.
(async function loadJoinContact() {
  const res = await api("getJoinContact", {});
  if (!res.ok) return;
  joinContactCache = res;
  updateHeaderSupportLabel();
  const parts = [];
  if (res.name) parts.push(esc(res.name));
  if (res.phone) parts.push(esc(res.phone));
  if (res.email) parts.push('<a href="mailto:' + esc(res.email) + '">' + esc(res.email) + '</a>');
  if (parts.length === 0) return;
  document.getElementById("join-contact-text").innerHTML = '<strong>Want to join and get deals?</strong> Contact ' + parts.join(" &middot; ");
  document.getElementById("join-contact-card").hidden = false;
})();

/* ============================================================
   REP VIEW
   ============================================================ */

let repDeals = [];
let statusOptionsCache = [];

async function initRepView() {
  // These three are independent -- fire them together instead of waiting
  // on each round trip in turn, since each Apps Script call is its own
  // (fairly slow) network hop.
  const [statusRes, catRes, res] = await Promise.all([
    api("getStatusOptions", {}),
    api("getAssetCategoryOptions", {}),
    api("getDeals", {})
  ]);
  if (statusRes.ok) statusOptionsCache = statusRes.statuses;
  if (catRes.ok) assetCategoryOptionsCache = catRes.categories;
  if (!res.ok) {
    setSession(null);
    showView(null);
    return;
  }
  repDeals = res.deals;
  renderRepDeals();

  const session = getSession() || {};
  // A Buyer signup isn't out hunting for buyers themselves -- skip the
  // whole "build your own list" card and guide for them. Everyone else
  // (blank/Wholesaler/Realtor/Other) gets it.
  document.getElementById("rep-buyerlist-card").hidden = session.personType === "Buyer";
  // The text-in SOP is specifically for the three self-identified outside
  // contributor types, not a traditional admin-added rep (blank) or a
  // Buyer -- and only shows once there's an actual phone number to text.
  const textSopApplies = ["Wholesaler", "Realtor", "Other"].indexOf(session.personType) !== -1;
  const textSopRow = document.getElementById("rep-text-sop-row");
  if (textSopApplies && joinContactCache && joinContactCache.phone) {
    document.getElementById("rep-text-sop-phone").textContent = joinContactCache.phone;
    textSopRow.hidden = false;
  } else {
    textSopRow.hidden = true;
  }
}

document.getElementById("rep-search-input").addEventListener("input", renderRepDeals);

// Ranks a deal's Status by how close it is to actually closing, lowest
// number first: Under Contract (a buyer's already locked in, just needs to
// close) > Active (still being marketed) > On Hold (paused, not dead) >
// Sold (already closed -- done, no more action needed, but a good outcome
// worth keeping visible rather than lumped in with Dead) > Dead (fell
// through, sinks to the very bottom). Admin can rename/add statuses
// (Status Categories tab), so an unrecognized value falls back to
// somewhere in the middle rather than breaking the sort.
const DEAL_STATUS_PRIORITY = ['Under Contract', 'Active', 'On Hold', 'Sold', 'Dead'];
function dealStatusRank(status) {
  const idx = DEAL_STATUS_PRIORITY.indexOf(status);
  return idx === -1 ? 1.5 : idx;
}

function renderRepDeals() {
  const q = document.getElementById("rep-search-input").value.trim().toLowerCase();
  const container = document.getElementById("rep-deals-container");
  const empty = document.getElementById("rep-deals-empty");
  const filtered = repDeals.filter(function (d) {
    if (!q) return true;
    return [d.DealCode, d.City, d.State, d.County, d.AssetType].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; });
  });
  // Organized by how close to closing the deal is first (Under Contract,
  // then Active, On Hold, Sold, Dead sinks to the bottom), then State
  // alphabetically, then City within that state, then County as a final
  // tiebreaker -- so the deals actually worth working land at the top, and
  // within that a rep still sees deals in the same area clustered
  // together instead of in whatever order they happened to be added.
  filtered.sort(function (a, b) {
    return dealStatusRank(a.Status) - dealStatusRank(b.Status) ||
      String(a.State || "").localeCompare(String(b.State || "")) ||
      String(a.City || "").localeCompare(String(b.City || "")) ||
      String(a.County || "").localeCompare(String(b.County || ""));
  });
  empty.hidden = filtered.length > 0;
  container.innerHTML = filtered.map(function (d) {
    // Deal Code stays visible here no matter what -- it's the one label
    // that also shows on this buyer's Buyer Leads / Pitches tab (which
    // never shows the address, disclosed or not), so it's what actually
    // lets a rep match "this pitch" to "this deal" at a glance. Without
    // it, a rep with address access sees only the street address here but
    // only "Re: AZ-3 Land" over on Buyer Leads, with nothing tying them
    // together.
    const codeTag = d.DealCode ? '<span class="status-pill status-default" style="margin-right:6px;">' + esc(d.DealCode) + '</span>' : "";
    // Full address (street, city, state, zip) once disclosed, not just
    // street+city -- with several similar deals in the same asset class on
    // screen at once, a rep scrolling this list needs enough here to tell
    // them apart and go straight into calls without opening each one just
    // to check which is which.
    const heading = d.Address
      ? esc(d.Address) + (d.City ? ", " + esc(d.City) : "") + (d.State ? ", " + esc(d.State) : "") + (d.Zip ? " " + esc(d.Zip) : "")
      : (d.City ? esc(d.City) + (d.State ? ", " + esc(d.State) : "") : "Deal");
    // County is visible to reps whether or not the address itself has been
    // disclosed (only the exact street address is ever gated) -- shown here
    // too so it's not something only the detail panel reveals.
    const countyLine = d.County ? '<div class="small-muted">' + esc(d.County) + ' County</div>' : "";
    return '<div class="deal-card" data-deal-id="' + esc(d.DealID) + '">' +
      '<div class="addr">' + codeTag + heading + '</div>' +
      countyLine +
      '<div class="meta">' + esc(d.AssetType || "") + (d.Price ? " &middot; " + esc(d.Price) : "") +
      ' <span class="status-pill ' + statusClass(d.Status) + '">' + esc(d.Status || "") + '</span>' +
      (d.addressGranted ? ' <span class="status-pill status-active-match">Address disclosed</span>' : "") + '</div>' +
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

  const addressBanner = deal.addressGranted && deal.Address
    ? '<div class="banner danger"><strong>Confidential &mdash; do not share.</strong> Admin has given you access to this deal\'s exact address. Only share it with a legitimate, matched buyer' +
      ' &mdash; and only with admin approval, once that buyer has expressed real interest and specifically wants to review the full address. Sharing it any earlier, or with anyone else,' +
      ' risks losing us this deal and getting paid on it, and will get you removed as a dispositions team member.</div>'
    : "";

  // Same reasoning as the deal card: keep the Deal Code visible here
  // (in the subtitle, not fighting the address for the big heading) no
  // matter whether the address is shown, since it's the only thing that
  // also appears on this rep's Buyer Leads / Pitches tab to match against.
  const codeTag = deal.DealCode ? '<span class="status-pill status-default" style="margin-right:6px;">' + esc(deal.DealCode) + '</span>' : "";
  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + (deal.Address ? esc(deal.Address) : (deal.City ? esc(deal.City) : "Deal")) + '</h2>' +
      '<p class="step-sub">' + codeTag + [deal.City, deal.State].filter(Boolean).join(", ") + (deal.Zip ? " " + esc(deal.Zip) : "") +
      (deal.County ? " &middot; " + esc(deal.County) + " County" : "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +
    addressBanner +
    '<div class="banner info">' +
      '<span class="status-pill ' + statusClass(deal.Status) + '">' + esc(deal.Status || "") + '</span>' +
      (deal.AssetType ? '<div style="margin-top:8px;"><strong>Asset Type:</strong> ' + esc(deal.AssetType) + '</div>' : "") +
      (deal.Price ? '<div><strong>Price:</strong> ' + esc(deal.Price) + '</div>' : "") +
      (deal.ARV ? '<div><strong>ARV:</strong> ' + esc(deal.ARV) + '</div>' : "") +
      (deal.RehabEstimate ? '<div><strong>Rehab Estimate:</strong> ' + esc(deal.RehabEstimate) + '</div>' : "") +
      (deal.ARV || deal.RehabEstimate ? '<div><strong>Gross Margin:</strong> ' + formatGrossMargin(deal.GrossMargin) + '</div>' : "") +
      (deal.AsIsValue ? '<div><strong>As-Is Value:</strong> ' + esc(deal.AsIsValue) + '</div>' : "") +
      (deal.AsIsValue ? '<div><strong>As-Is Equity:</strong> ' + formatAsIsEquity(deal.AsIsEquity) + '</div>' : "") +
      (deal.Description ? '<div style="margin-top:8px;">' + esc(deal.Description) + '</div>' : "") +
      (deal.GeneralDriveLink ? '<div style="margin-top:8px;"><a href="' + esc(deal.GeneralDriveLink) + '" target="_blank" rel="noopener">Open Drive Folder</a></div>' : "") +
      (!deal.Address ? '<div style="margin-top:10px;"><button class="btn secondary small" id="request-address-btn" data-deal-id="' + esc(deal.DealID) + '">Request Address Access</button>' +
        '<div class="small-muted" style="margin-top:6px;">Pitch off the general deal info first — only use this once a buyer has responded, is genuinely interested, and specifically asks you for the address. This just emails admin to ask; it does not grant it.</div></div>' : "") +
    '</div>' +

    '<div class="section-title">Match My Buyer Leads To This Deal</div>' +
    '<p class="small-muted">Auto-matches buyer leads you can see (your own uploads, plus anything shared by the team) to this deal by state/city/asset category — same matching admin uses — and gives them to yourself, so they show up on your Buyer Leads tab to start calling.</p>' +
    '<div class="row2">' +
      '<div><label class="field-label">How many</label><input type="number" id="give-myself-count" value="25" min="1"></div>' +
      '<div style="display:flex; align-items:flex-end;"><button class="btn secondary" id="give-myself-btn" style="width:100%;">Match &amp; Give To Myself</button></div>' +
    '</div>' +
    '<div id="give-myself-result" class="small-muted"></div>' +

    '<div class="section-title">Step 1 &middot; Submit a Facebook Post for Approval</div>' +
    '<p class="small-muted">Want to cold email buyers about this deal instead? Talk to admin first — there\'s a specific approach we use so those emails don\'t land in spam.</p>' +
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
    '<div class="row2">' +
      '<div><label class="field-label">% of ARV interested at <span class="small-muted">(if known)</span></label><input type="text" id="buyer-arvpercent-input" placeholder="e.g. 70"></div>' +
      '<div><label class="field-label">% of As-Is Value <span class="small-muted">(if known)</span></label><input type="text" id="buyer-asispercent-input" placeholder="e.g. 85"></div>' +
    '</div>' +
    '<label class="field-label">Notes (optional)</label>' +
    '<textarea id="buyer-notes-input"></textarea>' +
    '<div class="error-text" id="buyer-add-error"></div>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn primary" id="buyer-add-submit">Add Interested Buyer</button>' +
    '</div>' +
    '<div id="buyer-list">' + renderBuyerMatchList(buyers) + '</div>';

  wireBuyerMatchListHandlers(document.getElementById("buyer-list"), function () { return refreshBuyerMatchList(dealId, "buyer-list"); });
  wireRequestAddressButton();

  document.getElementById("give-myself-btn").addEventListener("click", async function () {
    const btn = this;
    const resultEl = document.getElementById("give-myself-result");
    const count = document.getElementById("give-myself-count").value;
    if (!count) { resultEl.textContent = "Enter how many to match."; return; }
    if (btn.disabled) return;
    btn.disabled = true;
    const res = await api("giveMyBuyerLeads", { dealId: dealId, count: count });
    btn.disabled = false;
    if (!res.ok) { resultEl.textContent = res.error || "Could not match leads."; showToast(res.error || "Could not match leads.", true); return; }
    resultEl.textContent = "Gave yourself " + res.givenCount + " lead(s) for this deal. " + res.remainingInPool + " still unmatched for it.";
    showToast("Gave yourself " + res.givenCount + " lead(s) — check your Buyer Leads tab.");
  });

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
    showToast("Post submitted for approval.");
  });

  document.getElementById("buyer-add-submit").addEventListener("click", async function () {
    const buyerName = document.getElementById("buyer-name-input").value.trim();
    const contact = document.getElementById("buyer-contact-input").value.trim();
    const arvPercent = document.getElementById("buyer-arvpercent-input").value.trim();
    const asIsPercent = document.getElementById("buyer-asispercent-input").value.trim();
    const notes = document.getElementById("buyer-notes-input").value.trim();
    const errorEl = document.getElementById("buyer-add-error");
    errorEl.classList.remove("show");
    if (!buyerName) {
      errorEl.textContent = "Enter the buyer's name.";
      errorEl.classList.add("show");
      return;
    }
    const res = await api("addInterestedBuyer", { dealId: dealId, buyerName: buyerName, buyerContact: contact, arvPercent: arvPercent, asIsPercent: asIsPercent, notes: notes });
    if (!res.ok) {
      errorEl.textContent = res.error || "Could not add buyer.";
      errorEl.classList.add("show");
      return;
    }
    document.getElementById("buyer-name-input").value = "";
    document.getElementById("buyer-contact-input").value = "";
    document.getElementById("buyer-arvpercent-input").value = "";
    document.getElementById("buyer-asispercent-input").value = "";
    document.getElementById("buyer-notes-input").value = "";
    await refreshBuyerMatchList(dealId);
    showToast("Buyer added.");
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
      '<div class="row2" style="margin-top:8px;">' +
        '<div><label class="field-label">% of ARV</label><input type="text" class="match-arvpercent-input" data-buyer-id="' + esc(b.BuyerID) + '" value="' + esc(b.ARVPercent || "") + '" placeholder="e.g. 70"></div>' +
        '<div><label class="field-label">% of As-Is Value</label><input type="text" class="match-asispercent-input" data-buyer-id="' + esc(b.BuyerID) + '" value="' + esc(b.AsIsPercent || "") + '" placeholder="e.g. 85"></div>' +
      '</div>' +
      '<p class="small-muted" style="margin:2px 0 0;">Saved along with Update above.</p>' +
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
      const arvInput = container.querySelector('.match-arvpercent-input[data-buyer-id="' + buyerId + '"]');
      const asIsInput = container.querySelector('.match-asispercent-input[data-buyer-id="' + buyerId + '"]');
      const payload = { buyerId: buyerId, matchStatus: select.value };
      if (adminNoteInput) payload.adminNote = adminNoteInput.value.trim();
      if (arvInput) payload.arvPercent = arvInput.value.trim();
      if (asIsInput) payload.asIsPercent = asIsInput.value.trim();
      btn.disabled = true;
      await api("updateInterestedBuyerMatchStatus", payload);
      showToast("Match updated.");
      await onSaved();
    });
  });
  Array.from(container.querySelectorAll(".match-notes-save-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const buyerId = btn.getAttribute("data-buyer-id");
      const textarea = container.querySelector('.match-notes-input[data-buyer-id="' + buyerId + '"]');
      btn.disabled = true;
      await api("updateInterestedBuyerNotes", { buyerId: buyerId, notes: textarea.value.trim() });
      btn.disabled = false;
      showToast("Notes saved.");
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
const MY_PITCHES_PAGE_SIZE = 50;
let myPitchesCurrentPage = 1;
// Purely a local "don't lose my place" bookmark while scrolling through a
// long list and cross-checking a deal open elsewhere -- not saved to the
// backend or tied to anything about the pitch itself, so it's fine that it
// resets on reload. A rep can mark more than one row at a time (e.g.
// tracking a couple of names while working down the list).
let markedPitchIds = new Set();

async function loadMyPitches() {
  const res = await api("getMyPitches", {});
  if (!res.ok) return;
  myPitches = res.pitches;
  populateMyPitchesDealFilter();
  renderMyPitches();
}

// Rebuilds the Deal filter's options from whatever deals this rep actually
// has pitches on right now -- lets them scroll straight to just the buyer
// leads matched for one specific deal instead of the whole list. Preserves
// the current selection across a reload as long as that deal still exists.
function populateMyPitchesDealFilter() {
  const select = document.getElementById("mypitches-filter-deal");
  const prevValue = select.value;
  const seen = {};
  const deals = [];
  myPitches.forEach(function (p) {
    if (seen[p.DealID]) return;
    seen[p.DealID] = true;
    deals.push({ id: p.DealID, label: p.dealCode || "Deal" });
  });
  deals.sort(function (a, b) { return a.label.localeCompare(b.label); });
  select.innerHTML = '<option value="">All Deals</option>' +
    deals.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.label) + '</option>'; }).join("");
  if (deals.some(function (d) { return d.id === prevValue; })) select.value = prevValue;
}

function getFilteredSortedMyPitches() {
  const q = document.getElementById("mypitches-search").value.trim().toLowerCase();
  const dealId = document.getElementById("mypitches-filter-deal").value;
  const status = document.getElementById("mypitches-filter-status").value;
  const sortMode = document.getElementById("mypitches-sort").value;

  const filtered = myPitches.filter(function (p) {
    if (q && ![p.buyerName, p.phone, p.city, p.state, p.dealCode].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; })) return false;
    if (dealId && p.DealID !== dealId) return false;
    if (status && p.status !== status) return false;
    return true;
  });

  const comparator =
    sortMode === "deal" ? function (a, b) { return String(a.dealCode || "").localeCompare(String(b.dealCode || "")); } :
    sortMode === "newest" ? function (a, b) { return new Date(b.GivenAt || 0) - new Date(a.GivenAt || 0); } :
    sortMode === "oldest" ? function (a, b) { return new Date(a.GivenAt || 0) - new Date(b.GivenAt || 0); } :
    function (a, b) {
      if (a.dealStillActive !== b.dealStillActive) return a.dealStillActive ? -1 : 1;
      return LEAD_STATUS_PRIORITY.indexOf(a.status) - LEAD_STATUS_PRIORITY.indexOf(b.status);
    };

  // A Do Not Contact buyer needs no further action -- sink them to the
  // bottom no matter which sort is chosen (same idea as dealStillActive
  // already sinking closed-deal pitches within the default sort), instead
  // of leaving them mixed in among buyers still worth calling.
  const active = filtered.filter(function (p) { return !p.doNotContact; }).sort(comparator);
  const dnc = filtered.filter(function (p) { return p.doNotContact; }).sort(comparator);
  return active.concat(dnc);
}

function renderMyPitches() {
  const tbody = document.getElementById("mypitches-tbody");
  const empty = document.getElementById("buyerleads-empty");
  const filtered = getFilteredSortedMyPitches();
  empty.hidden = filtered.length > 0;

  const totalPages = Math.max(1, Math.ceil(filtered.length / MY_PITCHES_PAGE_SIZE));
  if (myPitchesCurrentPage > totalPages) myPitchesCurrentPage = totalPages;
  const pageStart = (myPitchesCurrentPage - 1) * MY_PITCHES_PAGE_SIZE;
  const pageItems = filtered.slice(pageStart, pageStart + MY_PITCHES_PAGE_SIZE);

  document.getElementById("mypitches-page-indicator").textContent =
    filtered.length === 0 ? "No results" :
    "Page " + myPitchesCurrentPage + " of " + totalPages + " (" + filtered.length + " total)";
  document.getElementById("mypitches-prev-page-btn").disabled = myPitchesCurrentPage <= 1;
  document.getElementById("mypitches-next-page-btn").disabled = myPitchesCurrentPage >= totalPages;

  tbody.innerHTML = pageItems.map(function (p) {
    const typeHint = p.phoneType === "Landline" ? "Landline" : p.phoneType === "Mobile" ? "Mobile" : (p.phoneType || "");
    const statusCell = p.dealStillActive
      ? '<span class="status-pill ' + statusClass(p.status) + '">' + esc(p.status) + '</span>'
      : '<span class="status-pill status-fully-worked">Deal ' + esc((p.dealStatus || "closed").toLowerCase()) + '</span>';
    const isMarked = markedPitchIds.has(p.PitchID);
    return '<tr class="clickable' + (isMarked ? " row-marked" : "") + '" data-pitch-id="' + esc(p.PitchID) + '">' +
      '<td><button type="button" class="row-marker-btn' + (isMarked ? " active" : "") + '" data-marker-pitch-id="' + esc(p.PitchID) + '" title="Mark this row so you don\'t lose your place while scrolling">' + (isMarked ? "&#9654;" : "&#9675;") + '</button>' + esc(p.buyerName) + '</td>' +
      '<td>' + esc(p.phone) + (typeHint ? '<div class="small-muted">' + esc(typeHint) + '</div>' : "") + '</td>' +
      '<td>' + esc(p.dealCode || "Deal") + '</td>' +
      '<td>' + [p.city, p.state].filter(Boolean).join(", ") + '</td>' +
      '<td class="small-muted">' + (p.portfolioValue ? esc(p.portfolioValue) : "&mdash;") + '</td>' +
      '<td>' + statusCell + '</td>' +
      '<td class="small-muted">' + (p.GivenAt ? formatDate(p.GivenAt) : "") + '</td>' +
      '</tr>';
  }).join("");
  Array.from(tbody.querySelectorAll("tr")).forEach(function (row) {
    row.addEventListener("click", function () { openPitchDetail(row.getAttribute("data-pitch-id")); });
  });
  Array.from(tbody.querySelectorAll(".row-marker-btn")).forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      const id = btn.getAttribute("data-marker-pitch-id");
      if (markedPitchIds.has(id)) markedPitchIds.delete(id); else markedPitchIds.add(id);
      renderMyPitches();
    });
  });
}

document.getElementById("mypitches-search").addEventListener("input", function () { myPitchesCurrentPage = 1; renderMyPitches(); });
document.getElementById("mypitches-filter-deal").addEventListener("change", function () { myPitchesCurrentPage = 1; renderMyPitches(); });
document.getElementById("mypitches-filter-status").addEventListener("change", function () { myPitchesCurrentPage = 1; renderMyPitches(); });
document.getElementById("mypitches-sort").addEventListener("change", function () { myPitchesCurrentPage = 1; renderMyPitches(); });
document.getElementById("mypitches-prev-page-btn").addEventListener("click", function () {
  if (myPitchesCurrentPage > 1) { myPitchesCurrentPage--; renderMyPitches(); }
});
document.getElementById("mypitches-next-page-btn").addEventListener("click", function () {
  myPitchesCurrentPage++; renderMyPitches();
});

// Returns [{slot, number, type}] for every phone number a pitch's buyer
// actually has on file (Phone is always first if present, then Phone2/3).
function pitchPhoneSlots(pitch) {
  const slots = [];
  if (pitch.phone) slots.push({ slot: "Phone", number: pitch.phone, type: pitch.phoneType });
  if (pitch.phone2) slots.push({ slot: "Phone2", number: pitch.phone2, type: pitch.phone2Type });
  if (pitch.phone3) slots.push({ slot: "Phone3", number: pitch.phone3, type: pitch.phone3Type });
  return slots;
}

function updateContactMethodOptions(slots) {
  const slotSelect = document.getElementById("contact-phone-select");
  const methodSelect = document.getElementById("contact-method-input");
  if (!slotSelect || !methodSelect) return;
  const chosen = slots.find(function (s) { return s.slot === slotSelect.value; }) || slots[0];
  const canTextThisSlot = chosen && chosen.type !== "Landline" && window.__pitchHasResponded;
  methodSelect.innerHTML = '<option value="Call">Call</option>' + (canTextThisSlot ? '<option value="Text">Text</option>' : '');
  updateVoicemailRowVisibility();
}

// A voicemail only makes sense to log on a Call, not a Text -- hides the
// checkbox (and un-checks it, so a stale check from a prior Call selection
// can't silently ride along into a Text log) whenever Method isn't Call.
function updateVoicemailRowVisibility() {
  const methodSelect = document.getElementById("contact-method-input");
  const row = document.getElementById("contact-voicemail-row");
  if (!methodSelect || !row) return;
  const isCall = methodSelect.value === "Call";
  row.hidden = !isCall;
  if (!isCall) document.getElementById("contact-voicemail-input").checked = false;
}

// Shared by openRepDealDetail and openPitchDetail -- both render a
// "Request Address Access" button with the same id/data attribute when the
// deal's Address isn't visible yet, so this just needs to be called once
// after either one sets panel.innerHTML.
function wireRequestAddressButton() {
  const btn = document.getElementById("request-address-btn");
  if (!btn) return;
  btn.addEventListener("click", async function () {
    if (btn.disabled) return;
    btn.disabled = true;
    const res = await api("requestAddressAccess", { dealId: btn.getAttribute("data-deal-id") });
    btn.disabled = false;
    if (!res.ok) { showToast(res.error || "Could not send the request.", true); return; }
    showToast("Address requested — admin has been notified.");
  });
}

// Same fields/wording as the rep's deal-detail confidentiality banner
// (openRepDealDetail) -- shown here too since a rep can reach this same
// deal context from a matched buyer's pitch without ever opening the deal
// itself. For a real rep session, deal.Address only arrives here at all if
// applyAddressSecrecy (backend, getMyPitches) let it through -- so simply
// checking deal.Address is enough, no need to also check addressGranted.
// An admin session skips applyAddressSecrecy entirely (same as
// getDeal/getDeals), so deal.Address is always present there and
// addressGranted is never set -- the grant-specific warning banner is
// skipped in that case since admin always has full access, not a
// specifically-granted one.
function renderPitchDealInfo(deal) {
  if (!deal) return "";
  const addressBanner = deal.addressGranted && deal.Address
    ? '<div class="banner danger"><strong>Confidential &mdash; do not share.</strong> Admin has given you access to this deal\'s exact address. Only share it with a legitimate, matched buyer' +
      ' &mdash; and only with admin approval, once that buyer has expressed real interest and specifically wants to review the full address. Sharing it any earlier, or with anyone else,' +
      ' risks losing us this deal and getting paid on it, and will get you removed as a dispositions team member.</div>'
    : "";
  return (
    '<div class="section-title">Deal Info</div>' +
    addressBanner +
    '<div class="banner info">' +
      (deal.Address ? '<div><strong>Address:</strong> ' + esc(deal.Address) + '</div>' : "") +
      (deal.AssetType ? '<div style="margin-top:8px;"><strong>Asset Type:</strong> ' + esc(deal.AssetType) + '</div>' : "") +
      (deal.Price ? '<div><strong>Price:</strong> ' + esc(deal.Price) + '</div>' : "") +
      (deal.ARV ? '<div><strong>ARV:</strong> ' + esc(deal.ARV) + '</div>' : "") +
      (deal.RehabEstimate ? '<div><strong>Rehab Estimate:</strong> ' + esc(deal.RehabEstimate) + '</div>' : "") +
      (deal.ARV || deal.RehabEstimate ? '<div><strong>Gross Margin:</strong> ' + formatGrossMargin(deal.GrossMargin) + '</div>' : "") +
      (deal.AsIsValue ? '<div><strong>As-Is Value:</strong> ' + esc(deal.AsIsValue) + '</div>' : "") +
      (deal.AsIsValue ? '<div><strong>As-Is Equity:</strong> ' + formatAsIsEquity(deal.AsIsEquity) + '</div>' : "") +
      (deal.GeneralDriveLink ? '<div style="margin-top:8px;"><strong>Deal Documents:</strong> <a href="' + esc(deal.GeneralDriveLink) + '" target="_blank" rel="noopener">Open Drive Folder</a></div>' : "") +
      (!deal.Address ? '<div style="margin-top:10px;"><button class="btn secondary small" id="request-address-btn" data-deal-id="' + esc(deal.DealID) + '">Request Address Access</button>' +
        '<div class="small-muted" style="margin-top:6px;">Pitch off the general deal info first — only use this once a buyer has responded, is genuinely interested, and specifically asks you for the address. This just emails admin to ask; it does not grant it.</div></div>' : "") +
    '</div>' +
    (deal.Description
      ? '<details open style="margin-top:10px;"><summary style="cursor:pointer; font-weight:600;">Description / Notes <span class="small-muted">(click to collapse)</span></summary>' +
        '<div style="margin-top:6px; white-space:pre-wrap;">' + esc(deal.Description) + '</div></details>'
      : "")
  );
}

async function openPitchDetail(pitchId) {
  const pitch = myPitches.find(function (p) { return p.PitchID === pitchId; });
  if (!pitch) return;

  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const contactsRes = await api("getPitchContacts", { pitchId: pitchId });
  const contacts = contactsRes.ok ? contactsRes.contacts : [];
  const slots = pitchPhoneSlots(pitch);
  window.__pitchHasResponded = pitch.hasResponded;
  const hours = pitch.callingHours;

  let hoursBanner = "";
  if (hours) {
    hoursBanner = hours.withinCallingHours
      ? '<div class="banner info">Within calling hours &mdash; it\'s currently ' + hours.hour + ':00 for this buyer.</div>'
      : '<div class="banner warn"><strong>Outside typical calling hours</strong> &mdash; it\'s currently ' + hours.hour + ':00 for this buyer. Contact hours are usually 8am&ndash;7pm their time for a first outreach; go ahead if the buyer reached out to you, or if you\'re just working a little earlier or later.</div>';
  }

  const dncBanner = pitch.doNotContact
    ? '<div class="banner danger"><strong>Do Not Contact.</strong> This buyer has asked not to be contacted again — no further calls or texts can be logged for them.</div>'
    : "";

  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + esc(pitch.buyerName) + '</h2>' +
      '<p class="step-sub">' + slots.map(function (s) { return esc(s.number) + (s.type ? " (" + esc(s.type) + ")" : ""); }).join(" &middot; ") +
      (pitch.city ? ' &middot; ' + esc(pitch.city) + (pitch.state ? ", " + esc(pitch.state) : "") : "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +
    dncBanner +
    (pitch.doNotContact ? "" : hoursBanner) +
    '<div class="banner info">' +
      (pitch.dealStillActive
        ? '<span class="status-pill ' + statusClass(pitch.status) + '">' + esc(pitch.status) + '</span>'
        : '<span class="status-pill status-fully-worked">Deal ' + esc((pitch.dealStatus || "closed").toLowerCase()) + '</span>') +
      '<div style="margin-top:8px;"><strong>Re:</strong> ' + esc(pitch.dealCode || "Deal") + '</div>' +
      '<div style="margin-top:8px;">' + (pitch.hasResponded
        ? 'They\'ve responded, so texting is available on any mobile number below.'
        : 'Call first on every number — texting unlocks once they respond to a call (high-volume texting with no reply history gets numbers blocked from texting).') + '</div>' +
      (pitch.email ? '<div style="margin-top:8px;"><strong>Email:</strong> <a href="mailto:' + esc(pitch.email) + '">' + esc(pitch.email) + '</a></div>' : "") +
      (pitch.driveLink ? '<div style="margin-top:8px;"><strong>Documents:</strong> <a href="' + esc(pitch.driveLink) + '" target="_blank" rel="noopener">Open Drive Folder</a></div>' : "") +
    '</div>' +

    renderPitchDealInfo(pitch.deal) +

    '<div class="section-title">Buyer Info</div>' +
    '<p class="small-muted">Fill in anything missing — asset types they buy, price range, last known purchase price, extra numbers — so this buyer is easier to match and pitch next time.</p>' +
    (pitch.leadProfile ? renderBuyerProfileFields(pitch.leadProfile, "rep") : "") +

    '<div class="section-title">General Buyer Notes</div>' +
    '<p class="small-muted">Shared across every deal this buyer is ever pitched — ARV%, price range, areas of interest, cash vs. financed, etc.</p>' +
    '<textarea id="general-notes-input">' + esc(pitch.generalNotes || "") + '</textarea>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="general-notes-save-btn">Save Notes</button>' +
    '</div>' +

    (pitch.doNotContact ? "" :
    '<div class="section-title">Log a Contact</div>' +
    '<label class="field-label">Which number?</label>' +
    '<select id="contact-phone-select">' +
      slots.map(function (s) { return '<option value="' + s.slot + '">' + esc(s.number) + (s.type ? " (" + esc(s.type) + ")" : "") + '</option>'; }).join("") +
    '</select>' +
    '<label class="field-label">Method</label>' +
    '<select id="contact-method-input"></select>' +
    '<label class="checkbox-row"><input type="checkbox" id="contact-responded-input"> Buyer responded during this contact</label>' +
    '<label class="checkbox-row" id="contact-voicemail-row"><input type="checkbox" id="contact-voicemail-input"> Left a voicemail</label>' +
    '<div class="row2">' +
      '<div><label class="field-label">% of ARV interested at <span class="small-muted">(if mentioned)</span></label><input type="text" id="contact-arvpercent-input" placeholder="e.g. 70"></div>' +
      '<div><label class="field-label">% of As-Is Value <span class="small-muted">(if mentioned)</span></label><input type="text" id="contact-asispercent-input" placeholder="e.g. 85"></div>' +
    '</div>' +
    '<label class="field-label">Notes (buyer feedback on this deal specifically)</label>' +
    '<textarea id="contact-notes-input"></textarea>' +
    '<div class="error-text" id="contact-add-error"></div>' +
    '<div class="nav-row" style="justify-content:space-between; align-items:center;">' +
      '<span class="small-muted" style="max-width:260px;">Mainly for landline-only buyers with no mobile to text, but use it however\'s useful — logs a quick "Skipped" note (doesn\'t count toward the two-touch follow-up) and jumps straight to the next lead.</span>' +
      '<div style="display:flex; gap:8px;">' +
        '<button class="btn secondary" id="contact-skip-btn">Skip &amp; Next</button>' +
        '<button class="btn primary" id="contact-add-submit">Log Contact</button>' +
      '</div>' +
    '</div>') +

    '<div class="section-title">Contact History</div>' +
    '<div id="contact-history-list">' + renderContactHistory(contacts) + '</div>' +

    '<div class="section-title">Do Not Contact</div>' +
    '<p class="small-muted">If this buyer has asked not to be contacted again, mark it here — it stops any further calls or texts from being logged for them, on any number, and admin won\'t be able to pitch them a new deal.</p>' +
    '<button class="btn ' + (pitch.doNotContact ? "secondary" : "danger") + ' small" id="dnc-toggle-btn">' + (pitch.doNotContact ? "Allow Contact Again" : "Mark Do Not Contact") + '</button>';

  document.getElementById("close-detail-btn").addEventListener("click", function () { overlay.hidden = true; loadMyPitches(); });

  document.getElementById("general-notes-save-btn").addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    await api("updateBuyerLeadNotes", { buyerLeadId: pitch.BuyerLeadID, notes: document.getElementById("general-notes-input").value.trim() });
    btn.disabled = false;
    showToast("Notes saved.");
  });

  if (pitch.leadProfile) {
    wireBuyerProfileFieldsHandlers("rep", pitch.BuyerLeadID, async function () {
      await loadMyPitches();
      openPitchDetail(pitchId);
    });
  }

  document.getElementById("dnc-toggle-btn").addEventListener("click", async function () {
    const willBeDnc = !pitch.doNotContact;
    await api("updateBuyerLeadDoNotContact", { buyerLeadId: pitch.BuyerLeadID, doNotContact: willBeDnc });
    await loadMyPitches();
    openPitchDetail(pitchId);
    showToast(willBeDnc ? "Marked Do Not Contact." : "Contact allowed again.");
  });

  wireRequestAddressButton();

  const phoneSelect = document.getElementById("contact-phone-select");
  if (phoneSelect) {
    updateContactMethodOptions(slots);
    phoneSelect.addEventListener("change", function () { updateContactMethodOptions(slots); });
    document.getElementById("contact-method-input").addEventListener("change", updateVoicemailRowVisibility);

    document.getElementById("contact-add-submit").addEventListener("click", async function () {
      const phoneSlot = phoneSelect.value;
      const method = document.getElementById("contact-method-input").value;
      const responded = document.getElementById("contact-responded-input").checked;
      const voicemailLeft = document.getElementById("contact-voicemail-input").checked;
      const arvPercent = document.getElementById("contact-arvpercent-input").value.trim();
      const asIsPercent = document.getElementById("contact-asispercent-input").value.trim();
      const notes = document.getElementById("contact-notes-input").value.trim();
      const errorEl = document.getElementById("contact-add-error");
      errorEl.classList.remove("show");
      const res = await api("addPitchContact", { pitchId: pitchId, phoneSlot: phoneSlot, method: method, responded: responded, voicemailLeft: voicemailLeft, arvPercent: arvPercent, asIsPercent: asIsPercent, notes: notes });
      if (!res.ok) {
        errorEl.textContent = res.error || "Could not log contact.";
        errorEl.classList.add("show");
        showToast(res.error || "Could not log contact.", true);
        return;
      }
      document.getElementById("contact-notes-input").value = "";
      document.getElementById("contact-arvpercent-input").value = "";
      document.getElementById("contact-asispercent-input").value = "";
      document.getElementById("contact-responded-input").checked = false;
      document.getElementById("contact-voicemail-input").checked = false;
      const fresh = await api("getPitchContacts", { pitchId: pitchId });
      document.getElementById("contact-history-list").innerHTML = renderContactHistory(fresh.ok ? fresh.contacts : []);
      showToast("Contact logged.");
      if (responded) { await loadMyPitches(); openPitchDetail(pitchId); }
    });

    document.getElementById("contact-skip-btn").addEventListener("click", async function () {
      const phoneSlot = phoneSelect.value;
      const notes = document.getElementById("contact-notes-input").value.trim();
      const errorEl = document.getElementById("contact-add-error");
      errorEl.classList.remove("show");
      // Logged the same way as a Call/Text (so it's on record and admin can
      // see it in Contact History), but Method "Skipped" is filtered out of
      // computeLeadStatus's follow-up math server-side -- it never counts
      // as a real touch or moves the two-touch SOP forward.
      const res = await api("addPitchContact", { pitchId: pitchId, phoneSlot: phoneSlot, method: "Skipped", notes: notes });
      if (!res.ok) {
        errorEl.textContent = res.error || "Could not skip this lead.";
        errorEl.classList.add("show");
        showToast(res.error || "Could not skip this lead.", true);
        return;
      }
      showToast("Skipped — moving to next lead.");
      await openNextPitchAfter(pitchId);
    });
  }
}

// Advances straight to the next lead in the rep's current filtered/sorted
// list after a Skip, instead of dumping them back at the full table to
// re-find their place. Reads myPitches as it stands right now (not
// reloaded from the backend first) so the list order stays stable and
// matches exactly what the rep was just looking at.
async function openNextPitchAfter(pitchId) {
  const list = getFilteredSortedMyPitches();
  const idx = list.findIndex(function (p) { return p.PitchID === pitchId; });
  const next = idx !== -1 ? list[idx + 1] : null;
  if (next) {
    await openPitchDetail(next.PitchID);
  } else {
    document.getElementById("detail-overlay").hidden = true;
    await loadMyPitches();
    showToast("That was the last one in your current list.");
  }
}

function renderContactHistory(contacts) {
  if (contacts.length === 0) return '<p class="small-muted">No contact logged yet.</p>';
  return contacts.slice().reverse().map(function (c) {
    return '<div class="item-row">' +
      '<span class="ts">' + formatDate(c.ContactedAt) + ' &middot; ' + esc(c.Username) + ' &middot; ' + esc(c.Method) +
      (c.PhoneSlot && c.PhoneSlot !== "Phone" ? ' (' + esc(c.PhoneSlot) + ')' : '') +
      (c.Responded === true || c.Responded === "TRUE" ? ' &middot; <strong>Responded</strong>' : '') +
      (c.VoicemailLeft === true || c.VoicemailLeft === "TRUE" ? ' &middot; Left voicemail' : '') + '</span>' +
      (c.ARVPercent || c.AsIsPercent ? '<div class="small-muted" style="margin-top:4px;">' +
        [c.ARVPercent ? esc(c.ARVPercent) + "% of ARV" : "", c.AsIsPercent ? esc(c.AsIsPercent) + "% of As-Is Value" : ""].filter(Boolean).join(" &middot; ") +
        '</div>' : "") +
      (c.Notes ? '<div style="margin-top:4px;">' + esc(c.Notes) + '</div>' : "") +
      '</div>';
  }).join("");
}

/* ============================================================
   REP VIEW — BUILD YOUR OWN BUYER LIST
   Deliberately a separate, simpler module from admin's CSV importer below
   (no per-column mapping-override table -- just auto-guessed columns) so
   the two don't share DOM ids or mutable module state. Reuses the same
   pure parsing/formatting helpers (parseCsvText, guessCsvField,
   normalizePhoneType, formatMoneyish, formatPercentish, formatWholeNumber,
   formatAdminMoney, normalizeAssetCategoryValue), which are all defined
   further down but hoisted, since none of them touch the DOM themselves.
   ============================================================ */

let repCsvRows = [];
let repCsvHeaders = [];

document.getElementById("rep-csv-file-input").addEventListener("change", function (e) {
  const file = e.target.files[0];
  const errorEl = document.getElementById("rep-csv-parse-error");
  errorEl.classList.remove("show");
  document.getElementById("rep-csv-import-result").textContent = "";
  document.getElementById("rep-csv-import-error").classList.remove("show");
  document.getElementById("rep-csv-portfolio-min-input").value = "";
  document.getElementById("rep-csv-portfolio-max-input").value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    const parsed = parseCsvText(String(reader.result || ""));
    if (parsed.length === 0) {
      errorEl.textContent = "Couldn't find any rows in that file.";
      errorEl.classList.add("show");
      return;
    }
    const hasHeader = document.getElementById("rep-csv-has-header").checked;
    repCsvHeaders = hasHeader ? parsed[0] : parsed[0].map(function (_, i) { return "Column " + (i + 1); });
    repCsvRows = hasHeader ? parsed.slice(1) : parsed;
    if (repCsvRows.length === 0) {
      errorEl.textContent = "That file only has a header row — no buyer rows to import.";
      errorEl.classList.add("show");
      return;
    }
    renderRepCsvPreview();
  };
  reader.onerror = function () {
    errorEl.textContent = "Could not read that file.";
    errorEl.classList.add("show");
  };
  reader.readAsText(file);
});

document.getElementById("rep-csv-has-header").addEventListener("change", function () {
  const fileInput = document.getElementById("rep-csv-file-input");
  if (fileInput.files[0]) fileInput.dispatchEvent(new Event("change"));
});

["rep-csv-portfolio-min-input", "rep-csv-portfolio-max-input"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", function () {
    if (!document.getElementById("rep-csv-preview-section").hidden) renderRepCsvPreview();
  });
});

// No manual override dropdowns for reps -- first column that guesses to a
// given field wins, same "most specific wins" behavior as guessCsvField
// itself already provides per-column.
function repAutoMapping() {
  const mapping = {};
  repCsvHeaders.forEach(function (h, i) {
    const field = guessCsvField(h);
    if (field && mapping[field] === undefined) mapping[field] = i;
  });
  return mapping;
}

function repCsvPortfolioOverrideValue() {
  const minEl = document.getElementById("rep-csv-portfolio-min-input");
  const maxEl = document.getElementById("rep-csv-portfolio-max-input");
  const min = formatAdminMoney(minEl ? minEl.value : "");
  const max = formatAdminMoney(maxEl ? maxEl.value : "");
  if (min && max) return min + " – " + max;
  if (min) return min + "+";
  if (max) return "Up to " + max;
  return "";
}

function repMappedCsvRows() {
  const mapping = repAutoMapping();
  return repCsvRows
    .filter(function (row) { return row.some(function (cell) { return String(cell || "").trim() !== ""; }); })
    .map(function (row) {
      const get = function (field) { return mapping[field] !== undefined ? String(row[mapping[field]] || "").trim() : ""; };
      const purchasePrice = formatMoneyish(get("lastKnownPurchasePrice"));
      const purchaseDateHint = get("lastPurchaseDateHint");
      const lastKnownPurchasePrice = purchasePrice && purchaseDateHint ? purchasePrice + " (" + purchaseDateHint + ")" :
        purchasePrice ? purchasePrice :
        purchaseDateHint ? "Unknown price (sold " + purchaseDateHint + ")" : "";
      const estimatedBase = formatMoneyish(get("estimatedPropertyValue"));
      const equityHint = formatPercentish(get("equityHint"));
      const estimatedPropertyValue = estimatedBase && equityHint ? estimatedBase + " (" + equityHint + " equity)" : (estimatedBase || (equityHint ? equityHint + " equity" : ""));
      const portfolioValue = repCsvPortfolioOverrideValue();
      return {
        buyerName: get("buyerName"), phone: get("phone"), phoneType: normalizePhoneType(get("phoneType")),
        phone2: get("phone2"), phone2Type: normalizePhoneType(get("phone2Type")),
        phone3: get("phone3"), phone3Type: normalizePhoneType(get("phone3Type")),
        city: get("city"), state: get("state"), zip: get("zip"), county: get("county"), email: get("email"),
        assetCategories: normalizeAssetCategoryValue(get("assetCategories")), lastKnownPurchasePrice: lastKnownPurchasePrice,
        estimatedPropertyValue: estimatedPropertyValue,
        portfolioValue: portfolioValue,
        ownershipLengthMonths: formatWholeNumber(get("ownershipLengthMonths")),
        propertyUrl: get("propertyUrl"),
        priceRangeMin: get("priceRangeMin"), priceRangeMax: get("priceRangeMax")
      };
    });
}

function renderRepCsvPreview() {
  document.getElementById("rep-csv-preview-section").hidden = false;
  const rows = repMappedCsvRows();
  const tbody = document.querySelector("#rep-csv-preview-table tbody");
  tbody.innerHTML = rows.slice(0, 5).map(function (r) {
    return '<tr>' +
      '<td>' + esc(r.buyerName) + '</td>' + '<td>' + esc(r.phone) + '</td>' + '<td>' + esc(r.phoneType) + '</td>' +
      '<td>' + esc(r.city) + '</td>' + '<td>' + esc(r.state) + '</td>' +
      '<td>' + esc(r.assetCategories) + '</td>' +
      '<td>' + esc(r.estimatedPropertyValue) + '</td>' +
      '<td>' + esc(r.portfolioValue) + '</td>' +
      '</tr>';
  }).join("");
  const missingBuyerNameOrPhone = rows.filter(function (r) { return !r.buyerName || !r.phone; }).length;
  document.getElementById("rep-csv-preview-note").textContent =
    "Showing " + Math.min(5, rows.length) + " of " + rows.length + " row(s)." +
    (missingBuyerNameOrPhone > 0 ? " " + missingBuyerNameOrPhone + " row(s) are missing a Buyer Name or Phone and will be skipped." : "");
}

document.getElementById("rep-csv-import-btn").addEventListener("click", async function () {
  const btn = this;
  const errorEl = document.getElementById("rep-csv-import-error");
  const resultEl = document.getElementById("rep-csv-import-result");
  errorEl.classList.remove("show");
  const rows = repMappedCsvRows().filter(function (r) { return r.buyerName && r.phone; });
  if (rows.length === 0) {
    errorEl.textContent = "No rows have both a Buyer Name and a Phone — nothing to import.";
    errorEl.classList.add("show");
    return;
  }
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("importBuyerLeads", { rows: rows });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || "Import failed.";
    errorEl.classList.add("show");
    showToast(res.error || "Import failed.", true);
    return;
  }
  resultEl.textContent = "Imported " + res.imported + " buyer(s) — private to you." +
    (res.skippedDuplicates ? " Skipped " + res.skippedDuplicates + " repeated row(s) within this file." : "");
  document.getElementById("rep-csv-file-input").value = "";
  repCsvRows = []; repCsvHeaders = [];
  document.getElementById("rep-csv-preview-section").hidden = true;
  showToast("Imported " + res.imported + " buyer(s).");
});

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
  ["deals", "team", "fb", "buyers", "buyerleads", "pitches", "statuses", "assetcategories"].forEach(function (t) {
    document.getElementById("tab-" + t).hidden = t !== tab;
  });
  if (tab === "team") loadReps();
  if (tab === "fb") loadFbRequests();
  if (tab === "buyers") loadBuyerRequests();
  if (tab === "buyerleads") initBuyerLeadsAdminTab();
  if (tab === "pitches") initAdminPitchesTab();
  if (tab === "statuses") loadStatusOptions();
  if (tab === "assetcategories") loadAssetCategoryOptions();
}

async function initAdminView() {
  // Independent reads -- run together rather than one after another.
  await Promise.all([loadStatusOptions(), loadAssetCategoryOptions(), loadAdminDeals()]);
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
  // Same organization as the rep's Deals tab: closest to closing first
  // (Under Contract, Active, On Hold, Sold, then Dead at the bottom), State
  // alphabetically behind that, then City/County as tiebreakers.
  filtered.sort(function (a, b) {
    return dealStatusRank(a.Status) - dealStatusRank(b.Status) ||
      String(a.State || "").localeCompare(String(b.State || "")) ||
      String(a.City || "").localeCompare(String(b.City || "")) ||
      String(a.County || "").localeCompare(String(b.County || ""));
  });
  empty.hidden = filtered.length > 0;
  tbody.innerHTML = filtered.map(function (d) {
    return '<tr class="clickable" data-deal-id="' + esc(d.DealID) + '">' +
      '<td>' + (d.DealCode ? esc(d.DealCode) : "&mdash;") + '</td>' +
      '<td>' + esc(d.Address) + (d.City ? ", " + esc(d.City) : "") + '</td>' +
      '<td>' + esc(d.AssetType || "") + '</td>' +
      '<td>' + esc(d.Price || "") + '</td>' +
      '<td><span class="status-pill ' + statusClass(d.Status) + '">' + esc(d.Status || "") + '</span></td>' +
      '<td>' + (d.repsWithAccessCount === undefined ? "&mdash;" :
        d.currentAdminHasAccess ? "Admin" + (d.repsWithAccessCount > 0 ? " + " + d.repsWithAccessCount : "") :
        (d.repsWithAccessCount === 0 ? '<span class="status-pill status-dead">0 reps</span>' : d.repsWithAccessCount + " rep" + (d.repsWithAccessCount === 1 ? "" : "s"))
      ) + '</td>' +
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
  document.getElementById("deal-matchcities-input").value = "";
  document.getElementById("deal-assettype-input").value = "";
  document.getElementById("deal-price-input").value = "";
  document.getElementById("deal-arv-input").value = "";
  document.getElementById("deal-rehab-input").value = "";
  document.getElementById("deal-asisvalue-input").value = "";
  document.getElementById("deal-description-input").value = "";
  document.getElementById("deal-general-drive-input").value = "";
  document.getElementById("deal-sensitive-drive-input").value = "";
  document.getElementById("deal-admin-notes-input").value = "";
  document.getElementById("deal-source-link-input").value = "";
  document.getElementById("deal-assignmode-input").value = "";
  const statusSelect = document.getElementById("deal-status-input");
  statusSelect.innerHTML = statusOptionsCache.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join("");
  const categorySelect = document.getElementById("deal-assetcategory-input");
  categorySelect.innerHTML = '<option value="">&mdash; none &mdash;</option>' +
    assetCategoryOptionsCache.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join("");
  document.getElementById("deal-modal-error").classList.remove("show");
  document.getElementById("deal-modal").hidden = false;
}

document.getElementById("deal-modal-cancel").addEventListener("click", function () {
  document.getElementById("deal-modal").hidden = true;
});

document.getElementById("deal-modal-save").addEventListener("click", async function () {
  const btn = this;
  const address = document.getElementById("deal-address-input").value.trim();
  const errorEl = document.getElementById("deal-modal-error");
  errorEl.classList.remove("show");
  if (!address) {
    errorEl.textContent = "Address is required.";
    errorEl.classList.add("show");
    return;
  }
  if (btn.disabled) return;
  btn.disabled = true;
  const data = {
    dealCode: document.getElementById("deal-code-input").value.trim(),
    address: address,
    city: document.getElementById("deal-city-input").value.trim(),
    state: document.getElementById("deal-state-input").value.trim(),
    zip: document.getElementById("deal-zip-input").value.trim(),
    county: document.getElementById("deal-county-input").value.trim(),
    matchCities: document.getElementById("deal-matchcities-input").value.trim(),
    assetCategory: document.getElementById("deal-assetcategory-input").value,
    assetType: document.getElementById("deal-assettype-input").value.trim(),
    price: document.getElementById("deal-price-input").value.trim(),
    arv: document.getElementById("deal-arv-input").value.trim(),
    rehabEstimate: document.getElementById("deal-rehab-input").value.trim(),
    asIsValue: document.getElementById("deal-asisvalue-input").value.trim(),
    status: document.getElementById("deal-status-input").value,
    description: document.getElementById("deal-description-input").value.trim(),
    generalDriveLink: document.getElementById("deal-general-drive-input").value.trim(),
    sensitiveDriveLink: document.getElementById("deal-sensitive-drive-input").value.trim(),
    adminPrivateNotes: document.getElementById("deal-admin-notes-input").value.trim(),
    sourceLink: document.getElementById("deal-source-link-input").value.trim()
  };
  const assignMode = document.getElementById("deal-assignmode-input").value;
  const res = await api("adminAddDeal", { data: data, assignMode: assignMode });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || "Could not save deal.";
    errorEl.classList.add("show");
    showToast(res.error || "Could not save deal.", true);
    return;
  }
  document.getElementById("deal-modal").hidden = true;
  await loadAdminDeals();
  showToast(assignMode ? "Deal added and assigned to " + res.assignedCount + " rep(s)." : "Deal added.");
});

async function openAdminDealDetail(dealId) {
  const deal = adminDeals.find(function (d) { return d.DealID === dealId; });
  if (!deal) return;

  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const [repsRes, assignRes, buyersRes, fbRes, grantsRes] = await Promise.all([
    api("adminGetReps", {}),
    api("adminGetAssignments", { dealId: dealId }),
    api("getInterestedBuyers", { dealId: dealId }),
    api("adminGetFbRequests", { dealId: dealId }),
    api("adminGetAddressGrants", { dealId: dealId })
  ]);
  const activeReps = repsRes.ok ? repsRes.reps.filter(function (r) { return r.active && !r.isAdmin; }) : [];
  const allReps = activeReps.filter(function (r) { return !r.allAccess; });
  const assignedUsernames = assignRes.ok ? assignRes.usernames : [];
  const buyers = buyersRes.ok ? buyersRes.buyers : [];
  const fbRequests = fbRes.ok ? fbRes.requests : [];
  const grantedUsernames = grantsRes.ok ? grantsRes.usernames : [];

  renderAdminDealDetail(deal, allReps, assignedUsernames, buyers, fbRequests, activeReps, grantedUsernames);
}

function renderAdminDealDetail(deal, allReps, assignedUsernames, buyers, fbRequests, activeReps, grantedUsernames) {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");

  // Reps who have standing access to this deal via its Asset Category
  // (see the Team tab's "Deals They're Specifically Told To Work On"
  // checkboxes) -- read-only here, since that's managed per-rep in the
  // Team tab, not per-deal. Excluded from the "Add Access" dropdown below
  // since they already have it, and folded into who's eligible for an
  // address grant, same as anyone directly assigned.
  const dealCategoryNorm = String(deal.AssetCategory || "").trim().toLowerCase();
  const categoryAccessReps = dealCategoryNorm
    ? allReps.filter(function (r) {
        return String(r.categoryAccess || "").split(",").map(function (c) { return c.trim().toLowerCase(); }).indexOf(dealCategoryNorm) !== -1;
      })
    : [];
  const categoryAccessUsernames = categoryAccessReps.map(function (r) { return r.username; });

  const availableReps = allReps.filter(function (r) { return assignedUsernames.indexOf(r.username) === -1 && categoryAccessUsernames.indexOf(r.username) === -1; });

  // Admin already has full access to every deal regardless of assignment,
  // so this is purely an organizational "I'm personally on this one too"
  // marker, not a permission change -- same ASSIGNMENTS_SHEET rows a
  // regular rep gets, just excluded from the dropdown above (allReps is
  // built from non-admin reps only) since it deserves its own one-click
  // toggle rather than being buried in that list.
  const currentUsername = String((getSession() || {}).username || "").trim().toLowerCase();
  const adminIsAssigned = assignedUsernames.map(function (u) { return String(u).toLowerCase(); }).indexOf(currentUsername) !== -1;

  // Only reps who can actually work this deal (all-access, specifically
  // assigned, or via category) are eligible to be granted its address --
  // granting it to someone with no deal access at all wouldn't make sense.
  const repsWithDealAccess = activeReps.filter(function (r) { return r.allAccess || assignedUsernames.indexOf(r.username) !== -1 || categoryAccessUsernames.indexOf(r.username) !== -1; });
  const ungrantedReps = repsWithDealAccess.filter(function (r) { return grantedUsernames.indexOf(r.username) === -1; });

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

    '<div class="section-title">Location</div>' +
    '<label class="field-label">Address</label>' +
    '<input type="text" id="deal-address-edit" value="' + esc(deal.Address || "") + '">' +
    '<div class="row3">' +
      '<div><label class="field-label">City</label><input type="text" id="deal-city-edit" value="' + esc(deal.City || "") + '"></div>' +
      '<div><label class="field-label">State</label><input type="text" id="deal-state-edit" value="' + esc(deal.State || "") + '"></div>' +
      '<div><label class="field-label">Zip</label><input type="text" id="deal-zip-edit" value="' + esc(deal.Zip || "") + '"></div>' +
    '</div>' +
    '<div class="error-text" id="deal-location-error"></div>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary small" id="save-location-btn">Save Location</button>' +
    '</div>' +

    '<div class="row3">' +
      '<div><label class="field-label">Deal Code <span class="small-muted">(shown to reps instead of the address)</span></label><input type="text" id="deal-code-edit" value="' + esc(deal.DealCode || "") + '" placeholder="e.g. A-1"></div>' +
      '<div><label class="field-label">County</label><input type="text" id="deal-county-edit" value="' + esc(deal.County || "") + '"></div>' +
      '<div><label class="field-label">Asset Category <span class="small-muted">(for buyer matching)</span></label><select id="deal-assetcategory-edit">' +
        '<option value="">&mdash; none &mdash;</option>' +
        assetCategoryOptionsCache.map(function (c) { return '<option value="' + esc(c) + '"' + (c === deal.AssetCategory ? " selected" : "") + '>' + esc(c) + '</option>'; }).join("") +
      '</select></div>' +
    '</div>' +
    '<label class="field-label">Also Match These Cities <span class="small-muted">(same state, comma separated, in addition to ' + esc(deal.City || "the city above") + ')</span></label>' +
    '<input type="text" id="deal-matchcities-edit" value="' + esc(deal.MatchCities || "") + '" placeholder="e.g. Tempe, Mesa, Scottsdale">' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary small" id="save-code-btn">Save Deal Code / County / Matching</button>' +
    '</div>' +

    '<div class="section-title">Financials</div>' +
    '<div class="row3">' +
      '<div><label class="field-label">ARV <span class="small-muted">(after-repair value)</span></label><input type="text" id="deal-arv-edit" value="' + esc(deal.ARV || "") + '"></div>' +
      '<div><label class="field-label">Rehab Estimate</label><input type="text" id="deal-rehab-edit" value="' + esc(deal.RehabEstimate || "") + '"></div>' +
      '<div><label class="field-label">Price</label><input type="text" id="deal-price-edit" value="' + esc(deal.Price || "") + '"></div>' +
    '</div>' +
    '<label class="field-label">As-Is Value <span class="small-muted">(optional — current value with no repairs done; the selling point for a deal that\'s undervalued as-is rather than a rehab spread)</span></label>' +
    '<input type="text" id="deal-asisvalue-edit" value="' + esc(deal.AsIsValue || "") + '">' +
    '<p class="small-muted">Gross Margin (ARV &minus; Rehab Estimate &minus; Price): <strong>' + formatGrossMargin(deal.GrossMargin) + '</strong></p>' +
    '<p class="small-muted">As-Is Equity (As-Is Value &minus; Price): <strong>' + formatAsIsEquity(deal.AsIsEquity) + '</strong></p>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary small" id="save-financials-btn">Save Financials</button>' +
    '</div>' +

    '<div class="section-title">Deals They\'re Specifically Told To Work On</div>' +
    '<p class="small-muted">Team members with "all-deal access" can already see every deal and don\'t need to be listed here. Admin already has access to every deal regardless of this list — assigning yourself here is just a marker for the team that you\'re personally on this one too, reflected as "Admin" (plus however many other reps) in the deals table.</p>' +
    '<div class="nav-row" style="justify-content:flex-start; margin-bottom:10px;">' +
      '<button class="btn ' + (adminIsAssigned ? "secondary" : "primary") + ' small" id="assign-myself-btn">' + (adminIsAssigned ? "Remove Myself From This Deal" : "Assign Myself To This Deal") + '</button>' +
    '</div>' +
    '<div class="chip-list" id="assigned-chip-list">' +
      assignedUsernames.map(function (u) {
        const isMe = String(u).toLowerCase() === currentUsername;
        return '<span class="chip">' + (isMe ? "Admin (You)" : esc(u)) + '<button data-username="' + esc(u) + '" class="unassign-btn">&times;</button></span>';
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
    (categoryAccessReps.length > 0
      ? '<p class="small-muted" style="margin-top:10px;">Also have standing access via the <strong>' + esc(deal.AssetCategory) + '</strong> category (every deal in it, not just this one) — manage this per-rep from Team &rarr; Edit Details: ' +
        categoryAccessReps.map(function (r) { return esc(r.name) + ' (' + esc(r.username) + ')'; }).join(", ") + '</p>'
      : "") +

    '<div class="section-title">Address Access</div>' +
    '<p class="small-muted">Nobody sees this deal\'s exact address by default. Grant it to a specific team member once you\'ve seen they can be trusted to work correctly, and revoke it any time.</p>' +
    '<div class="chip-list" id="address-grant-chip-list">' +
      grantedUsernames.map(function (u) {
        return '<span class="chip">' + esc(u) + '<button data-username="' + esc(u) + '" class="revoke-address-btn">&times;</button></span>';
      }).join("") +
    '</div>' +
    (ungrantedReps.length > 0
      ? '<div style="display:flex; gap:8px; margin-top:10px;">' +
          '<select id="grant-address-select" style="flex:1;">' +
            ungrantedReps.map(function (r) { return '<option value="' + esc(r.username) + '">' + esc(r.name) + ' (' + esc(r.username) + ')</option>'; }).join("") +
          '</select>' +
          '<button class="btn secondary small" id="grant-address-btn">Disclose Address</button>' +
        '</div>'
      : (repsWithDealAccess.length === 0
          ? '<p class="small-muted" style="margin-top:8px;">No team member has access to this deal yet — add someone under Access above first.</p>'
          : '<p class="small-muted" style="margin-top:8px;">Everyone with access to this deal already has the address.</p>')) +

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

  document.getElementById("save-location-btn").addEventListener("click", async function () {
    const btn = this;
    const errorEl = document.getElementById("deal-location-error");
    errorEl.classList.remove("show");
    const address = document.getElementById("deal-address-edit").value.trim();
    if (!address) {
      errorEl.textContent = "Address is required.";
      errorEl.classList.add("show");
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    const res = await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        Address: address,
        City: document.getElementById("deal-city-edit").value.trim(),
        State: document.getElementById("deal-state-edit").value.trim(),
        Zip: document.getElementById("deal-zip-edit").value.trim()
      }
    });
    if (!res.ok) {
      btn.disabled = false;
      errorEl.textContent = res.error || "Could not save location.";
      errorEl.classList.add("show");
      showToast(res.error || "Could not save location.", true);
      return;
    }
    await loadAdminDeals();
    openAdminDealDetail(deal.DealID);
    showToast("Location saved.");
  });

  document.getElementById("save-code-btn").addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        DealCode: document.getElementById("deal-code-edit").value.trim(),
        County: document.getElementById("deal-county-edit").value.trim(),
        AssetCategory: document.getElementById("deal-assetcategory-edit").value,
        MatchCities: document.getElementById("deal-matchcities-edit").value.trim()
      }
    });
    await loadAdminDeals();
    openAdminDealDetail(deal.DealID);
    showToast("Deal code / matching info saved.");
  });

  document.getElementById("save-financials-btn").addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        ARV: document.getElementById("deal-arv-edit").value.trim(),
        RehabEstimate: document.getElementById("deal-rehab-edit").value.trim(),
        Price: document.getElementById("deal-price-edit").value.trim(),
        AsIsValue: document.getElementById("deal-asisvalue-edit").value.trim()
      }
    });
    await loadAdminDeals();
    openAdminDealDetail(deal.DealID);
    showToast("Financials saved.");
  });

  document.getElementById("save-admin-notes-btn").addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        SourceLink: document.getElementById("deal-source-link-edit").value.trim(),
        AdminPrivateNotes: document.getElementById("deal-admin-notes-edit").value.trim()
      }
    });
    btn.disabled = false;
    showToast("Private notes saved.");
  });

  document.getElementById("deal-status-select").addEventListener("change", async function (e) {
    e.target.disabled = true;
    await api("adminUpdateDealStatus", { dealId: deal.DealID, status: e.target.value });
    deal.Status = e.target.value;
    e.target.disabled = false;
    showToast("Status updated to " + e.target.value + ".");
  });

  Array.from(panel.querySelectorAll(".unassign-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      await api("adminUnassignRep", { dealId: deal.DealID, username: btn.getAttribute("data-username") });
      openAdminDealDetail(deal.DealID);
      showToast("Access removed.");
    });
  });

  const assignBtn = document.getElementById("assign-rep-btn");
  if (assignBtn) {
    assignBtn.addEventListener("click", async function () {
      assignBtn.disabled = true;
      const username = document.getElementById("assign-rep-select").value;
      await api("adminAssignRep", { dealId: deal.DealID, username: username });
      openAdminDealDetail(deal.DealID);
      showToast("Access granted.");
    });
  }

  document.getElementById("assign-myself-btn").addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    await api(adminIsAssigned ? "adminUnassignRep" : "adminAssignRep", { dealId: deal.DealID, username: currentUsername });
    openAdminDealDetail(deal.DealID);
    showToast(adminIsAssigned ? "Removed yourself from this deal." : "You're now assigned to this deal.");
  });

  Array.from(panel.querySelectorAll(".revoke-address-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      await api("adminRevokeAddressAccess", { dealId: deal.DealID, username: btn.getAttribute("data-username") });
      openAdminDealDetail(deal.DealID);
      showToast("Address access revoked.");
    });
  });

  const grantAddressBtn = document.getElementById("grant-address-btn");
  if (grantAddressBtn) {
    grantAddressBtn.addEventListener("click", async function () {
      grantAddressBtn.disabled = true;
      const username = document.getElementById("grant-address-select").value;
      await api("adminGrantAddressAccess", { dealId: deal.DealID, username: username });
      openAdminDealDetail(deal.DealID);
      showToast("Address access granted.");
    });
  }

  document.getElementById("save-desc-btn").addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    await api("adminUpdateDeal", { dealId: deal.DealID, data: { Description: document.getElementById("deal-desc-edit").value.trim() } });
    await loadAdminDeals();
    btn.disabled = false;
    showToast("Notes saved.");
  });

  document.getElementById("save-drive-links-btn").addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    await api("adminUpdateDeal", {
      dealId: deal.DealID,
      data: {
        GeneralDriveLink: document.getElementById("deal-general-drive-edit").value.trim(),
        SensitiveDriveLink: document.getElementById("deal-sensitive-drive-edit").value.trim()
      }
    });
    await loadAdminDeals();
    btn.disabled = false;
    showToast("Drive links saved.");
  });

  Array.from(panel.querySelectorAll(".fb-decide-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const requestId = btn.getAttribute("data-request-id");
      const decision = btn.getAttribute("data-decision");
      const note = document.getElementById("fb-note-" + requestId).value.trim();
      btn.disabled = true;
      await api("adminDecideFbRequest", { requestId: requestId, decision: decision, note: note });
      openAdminDealDetail(deal.DealID);
      showToast("Post " + decision.toLowerCase() + ".");
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
  const [repsRes, joinRes] = await Promise.all([api("adminGetReps", {}), api("getJoinContact", {})]);
  if (repsRes.ok) { adminReps = repsRes.reps; renderReps(); }
  if (joinRes.ok) {
    document.getElementById("join-contact-name-input").value = joinRes.name || "";
    document.getElementById("join-contact-phone-input").value = joinRes.phone || "";
    document.getElementById("join-contact-email-input").value = joinRes.email || "";
  }
}

document.getElementById("join-contact-save-btn").addEventListener("click", async function () {
  const btn = this;
  if (btn.disabled) return;
  btn.disabled = true;
  await api("adminSetJoinContact", {
    name: document.getElementById("join-contact-name-input").value.trim(),
    phone: document.getElementById("join-contact-phone-input").value.trim(),
    email: document.getElementById("join-contact-email-input").value.trim()
  });
  btn.disabled = false;
  showToast("Join contact saved.");
});

function renderReps() {
  const tbody = document.getElementById("reps-tbody");
  const empty = document.getElementById("reps-empty");
  empty.hidden = adminReps.length > 0;
  tbody.innerHTML = adminReps.map(function (r) {
    return '<tr>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td>' + esc(r.username) + '</td>' +
      '<td>' + esc(r.phone || "") + '</td>' +
      '<td>' + esc(r.email || "") + '</td>' +
      '<td class="small-muted">' + (r.personType ? esc(r.personType) : "&mdash;") + '</td>' +
      '<td><label class="toggle-row"><input type="checkbox" class="rep-toggle" data-username="' + esc(r.username) + '" data-field="allAccess"' + (r.allAccess ? " checked" : "") + '></label></td>' +
      '<td><label class="toggle-row"><input type="checkbox" class="rep-toggle" data-username="' + esc(r.username) + '" data-field="isAdmin"' + (r.isAdmin ? " checked" : "") + '></label></td>' +
      '<td><label class="toggle-row"><input type="checkbox" class="rep-toggle" data-username="' + esc(r.username) + '" data-field="active"' + (r.active ? " checked" : "") + '></label></td>' +
      '<td>' + (r.dealsAssignedCount || 0) + (r.allAccess ? ' <span class="small-muted">(all)</span>' : "") + '</td>' +
      '<td class="small-muted">' + (r.lastActive ? formatDate(r.lastActive) : "Never") + '</td>' +
      '<td class="small-muted">' + [r.preferredCity, r.preferredState, r.preferredZip].filter(Boolean).join(", ") + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<button class="btn secondary small reset-pw-btn" data-username="' + esc(r.username) + '" data-name="' + esc(r.name) + '">Reset Password</button> ' +
        '<button class="btn secondary small area-btn" data-username="' + esc(r.username) + '" data-name="' + esc(r.name) + '" data-phone="' + esc(r.phone) + '" data-email="' + esc(r.email) + '" data-city="' + esc(r.preferredCity) + '" data-state="' + esc(r.preferredState) + '" data-zip="' + esc(r.preferredZip) + '" data-persontype="' + esc(r.personType || "") + '" data-categoryaccess="' + esc(r.categoryAccess || "") + '">Edit Details</button>' +
      '</td>' +
      '</tr>';
  }).join("");

  Array.from(tbody.querySelectorAll(".rep-toggle")).forEach(function (cb) {
    cb.addEventListener("change", async function () {
      cb.disabled = true;
      const payload = { username: cb.getAttribute("data-username") };
      payload[cb.getAttribute("data-field")] = cb.checked;
      await api("adminSetRepAccess", payload);
      cb.disabled = false;
      showToast("Updated.");
    });
  });

  Array.from(tbody.querySelectorAll(".reset-pw-btn")).forEach(function (btn) {
    btn.addEventListener("click", function () { openResetModal(btn.getAttribute("data-username"), btn.getAttribute("data-name")); });
  });

  Array.from(tbody.querySelectorAll(".area-btn")).forEach(function (btn) {
    btn.addEventListener("click", function () {
      openAreaModal(btn.getAttribute("data-username"), btn.getAttribute("data-name"), btn.getAttribute("data-phone"), btn.getAttribute("data-email"),
        btn.getAttribute("data-city"), btn.getAttribute("data-state"), btn.getAttribute("data-zip"), btn.getAttribute("data-persontype"),
        btn.getAttribute("data-categoryaccess"));
    });
  });
}

function openAreaModal(username, name, phone, email, city, state, zip, personType, categoryAccess) {
  document.getElementById("area-modal-who").textContent = name + " (" + username + ")";
  document.getElementById("area-phone-input").value = phone || "";
  document.getElementById("area-email-input").value = email || "";
  document.getElementById("area-city-input").value = city || "";
  document.getElementById("area-state-input").value = state || "";
  document.getElementById("area-zip-input").value = zip || "";
  document.getElementById("area-persontype-input").value = personType || "";
  const checkedCategories = String(categoryAccess || "").split(",").map(function (c) { return c.trim().toLowerCase(); }).filter(Boolean);
  document.getElementById("area-categoryaccess-list").innerHTML = assetCategoryOptionsCache.map(function (c) {
    const checked = checkedCategories.indexOf(c.toLowerCase()) !== -1 ? " checked" : "";
    return '<label class="checkbox-row" style="margin:0 12px 6px 0;"><input type="checkbox" class="area-categoryaccess-checkbox" value="' + esc(c) + '"' + checked + '> ' + esc(c) + '</label>';
  }).join("");
  document.getElementById("area-modal").hidden = false;
  document.getElementById("area-modal-save").setAttribute("data-username", username);
}

document.getElementById("area-modal-cancel").addEventListener("click", function () {
  document.getElementById("area-modal").hidden = true;
});

document.getElementById("area-modal-save").addEventListener("click", async function () {
  const btn = this;
  if (btn.disabled) return;
  btn.disabled = true;
  const username = btn.getAttribute("data-username");
  await api("adminSetRepPreferredArea", {
    username: username,
    phone: document.getElementById("area-phone-input").value.trim(),
    email: document.getElementById("area-email-input").value.trim(),
    city: document.getElementById("area-city-input").value.trim(),
    state: document.getElementById("area-state-input").value.trim(),
    zip: document.getElementById("area-zip-input").value.trim(),
    personType: document.getElementById("area-persontype-input").value,
    categoryAccess: Array.from(document.querySelectorAll(".area-categoryaccess-checkbox:checked")).map(function (cb) { return cb.value; })
  });
  btn.disabled = false;
  document.getElementById("area-modal").hidden = true;
  await loadReps();
  showToast("Details saved.");
});

document.getElementById("add-rep-btn").addEventListener("click", function () {
  document.getElementById("rep-name-input").value = "";
  document.getElementById("rep-phone-input").value = "";
  document.getElementById("rep-email-input").value = "";
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
  const btn = this;
  const errorEl = document.getElementById("rep-modal-error");
  errorEl.classList.remove("show");
  const data = {
    name: document.getElementById("rep-name-input").value.trim(),
    phone: document.getElementById("rep-phone-input").value.trim(),
    email: document.getElementById("rep-email-input").value.trim(),
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
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("adminAddRep", { data: data });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || "Could not add team member.";
    errorEl.classList.add("show");
    showToast(res.error || "Could not add team member.", true);
    return;
  }
  document.getElementById("rep-modal").hidden = true;
  await loadReps();
  showToast("Team member added.");
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
  this.disabled = true;
  const res = await api("adminResetPassword", { username: username, newPassword: newPassword });
  this.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || "Could not reset password.";
    errorEl.classList.add("show");
    showToast(res.error || "Could not reset password.", true);
    return;
  }
  document.getElementById("reset-modal").hidden = true;
  showToast("Password reset.");
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
      '<div class="row2" style="margin-top:8px;">' +
        '<div><input type="text" class="match-arvpercent-input" data-buyer-id="' + esc(b.BuyerID) + '" value="' + esc(b.ARVPercent || "") + '" placeholder="% of ARV"></div>' +
        '<div><input type="text" class="match-asispercent-input" data-buyer-id="' + esc(b.BuyerID) + '" value="' + esc(b.AsIsPercent || "") + '" placeholder="% of As-Is Value"></div>' +
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
  renderMassEditCategories();
}

function renderMassEditCategories() {
  document.getElementById("mass-edit-categories-list").innerHTML = assetCategoryOptionsCache.map(function (c) {
    return '<label class="checkbox-row" style="margin:0 12px 6px 0;"><input type="checkbox" class="mass-edit-category-checkbox" value="' + esc(c) + '"> ' + esc(c) + '</label>';
  }).join("");
}

async function populateBulkGiveSelects() {
  const [repsRes, dealsRes] = await Promise.all([api("adminGetReps", {}), api("getDeals", {})]);
  if (repsRes.ok) {
    // Admins can be given buyer leads too (not just reps) -- lets an admin
    // hand themselves a lead and work it via "Work as Rep" while the rep
    // side is still getting built out / the team is still small.
    buyerLeadsActiveReps = repsRes.reps.filter(function (r) { return r.active; });
    const repOptions = buyerLeadsActiveReps.map(function (r) {
      return '<option value="' + esc(r.username) + '">' + esc(r.name) + ' (' + esc(r.username) + ')' + (r.isAdmin ? " — Admin" : "") + '</option>';
    }).join("");
    document.getElementById("bulk-give-rep-select").innerHTML = repOptions;
    // "give-selected" keeps an extra leading option (see index.html) so
    // admin can tag a batch for a deal without picking anyone yet.
    document.getElementById("give-selected-rep-select").innerHTML =
      '<option value="">— Tag for this deal only, pick a rep later —</option>' + repOptions;
  }
  if (dealsRes.ok) {
    buyerLeadsActiveDeals = dealsRes.deals.filter(function (d) { return d.Status !== "Sold" && d.Status !== "Dead"; });
    const dealOptions = buyerLeadsActiveDeals.map(function (d) {
      return '<option value="' + esc(d.DealID) + '">' + esc(d.DealCode ? d.DealCode + " — " + d.Address : d.Address) + '</option>';
    }).join("");
    document.getElementById("bulk-give-deal-select").innerHTML = dealOptions;
    document.getElementById("give-selected-deal-select").innerHTML = dealOptions;
  }
}

/* ---------- CSV import with auto column matching ---------- */

const CSV_FIELD_OPTIONS = [
  { value: "", label: "Don't import" },
  { value: "buyerName", label: "Buyer / LLC Name" },
  { value: "phone", label: "Phone" },
  { value: "phoneType", label: "Phone Type (Mobile/Landline)" },
  { value: "phone2", label: "Phone 2" },
  { value: "phone2Type", label: "Phone 2 Type" },
  { value: "phone3", label: "Phone 3" },
  { value: "phone3Type", label: "Phone 3 Type" },
  { value: "city", label: "City" },
  { value: "state", label: "State" },
  { value: "zip", label: "Zip" },
  { value: "county", label: "County" },
  { value: "email", label: "Email" },
  { value: "assetCategories", label: "Asset Categories (comma-separated)" },
  { value: "lastKnownPurchasePrice", label: "Last Known Purchase Price" },
  { value: "lastPurchaseDateHint", label: "Last Purchase/Sale Date (folded into Last Known Purchase Price)" },
  { value: "estimatedPropertyValue", label: "Estimated Value (this one property, not their whole portfolio)" },
  { value: "equityHint", label: "Estimated Equity % (folded into Estimated Value)" },
  { value: "ownershipLengthMonths", label: "Ownership Length (in months)" },
  { value: "propertyUrl", label: "Property Listing URL" },
  { value: "priceRangeMin", label: "Price Range Min" },
  { value: "priceRangeMax", label: "Price Range Max" }
];

// Minimal RFC4180-ish CSV parser: handles quoted fields, commas and
// newlines inside quotes, and "" as an escaped quote. Good enough for
// exports from Excel/Sheets/most CRMs without pulling in a library.
function parseCsvText(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Best-effort guess at which of our fields a CSV column header represents,
// checked in order from most to least specific so e.g. "Phone Type" matches
// phoneType rather than phone. Returns "" (Don't import) if nothing matches
// -- admin picks manually for anything we can't confidently guess.
function guessCsvField(header) {
  const h = String(header || "").toLowerCase().trim();
  // Skip-trace exports (Propwire and similar) bundle third-party columns
  // alongside the actual owner/buyer info -- a listing agent's or lender's
  // name/phone/email would otherwise pattern-match right along with the
  // owner's own, and silently win the mapping since later columns
  // overwrite earlier guesses for the same field. Never guess these.
  if (/listing\s*agent|listing\s*brokerage|\blender\b|\bmls\b/.test(h)) return "";
  // Same idea for "Owner Mailing" address -- often an out-of-state LLC
  // registered-agent address, not where the owner actually invests. The
  // property's own City/State/Zip/County (unprefixed, checked below) is
  // the signal that actually belongs in buyer-matching.
  if (/mailing/.test(h)) return "";
  if (/e-?mail/.test(h)) return "email";
  const isPhoneRelated = /phone|cell|mobile|tel(ephone)?|number|line/.test(h);
  const isTypeRelated = /type/.test(h) || /^(mobile|landline)$/.test(h);
  const isSecond = /\b2(nd)?\b|second|secondary|alt(ernate)?/.test(h);
  const isThird = /\b3(rd)?\b|third/.test(h);
  if (isPhoneRelated && isSecond) return isTypeRelated ? "phone2Type" : "phone2";
  if (isPhoneRelated && isThird) return isTypeRelated ? "phone3Type" : "phone3";
  if (isPhoneRelated && isTypeRelated) return "phoneType";
  if (isPhoneRelated) return "phone";
  if (/zip|postal/.test(h)) return "zip";
  if (/county/.test(h)) return "county";
  if (/^st$|state/.test(h)) return "state";
  if (/city|town/.test(h)) return "city";
  if (/category|categories|asset\s*type|property\s*type|land\s*use/.test(h)) return "assetCategories";
  // "Last Sale Date" / "Purchase Date" etc -- checked before the price rule
  // below so a *_date column doesn't get mistaken for the price itself
  // (skip-trace exports like Propwire split "Last Sale Amount" and "Last
  // Sale Date" into two separate columns; this lets the date get folded
  // back into the price text on import instead of just being dropped).
  if (/(purchase|sale|sold).*date|date.*(purchase|sale|sold)/.test(h)) return "lastPurchaseDateHint";
  if (/(last|past|prior|known).*(purchase|bought|paid|sale\s*(amount|price))|purchase.*price/.test(h)) return "lastKnownPurchasePrice";
  // Equity is a sharper "how well-capitalized / how liquid is this buyer"
  // signal than raw estimated value alone (100% equity means free and
  // clear -- a stronger cash-buyer signal than a high value with a big
  // mortgage against it), so fold it in as a suffix on Estimated Value
  // rather than just discarding it. Checked before the plain "estimated
  // value" rule below so "Estimated Equity Percent" doesn't get claimed by
  // it instead (both contain "estimated").
  if (/equity.*percent|percent.*equity/.test(h)) return "equityHint";
  // NOTE: this is the value of the *one property* in this row, not the
  // buyer's whole portfolio -- skip-trace exports like Propwire only ever
  // report on a single property even though the underlying owner may hold
  // several. There's deliberately no per-row mapping for the buyer's actual
  // Portfolio Value; Propwire doesn't export that at all, so it's entered
  // once for the whole batch instead (see the Portfolio Value For This
  // Batch box on the import screen).
  if (/estimated\s*value|market\s*value/.test(h)) return "estimatedPropertyValue";
  // How long the owner has held this one property -- a long hold on vacant
  // land often signals an inherited or otherwise low-priority parcel,
  // useful for dispositions outreach. Checked before the generic "county"
  // rule can't apply here anyway, but kept in this general area alongside
  // the other single-property signals above.
  if (/ownership.*length|length.*ownership|months?\s*owned|owned.*months?/.test(h)) return "ownershipLengthMonths";
  if (/property\s*url|listing\s*url/.test(h)) return "propertyUrl";
  if (/price.*(min|low)|(min|low).*price/.test(h)) return "priceRangeMin";
  if (/price.*(max|high)|(max|high).*price/.test(h)) return "priceRangeMax";
  if (/name|buyer|llc|company|contact/.test(h)) return "buyerName";
  return "";
}

let csvRows = [];
let csvHeaders = [];

document.getElementById("csv-file-input").addEventListener("change", function (e) {
  const file = e.target.files[0];
  const errorEl = document.getElementById("csv-parse-error");
  errorEl.classList.remove("show");
  document.getElementById("csv-import-result").textContent = "";
  document.getElementById("csv-import-error").classList.remove("show");
  // A new file means a new batch -- don't silently carry over a portfolio
  // value range typed in for a previous, unrelated upload.
  document.getElementById("csv-portfolio-min-input").value = "";
  document.getElementById("csv-portfolio-max-input").value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    const parsed = parseCsvText(String(reader.result || ""));
    if (parsed.length === 0) {
      errorEl.textContent = "Couldn't find any rows in that file.";
      errorEl.classList.add("show");
      return;
    }
    const hasHeader = document.getElementById("csv-has-header").checked;
    csvHeaders = hasHeader ? parsed[0] : parsed[0].map(function (_, i) { return "Column " + (i + 1); });
    csvRows = hasHeader ? parsed.slice(1) : parsed;
    if (csvRows.length === 0) {
      errorEl.textContent = "That file only has a header row — no buyer rows to import.";
      errorEl.classList.add("show");
      return;
    }
    renderCsvMapping();
  };
  reader.onerror = function () {
    errorEl.textContent = "Could not read that file.";
    errorEl.classList.add("show");
  };
  reader.readAsText(file);
});

["csv-portfolio-min-input", "csv-portfolio-max-input"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", function () {
    if (!document.getElementById("csv-mapping-section").hidden) renderCsvPreview();
  });
});

document.getElementById("csv-has-header").addEventListener("change", function () {
  const fileInput = document.getElementById("csv-file-input");
  if (fileInput.files[0]) fileInput.dispatchEvent(new Event("change"));
});

function renderCsvMapping() {
  document.getElementById("csv-mapping-section").hidden = false;
  const tbody = document.querySelector("#csv-mapping-table tbody");
  tbody.innerHTML = csvHeaders.map(function (header, colIndex) {
    const guess = guessCsvField(header);
    const sample = (csvRows[0] && csvRows[0][colIndex]) || "";
    return '<tr>' +
      '<td>' + esc(header) + '</td>' +
      '<td class="small-muted">' + esc(sample) + '</td>' +
      '<td><select class="csv-col-map" data-col="' + colIndex + '">' +
        CSV_FIELD_OPTIONS.map(function (opt) { return '<option value="' + opt.value + '"' + (opt.value === guess ? " selected" : "") + '>' + esc(opt.label) + '</option>'; }).join("") +
      '</select></td>' +
      '</tr>';
  }).join("");

  Array.from(tbody.querySelectorAll(".csv-col-map")).forEach(function (select) {
    select.addEventListener("change", renderCsvPreview);
  });

  renderCsvPreview();
}

function currentCsvMapping() {
  const mapping = {}; // field -> column index
  Array.from(document.querySelectorAll(".csv-col-map")).forEach(function (select) {
    if (select.value) mapping[select.value] = Number(select.getAttribute("data-col"));
  });
  return mapping;
}

function normalizePhoneType(raw) {
  const r = String(raw || "").toLowerCase();
  return r === "mobile" ? "Mobile" : r === "landline" ? "Landline" : (raw || "");
}

// Skip-trace exports (Propwire and similar) tend to dump dollar figures as
// raw decimals like "21200000.000000000" -- turns that into "$21,200,000"
// for anything that's purely numeric, and leaves anything already
// formatted (or not a number at all) alone.
function formatMoneyish(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return "$" + Math.round(Number(trimmed)).toLocaleString();
}

// Same idea as formatMoneyish but for a raw decimal percent like
// "100.000000000" -- rounds to "100%".
function formatPercentish(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (!/^-?\d+(\.\d+)?%?$/.test(trimmed)) return trimmed;
  return Math.round(Number(trimmed.replace("%", ""))) + "%";
}

// Same idea as formatMoneyish/formatPercentish but with no unit -- rounds a
// raw decimal like "237.000000000" down to a clean integer string "237",
// leaving anything non-numeric untouched. Used for Ownership Length
// (months), stored as a plain number so it stays filterable rather than
// baked into a formatted sentence.
function formatWholeNumber(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return String(Math.round(Number(trimmed)));
}

// Same idea as formatMoneyish, but also strips "$" and "," first since this
// one reads an admin's own typed-in number (e.g. "500,000" or "$500000"),
// not a raw skip-trace decimal.
function formatAdminMoney(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const cleaned = trimmed.replace(/[$,]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return trimmed;
  return "$" + Math.round(Number(cleaned)).toLocaleString();
}

// Propwire (and similar) let you filter a search by portfolio/estimated
// value, but don't export that value in the CSV -- so there's no per-row
// column to map. This reads the admin's own manually-entered range for the
// whole batch, to use as a fallback wherever a row doesn't already have a
// real per-row Portfolio Value.
function csvPortfolioOverrideValue() {
  const minEl = document.getElementById("csv-portfolio-min-input");
  const maxEl = document.getElementById("csv-portfolio-max-input");
  const min = formatAdminMoney(minEl ? minEl.value : "");
  const max = formatAdminMoney(maxEl ? maxEl.value : "");
  if (min && max) return min + " – " + max;
  if (min) return min + "+";
  if (max) return "Up to " + max;
  return "";
}

// A skip-trace/MLS "Property Type" column ("Multi-Family 5+ Units",
// "Single Family Residence") won't literally match this app's own Asset
// Category vocabulary ("Multifamily (4+ Units)", "Single Family") --
// buyer-matching against a deal's Asset Category is exact-after-
// normalizing-case/whitespace, not fuzzy, so an unmapped value would just
// silently never match anything. Translates the common phrasings; anything
// not recognized (including a genuinely new category name) passes through
// unchanged rather than being dropped, so it's still visible for admin to
// fix or add as its own category.
const ASSET_CATEGORY_ALIASES = [
  { pattern: /single\s*family/i, value: "Single Family" },
  { pattern: /condo|townhouse|town\s*home/i, value: "Condominium / Townhouse" },
  { pattern: /multi.?family.*(5\+|five|5\s*or\s*more)|5\+.*unit/i, value: "Multifamily (4+ Units)" },
  { pattern: /multi.?family.*(2-4|two.*four)|duplex|triplex|fourplex/i, value: "Multifamily (1-4 Units)" },
  { pattern: /vacant\s*land|^land$/i, value: "Residential Vacant Land" },
  { pattern: /commercial/i, value: "Commercial" }
];
function normalizeAssetCategoryValue(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  return trimmed.split(",").map(function (part) {
    const p = part.trim();
    const alias = ASSET_CATEGORY_ALIASES.find(function (a) { return a.pattern.test(p); });
    return alias ? alias.value : p;
  }).join(", ");
}

function mappedCsvRows() {
  const mapping = currentCsvMapping();
  return csvRows
    .filter(function (row) { return row.some(function (cell) { return String(cell || "").trim() !== ""; }); })
    .map(function (row) {
      const get = function (field) { return mapping[field] !== undefined ? String(row[mapping[field]] || "").trim() : ""; };
      // "Last Known Purchase Price" is one free-text field, but a
      // skip-trace export often splits the amount and the date into two
      // columns -- fold the date back in as "$X (date)" (same shape as the
      // field's own placeholder example) instead of losing it.
      const purchasePrice = formatMoneyish(get("lastKnownPurchasePrice"));
      const purchaseDateHint = get("lastPurchaseDateHint");
      // Many skip-trace exports (e.g. Propwire on vacant land) populate the
      // sale date but leave the sale amount blank. Falling back to a bare
      // date here would read as a price in this $-labeled column, so make
      // the "no amount" case explicit instead.
      const lastKnownPurchasePrice = purchasePrice && purchaseDateHint ? purchasePrice + " (" + purchaseDateHint + ")" :
        purchasePrice ? purchasePrice :
        purchaseDateHint ? "Unknown price (sold " + purchaseDateHint + ")" : "";
      // Same fold-in pattern as the purchase price/date above -- equity is
      // a stronger "how liquid is this buyer" signal than raw value alone,
      // so it rides along as "$X (Y% equity)" instead of needing its own
      // separate field. This is the value of the one property in this row
      // (see the CSV_FIELD_OPTIONS note), not the buyer's whole portfolio.
      const estimatedBase = formatMoneyish(get("estimatedPropertyValue"));
      const equityHint = formatPercentish(get("equityHint"));
      const estimatedPropertyValue = estimatedBase && equityHint ? estimatedBase + " (" + equityHint + " equity)" : (estimatedBase || (equityHint ? equityHint + " equity" : ""));
      // Portfolio Value has no per-row CSV source at all -- Propwire and
      // similar tools let you filter a search by it but never export it, so
      // this is always the admin's own manually-entered batch-wide range.
      const portfolioValue = csvPortfolioOverrideValue();
      return {
        buyerName: get("buyerName"), phone: get("phone"), phoneType: normalizePhoneType(get("phoneType")),
        phone2: get("phone2"), phone2Type: normalizePhoneType(get("phone2Type")),
        phone3: get("phone3"), phone3Type: normalizePhoneType(get("phone3Type")),
        city: get("city"), state: get("state"), zip: get("zip"), county: get("county"), email: get("email"),
        assetCategories: normalizeAssetCategoryValue(get("assetCategories")), lastKnownPurchasePrice: lastKnownPurchasePrice,
        estimatedPropertyValue: estimatedPropertyValue,
        portfolioValue: portfolioValue,
        ownershipLengthMonths: formatWholeNumber(get("ownershipLengthMonths")),
        propertyUrl: get("propertyUrl"),
        priceRangeMin: get("priceRangeMin"), priceRangeMax: get("priceRangeMax")
      };
    });
}

// Display-only: "237" months -> "19 yrs". Kept separate from the stored
// raw number (formatWholeNumber above) so the sheet/filter always works off
// the exact figure and this rounding is only ever cosmetic.
function formatOwnershipLengthLabel(monthsRaw) {
  const months = Number(monthsRaw);
  if (!monthsRaw || isNaN(months)) return "";
  const years = Math.floor(months / 12);
  return years >= 1 ? years + (years === 1 ? " yr" : " yrs") : Math.round(months) + " mo";
}

function renderCsvPreview() {
  const rows = mappedCsvRows();
  const tbody = document.querySelector("#csv-preview-table tbody");
  tbody.innerHTML = rows.slice(0, 5).map(function (r) {
    return '<tr>' +
      '<td>' + esc(r.buyerName) + '</td>' + '<td>' + esc(r.phone) + '</td>' + '<td>' + esc(r.phoneType) + '</td>' +
      '<td>' + esc(r.phone2) + (r.phone2 && r.phone2Type ? ' (' + esc(r.phone2Type) + ')' : '') + '</td>' +
      '<td>' + esc(r.phone3) + (r.phone3 && r.phone3Type ? ' (' + esc(r.phone3Type) + ')' : '') + '</td>' +
      '<td>' + esc(r.city) + '</td>' + '<td>' + esc(r.state) + '</td>' + '<td>' + esc(r.zip) + '</td>' +
      '<td>' + esc(r.county) + '</td>' + '<td>' + esc(r.email) + '</td>' + '<td>' + esc(r.assetCategories) + '</td>' +
      '<td>' + esc(r.lastKnownPurchasePrice) + '</td>' +
      '<td>' + esc(r.estimatedPropertyValue) + '</td>' +
      '<td>' + esc(r.portfolioValue) + '</td>' +
      '<td>' + esc(formatOwnershipLengthLabel(r.ownershipLengthMonths)) + '</td>' +
      '<td>' + [r.priceRangeMin, r.priceRangeMax].filter(Boolean).join(" – ") + '</td>' +
      '</tr>';
  }).join("");
  const missingBuyerNameOrPhone = rows.filter(function (r) { return !r.buyerName || !r.phone; }).length;
  const withPropertyUrl = rows.filter(function (r) { return r.propertyUrl; }).length;
  document.getElementById("csv-preview-note").textContent =
    "Showing " + Math.min(5, rows.length) + " of " + rows.length + " row(s)." +
    (missingBuyerNameOrPhone > 0 ? " " + missingBuyerNameOrPhone + " row(s) are missing a Buyer Name or Phone and will be skipped — make sure those are mapped correctly above." : "") +
    (withPropertyUrl > 0 ? " " + withPropertyUrl + " row(s) include a source Property URL that will be saved (not shown in this preview)." : "");
}

// Tracks whichever buyer leads came from the most recent import (CSV or
// paste) so the Filter & Mass-Select bar can offer a "just show what I
// uploaded" view -- otherwise a fresh batch gets lost in however many
// leads were already in the sheet, making it tedious to select just the
// new ones for a deal.
let lastImportedBuyerLeadIds = null;

function markLastImportedBuyerLeads(ids, count, importedAt) {
  lastImportedBuyerLeadIds = new Set(ids || []);
  const row = document.getElementById("buyerleads-lastupload-row");
  const label = document.getElementById("buyerleads-lastupload-label");
  const checkbox = document.getElementById("buyerleads-filter-lastupload");
  if (lastImportedBuyerLeadIds.size === 0) { row.hidden = true; return; }
  // Exact timestamp (not just "the last one"), since it's the same value
  // stored as each lead's own CreatedAt -- with the Uploaded column and the
  // newest/oldest sort, this is what actually lets a dead deal's timeframe
  // get matched back to whichever upload batch the buyers for it came from.
  label.textContent = "Show only the " + count + " lead(s) uploaded " + (importedAt ? formatDate(importedAt) : "just now");
  row.hidden = false;
  checkbox.checked = true;
}

// Rows that duplicated an existing lead by phone/email AND had at least
// one field the existing lead didn't already have a value for -- held
// back from adminImportBuyerLeads for review instead of being written
// automatically, per the "ask before adding, never silently overwrite"
// rule. Field-name -> value pairs on each entry are always a fill-in-the-
// blank operation (see BUYER_LEAD_ENRICHABLE_FIELDS server-side), never a
// conflicting overwrite of something that already has a value.
let pendingMergesCache = [];

function renderMergeReview(pendingMerges) {
  pendingMergesCache = pendingMerges || [];
  const card = document.getElementById("csv-merge-review-card");
  document.getElementById("csv-merge-review-result").textContent = "";
  if (pendingMergesCache.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  document.getElementById("csv-merge-review-list").innerHTML = pendingMergesCache.map(function (m, i) {
    const fieldSummary = Object.keys(m.fields).map(function (f) { return f + ": " + m.fields[f]; }).join(", ");
    return '<div class="item-row">' +
      '<label class="checkbox-row" style="margin:0;"><input type="checkbox" class="csv-merge-item-checkbox" data-index="' + i + '" checked> ' +
        '<strong>' + esc(m.existingName) + '</strong> (' + esc(m.existingPhone) + ') &mdash; matched your upload row for "' + esc(m.newBuyerName) + '"</label>' +
      '<div class="small-muted" style="margin-left:24px; margin-top:2px;">New: ' + esc(fieldSummary) + '</div>' +
      '</div>';
  }).join("");
}

document.getElementById("csv-merge-dismiss-btn").addEventListener("click", function () {
  renderMergeReview([]);
});

document.getElementById("csv-merge-apply-btn").addEventListener("click", async function () {
  const btn = this;
  const checked = Array.from(document.querySelectorAll(".csv-merge-item-checkbox:checked")).map(function (cb) { return pendingMergesCache[Number(cb.getAttribute("data-index"))]; });
  const resultEl = document.getElementById("csv-merge-review-result");
  if (checked.length === 0) { renderMergeReview([]); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("importBuyerLeads", { confirmMerges: checked.map(function (m) { return { buyerLeadId: m.buyerLeadId, fields: m.fields }; }) });
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not add that data."; showToast(res.error || "Could not add that data.", true); return; }
  renderMergeReview([]);
  await loadBuyerLeadsAdmin();
  showToast("Added new data to " + res.mergedCount + " existing lead(s).");
});

document.getElementById("csv-import-btn").addEventListener("click", async function () {
  const btn = this;
  const errorEl = document.getElementById("csv-import-error");
  const resultEl = document.getElementById("csv-import-result");
  errorEl.classList.remove("show");
  resultEl.textContent = "";
  const mapping = currentCsvMapping();
  if (mapping.buyerName === undefined || mapping.phone === undefined) {
    errorEl.textContent = "At least one column must be mapped to Buyer / LLC Name and one to Phone.";
    errorEl.classList.add("show");
    return;
  }
  const rows = mappedCsvRows().filter(function (r) { return r.buyerName && r.phone; });
  if (rows.length === 0) {
    errorEl.textContent = "No rows have both a Buyer Name and a Phone — nothing to import.";
    errorEl.classList.add("show");
    return;
  }
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("importBuyerLeads", { rows: rows });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || "Import failed.";
    errorEl.classList.add("show");
    showToast(res.error || "Import failed.", true);
    return;
  }
  resultEl.textContent = "Imported " + res.imported + " buyer(s)." +
    (res.skippedDuplicates ? " Skipped " + res.skippedDuplicates + " duplicate(s) with nothing new to add." : "") +
    (res.pendingMerges && res.pendingMerges.length > 0 ? " " + res.pendingMerges.length + " duplicate(s) below have new data — review them." : "");
  document.getElementById("csv-file-input").value = "";
  csvRows = []; csvHeaders = [];
  markLastImportedBuyerLeads(res.importedIds, res.imported, res.importedAt);
  renderMergeReview(res.pendingMerges);
  await loadBuyerLeadsAdmin();
  showToast("Imported " + res.imported + " buyer(s).");
});

document.getElementById("buyerleads-import-btn").addEventListener("click", async function () {
  const btn = this;
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
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("importBuyerLeads", { pasteText: text });
  btn.disabled = false;
  if (!res.ok) {
    errorEl.textContent = res.error || "Import failed.";
    errorEl.classList.add("show");
    showToast(res.error || "Import failed.", true);
    return;
  }
  resultEl.textContent = "Imported " + res.imported + " buyer(s)." +
    (res.skippedDuplicates ? " Skipped " + res.skippedDuplicates + " duplicate(s) with nothing new to add." : "") +
    (res.pendingMerges && res.pendingMerges.length > 0 ? " " + res.pendingMerges.length + " duplicate(s) below have new data — review them." : "");
  document.getElementById("buyerleads-import-text").value = "";
  markLastImportedBuyerLeads(res.importedIds, res.imported, res.importedAt);
  renderMergeReview(res.pendingMerges);
  await loadBuyerLeadsAdmin();
  showToast("Imported " + res.imported + " buyer(s).");
});

document.getElementById("bulk-give-btn").addEventListener("click", async function () {
  const btn = this;
  const resultEl = document.getElementById("bulk-give-result");
  const dealId = document.getElementById("bulk-give-deal-select").value;
  const username = document.getElementById("bulk-give-rep-select").value;
  const count = document.getElementById("bulk-give-count").value;
  if (!dealId || !username || !count) { resultEl.textContent = "Pick a deal, a team member, and a count."; return; }
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("adminGiveBuyerLeadsBulk", {
    dealId: dealId, username: username, count: count,
    city: document.getElementById("bulk-give-city").value.trim(),
    state: document.getElementById("bulk-give-state").value.trim(),
    zip: document.getElementById("bulk-give-zip").value.trim()
  });
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not give leads."; showToast(res.error || "Could not give leads.", true); return; }
  resultEl.textContent = "Gave " + res.givenCount + " lead(s) for this deal. " + res.remainingInPool + " still unpitched for it matching that filter.";
  await loadBuyerLeadsAdmin();
  showToast("Gave " + res.givenCount + " lead(s).");
});

async function loadAutoFeedSettings() {
  const res = await api("adminGetAutoFeedSettings", {});
  if (!res.ok) return;
  document.getElementById("autofeed-enabled-input").checked = res.enabled;
  document.getElementById("autofeed-batchsize-input").value = res.batchSize;
}

document.getElementById("autofeed-save-btn").addEventListener("click", async function () {
  const btn = this;
  const resultEl = document.getElementById("autofeed-result");
  btn.disabled = true;
  await api("adminSetAutoFeed", {
    enabled: document.getElementById("autofeed-enabled-input").checked,
    batchSize: document.getElementById("autofeed-batchsize-input").value
  });
  btn.disabled = false;
  resultEl.textContent = "Settings saved.";
  showToast("Auto-feed settings saved.");
});

document.getElementById("autofeed-run-btn").addEventListener("click", async function () {
  const btn = this;
  const resultEl = document.getElementById("autofeed-result");
  if (btn.disabled) return;
  btn.disabled = true;
  resultEl.textContent = "Running…";
  const res = await api("adminRunAutoFeedNow", {});
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not run auto-feed."; showToast(res.error || "Could not run auto-feed.", true); return; }
  if (res.reason) { resultEl.textContent = res.reason; showToast(res.reason); return; }
  resultEl.textContent = res.fed.length === 0
    ? "Nobody needed more leads right now."
    : res.fed.map(function (f) { return f.name + " (" + f.dealAddress + "): +" + f.count; }).join(", ");
  showToast(res.fed.length === 0 ? "Auto-feed ran — nobody needed more leads." : "Auto-feed ran.");
  await loadBuyerLeadsAdmin();
});

document.getElementById("buyerleads-search").addEventListener("input", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-category").addEventListener("change", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-state").addEventListener("input", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-cities").addEventListener("input", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-exclude-cities").addEventListener("input", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-lastupload").addEventListener("change", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-pendingdeal").addEventListener("change", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-sort").addEventListener("change", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-ownertype").addEventListener("change", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-minequity").addEventListener("input", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-minheldyears").addEventListener("input", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });
document.getElementById("buyerleads-filter-hideduplicates").addEventListener("change", function () { buyerLeadsCurrentPage = 1; renderBuyerLeadsAdmin(); });

async function loadBuyerLeadsAdmin() {
  const res = await api("adminGetBuyerLeads", {});
  if (!res.ok) return;
  adminBuyerLeads = res.leads;
  populatePendingDealFilter();
  renderBuyerLeadsAdmin();
}

// adminDeals (loaded once at admin login, see initAdminView) covers every
// deal regardless of status, so a lead tagged for a deal that's since sold
// or gone dead still shows a real label here instead of just its raw ID.
function dealLabelFor(dealId) {
  const deal = adminDeals.find(function (d) { return d.DealID === dealId; });
  if (!deal) return dealId;
  return deal.DealCode ? deal.DealCode + " — " + deal.Address : deal.Address;
}

function populatePendingDealFilter() {
  const select = document.getElementById("buyerleads-filter-pendingdeal");
  const prevValue = select.value;
  const seen = {};
  const dealIds = [];
  adminBuyerLeads.forEach(function (l) {
    if (l.PendingDealID && !seen[l.PendingDealID]) { seen[l.PendingDealID] = true; dealIds.push(l.PendingDealID); }
  });
  select.innerHTML = '<option value="">Any Pending Deal Tag</option>' +
    dealIds.map(function (id) { return '<option value="' + esc(id) + '">' + esc(dealLabelFor(id)) + '</option>'; }).join("");
  if (dealIds.indexOf(prevValue) !== -1) select.value = prevValue;
}

const BUYER_LEADS_PAGE_SIZE = 50;
let buyerLeadsCurrentPage = 1;
let buyerLeadsSelectedIds = new Set();

// A skip-trace/company-owned property is often held by a more active,
// sophisticated investor than an individual owner -- useful to filter on
// for dispositions outreach. Derived on the fly from BuyerName rather than
// stored as its own field, since the name itself is already the source of
// truth (an LLC name doesn't stop being an LLC name).
function isCompanyBuyerName(name) {
  return /\b(llc|inc|incorporated|corp|corporation|trust|lp|llp|ltd|company|co\.?|holdings|group|partners|properties|investments|capital)\b/i.test(String(name || ""));
}

// Estimated Value folds equity in as a "(NN% equity)" suffix (see
// mappedCsvRows) -- pulled back out here for filtering rather than stored
// as a separate number, so there's one source of truth for the figure
// instead of two copies that could drift apart.
function extractEquityPercent(estimatedPropertyValue) {
  const m = /\((\d+)%\s*equity\)/i.exec(String(estimatedPropertyValue || ""));
  return m ? Number(m[1]) : null;
}

function getFilteredBuyerLeads() {
  const q = document.getElementById("buyerleads-search").value.trim().toLowerCase();
  const category = document.getElementById("buyerleads-filter-category").value;
  const state = document.getElementById("buyerleads-filter-state").value.trim().toLowerCase();
  // Same comma-separated, case/whitespace-insensitive convention as a
  // deal's "Also Match These Cities" -- lets admin mass-select buyers
  // across several cities in one state at once (e.g. "Phoenix, Tempe,
  // Mesa") instead of only ever being able to filter to one exact city.
  const cities = document.getElementById("buyerleads-filter-cities").value
    .split(",").map(function (c) { return c.trim().toLowerCase(); }).filter(Boolean);
  // Excluded cities apply on top of everything else -- e.g. State = AZ,
  // Exclude Cities = "Phoenix" gets every Arizona buyer except Phoenix
  // ones, useful for carving a saturated city out of an otherwise broad
  // state-wide mass-select.
  const excludeCities = document.getElementById("buyerleads-filter-exclude-cities").value
    .split(",").map(function (c) { return c.trim().toLowerCase(); }).filter(Boolean);
  const lastUploadOnly = !document.getElementById("buyerleads-lastupload-row").hidden &&
    document.getElementById("buyerleads-filter-lastupload").checked;
  const pendingDeal = document.getElementById("buyerleads-filter-pendingdeal").value;
  const sortMode = document.getElementById("buyerleads-sort").value;
  const ownerType = document.getElementById("buyerleads-filter-ownertype").value;
  const minEquityRaw = document.getElementById("buyerleads-filter-minequity").value.trim();
  const minEquity = minEquityRaw === "" ? null : Number(minEquityRaw);
  const minHeldYearsRaw = document.getElementById("buyerleads-filter-minheldyears").value.trim();
  const minHeldMonths = minHeldYearsRaw === "" ? null : Number(minHeldYearsRaw) * 12;
  const hideDuplicates = document.getElementById("buyerleads-filter-hideduplicates").checked;
  const filtered = adminBuyerLeads.filter(function (l) {
    if (hideDuplicates && l.DuplicateOfBuyerLeadID) return false;
    if (q && ![l.BuyerName, l.Phone, l.Email, l.City, l.State, l.Zip, l.County].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; })) return false;
    if (category && (l.AssetCategories || "").split(",").map(function (c) { return c.trim().toLowerCase(); }).indexOf(category.toLowerCase()) === -1) return false;
    if (state && String(l.State || "").trim().toLowerCase() !== state) return false;
    if (cities.length > 0 && cities.indexOf(String(l.City || "").trim().toLowerCase()) === -1) return false;
    if (excludeCities.length > 0 && excludeCities.indexOf(String(l.City || "").trim().toLowerCase()) !== -1) return false;
    if (lastUploadOnly && !(lastImportedBuyerLeadIds && lastImportedBuyerLeadIds.has(l.BuyerLeadID))) return false;
    if (pendingDeal && l.PendingDealID !== pendingDeal) return false;
    if (ownerType === "company" && !isCompanyBuyerName(l.BuyerName)) return false;
    if (ownerType === "individual" && isCompanyBuyerName(l.BuyerName)) return false;
    if (minEquity !== null) {
      const equity = extractEquityPercent(l.EstimatedPropertyValue);
      if (equity === null || equity < minEquity) return false;
    }
    if (minHeldMonths !== null) {
      const months = Number(l.OwnershipLengthMonths);
      if (!l.OwnershipLengthMonths || isNaN(months) || months < minHeldMonths) return false;
    }
    return true;
  });
  // Lets admin browse chronologically by upload batch -- e.g. line up when
  // a deal went dead against which round of leads came in around then,
  // without needing to hunt across paginated default (sheet-insertion)
  // order for a specific date.
  if (sortMode === "newest") {
    filtered.sort(function (a, b) { return new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0); });
  } else if (sortMode === "oldest") {
    filtered.sort(function (a, b) { return new Date(a.CreatedAt || 0) - new Date(b.CreatedAt || 0); });
  }
  return filtered;
}

function renderBuyerLeadsAdmin() {
  const tbody = document.getElementById("buyerleads-tbody");
  const empty = document.getElementById("buyerleads-admin-empty");
  const filtered = getFilteredBuyerLeads();
  empty.hidden = filtered.length > 0;

  const totalPages = Math.max(1, Math.ceil(filtered.length / BUYER_LEADS_PAGE_SIZE));
  if (buyerLeadsCurrentPage > totalPages) buyerLeadsCurrentPage = totalPages;
  const pageStart = (buyerLeadsCurrentPage - 1) * BUYER_LEADS_PAGE_SIZE;
  const pageItems = filtered.slice(pageStart, pageStart + BUYER_LEADS_PAGE_SIZE);

  document.getElementById("buyerleads-page-indicator").textContent =
    filtered.length === 0 ? "No results" :
    "Page " + buyerLeadsCurrentPage + " of " + totalPages + " (" + filtered.length + " total)";
  document.getElementById("buyerleads-prev-page-btn").disabled = buyerLeadsCurrentPage <= 1;
  document.getElementById("buyerleads-next-page-btn").disabled = buyerLeadsCurrentPage >= totalPages;

  tbody.innerHTML = pageItems.map(function (l) {
    const notesPreview = l.GeneralNotes ? (l.GeneralNotes.length > 60 ? l.GeneralNotes.slice(0, 60) + "…" : l.GeneralNotes) : "";
    const isDnc = !!(l.DoNotContact === true || l.DoNotContact === "TRUE");
    const checked = buyerLeadsSelectedIds.has(l.BuyerLeadID) ? " checked" : "";
    return '<tr>' +
      '<td><input type="checkbox" class="buyerlead-select-checkbox" data-lead-id="' + esc(l.BuyerLeadID) + '"' + checked + (isDnc ? " disabled" : "") + '></td>' +
      '<td>' + esc(l.BuyerName) + (isCompanyBuyerName(l.BuyerName) ? ' <span class="status-pill status-fully-worked">Co</span>' : "") +
        (l.DuplicateOfBuyerLeadID ? ' <span class="status-pill status-onhold" title="Same phone/email as an existing lead">Possible Dup</span>' : "") +
        (isDnc ? ' <span class="status-pill status-dead-match">DNC</span>' : "") + '</td>' +
      '<td>' + esc(l.Phone) + '</td>' +
      '<td>' + esc(l.Email || "") + '</td>' +
      '<td>' + esc(l.PhoneType || "") + '</td>' +
      '<td>' + [l.City, l.State, l.Zip, l.County ? l.County + " County" : ""].filter(Boolean).join(", ") + '</td>' +
      '<td class="small-muted">' + (l.PortfolioValue ? esc(l.PortfolioValue) : "&mdash;") + '</td>' +
      '<td class="small-muted">' + esc(l.AssetCategories || "") + '</td>' +
      '<td class="small-muted">' + esc(notesPreview) + '</td>' +
      '<td class="small-muted">' + (l.PendingDealID ? esc(dealLabelFor(l.PendingDealID)) : "&mdash;") + '</td>' +
      '<td class="small-muted">' + (l.CreatedAt ? formatDate(l.CreatedAt) : "&mdash;") + '</td>' +
      '<td class="small-muted">' + (l.UploadedBy ? esc(l.UploadedBy) : "&mdash;") + '</td>' +
      '<td>' + (l.openPitches.length || "&mdash;") + '</td>' +
      '<td style="white-space:nowrap;"><button class="btn secondary small view-buyer-btn" data-lead-id="' + esc(l.BuyerLeadID) + '">View / Give</button></td>' +
      '</tr>';
  }).join("");

  Array.from(tbody.querySelectorAll(".view-buyer-btn")).forEach(function (btn) {
    btn.addEventListener("click", function () { openAdminBuyerLeadDetail(btn.getAttribute("data-lead-id")); });
  });
  Array.from(tbody.querySelectorAll(".buyerlead-select-checkbox")).forEach(function (cb) {
    cb.addEventListener("change", function () {
      const id = cb.getAttribute("data-lead-id");
      if (cb.checked) buyerLeadsSelectedIds.add(id); else buyerLeadsSelectedIds.delete(id);
      updateBuyerLeadsSelectionUI();
    });
  });
  updateBuyerLeadsSelectionUI();
}

function updateBuyerLeadsSelectionUI() {
  const count = buyerLeadsSelectedIds.size;
  document.getElementById("buyerleads-selection-count").textContent = count + " selected";
  document.getElementById("buyerleads-give-selected-row").hidden = count === 0;
  document.getElementById("buyerleads-mass-edit-card").hidden = count === 0;
  document.getElementById("mass-edit-count").textContent = count;
}

document.getElementById("buyerleads-prev-page-btn").addEventListener("click", function () {
  if (buyerLeadsCurrentPage > 1) { buyerLeadsCurrentPage--; renderBuyerLeadsAdmin(); }
});
document.getElementById("buyerleads-next-page-btn").addEventListener("click", function () {
  buyerLeadsCurrentPage++; renderBuyerLeadsAdmin();
});

document.getElementById("buyerleads-select-page-btn").addEventListener("click", function () {
  Array.from(document.querySelectorAll(".buyerlead-select-checkbox:not(:disabled)")).forEach(function (cb) {
    buyerLeadsSelectedIds.add(cb.getAttribute("data-lead-id"));
  });
  renderBuyerLeadsAdmin();
});

document.getElementById("buyerleads-select-first-n-btn").addEventListener("click", function () {
  const n = Number(document.getElementById("buyerleads-select-n").value) || 0;
  const filtered = getFilteredBuyerLeads().filter(function (l) { return !(l.DoNotContact === true || l.DoNotContact === "TRUE"); });
  buyerLeadsSelectedIds = new Set(filtered.slice(0, n).map(function (l) { return l.BuyerLeadID; }));
  buyerLeadsCurrentPage = 1;
  renderBuyerLeadsAdmin();
});

document.getElementById("buyerleads-clear-selection-btn").addEventListener("click", function () {
  buyerLeadsSelectedIds = new Set();
  renderBuyerLeadsAdmin();
});

document.getElementById("give-selected-btn").addEventListener("click", async function () {
  const btn = this;
  const resultEl = document.getElementById("give-selected-result");
  const dealId = document.getElementById("give-selected-deal-select").value;
  const username = document.getElementById("give-selected-rep-select").value;
  if (!dealId || buyerLeadsSelectedIds.size === 0) {
    resultEl.textContent = "Pick a deal and at least one buyer.";
    return;
  }
  if (btn.disabled) return;
  btn.disabled = true;

  // Leaving the rep dropdown on "tag only" just earmarks the selection for
  // this deal (adminTagBuyerLeadsForDeal) -- no pitch, nobody's queue
  // changes. Picking an actual team member gives them a real pitch right
  // away, same as before.
  if (!username) {
    const res = await api("adminTagBuyerLeadsForDeal", { dealId: dealId, buyerLeadIds: Array.from(buyerLeadsSelectedIds) });
    btn.disabled = false;
    if (!res.ok) { resultEl.textContent = res.error || "Could not tag leads."; showToast(res.error || "Could not tag leads.", true); return; }
    resultEl.textContent = "Tagged " + res.taggedCount + " lead(s) for " + dealLabelFor(dealId) + ".";
    buyerLeadsSelectedIds = new Set();
    await loadBuyerLeadsAdmin();
    showToast("Tagged " + res.taggedCount + " lead(s).");
    return;
  }

  const res = await api("adminGiveSelectedBuyerLeads", { dealId: dealId, username: username, buyerLeadIds: Array.from(buyerLeadsSelectedIds) });
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not give leads."; showToast(res.error || "Could not give leads.", true); return; }
  resultEl.textContent = "Gave " + res.givenCount + " lead(s)." + (res.skipped ? " Skipped " + res.skipped + " (Do Not Contact or already pitched for this deal)." : "");
  buyerLeadsSelectedIds = new Set();
  await loadBuyerLeadsAdmin();
  showToast("Gave " + res.givenCount + " lead(s).");
});

document.getElementById("mass-edit-apply-btn").addEventListener("click", async function () {
  const btn = this;
  const resultEl = document.getElementById("mass-edit-result");
  if (buyerLeadsSelectedIds.size === 0) { resultEl.textContent = "No leads selected."; return; }

  const data = {};
  if (document.getElementById("mass-edit-apply-categories").checked) {
    data.assetCategories = Array.from(document.querySelectorAll(".mass-edit-category-checkbox:checked")).map(function (cb) { return cb.value; }).join(", ");
  }
  if (document.getElementById("mass-edit-apply-county").checked) {
    data.county = document.getElementById("mass-edit-county-input").value.trim();
  }
  if (document.getElementById("mass-edit-apply-lastpurchase").checked) {
    data.lastKnownPurchasePrice = document.getElementById("mass-edit-lastpurchase-input").value.trim();
  }
  if (document.getElementById("mass-edit-apply-estimatedvalue").checked) {
    data.estimatedPropertyValue = document.getElementById("mass-edit-estimatedvalue-input").value.trim();
  }
  if (document.getElementById("mass-edit-apply-portfolio").checked) {
    data.portfolioValue = document.getElementById("mass-edit-portfolio-input").value.trim();
  }
  if (document.getElementById("mass-edit-apply-pricerange").checked) {
    data.priceRangeMin = document.getElementById("mass-edit-pricemin-input").value.trim();
    data.priceRangeMax = document.getElementById("mass-edit-pricemax-input").value.trim();
  }
  if (Object.keys(data).length === 0) { resultEl.textContent = "Check at least one field to apply."; return; }

  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("adminBulkUpdateBuyerLeads", { buyerLeadIds: Array.from(buyerLeadsSelectedIds), data: data });
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not apply changes."; showToast(res.error || "Could not apply changes.", true); return; }
  resultEl.textContent = "Updated " + res.updatedCount + " lead(s).";
  await loadBuyerLeadsAdmin();
  showToast("Updated " + res.updatedCount + " lead(s).");
});

/* ---------- Duplicate buyers (find + merge) ---------- */

document.getElementById("find-duplicates-btn").addEventListener("click", async function () {
  const btn = this;
  const resultEl = document.getElementById("duplicates-result");
  if (btn.disabled) return;
  btn.disabled = true;
  resultEl.textContent = "Scanning…";
  const res = await api("adminFindDuplicateBuyerLeads", {});
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not scan for duplicates."; return; }
  renderDuplicateGroups(res.groups);
  resultEl.textContent = res.groups.length === 0
    ? "No duplicates found — every lead has a unique phone and email."
    : "Found " + res.groups.length + " group(s) sharing a phone or email.";
});

function renderDuplicateGroups(groups) {
  const container = document.getElementById("duplicates-groups");
  if (groups.length === 0) { container.innerHTML = ""; return; }

  container.innerHTML = groups.map(function (group, groupIndex) {
    // Default to keeping whichever lead has the most work already logged
    // against it (pitches + contacts), tie-broken by whichever was created
    // first -- the one most likely to be the "real" record worth keeping.
    const defaultKeepId = group.slice().sort(function (a, b) {
      const scoreDiff = (b.pitchCount + b.contactCount) - (a.pitchCount + a.contactCount);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    })[0].buyerLeadId;

    return '<div class="item-row" data-group-index="' + groupIndex + '" style="margin-top:12px;">' +
      '<div style="margin-bottom:6px;"><strong>' + group.length + ' possible duplicates</strong> — pick which one to keep:</div>' +
      group.map(function (l) {
        return '<label class="checkbox-row" style="align-items:flex-start;">' +
          '<input type="radio" name="dup-keep-' + groupIndex + '" value="' + esc(l.buyerLeadId) + '"' + (l.buyerLeadId === defaultKeepId ? " checked" : "") + '>' +
          '<span>' +
            '<strong>' + esc(l.buyerName || "(no name)") + '</strong>' +
            (l.doNotContact ? ' <span class="status-pill status-dead-match">DNC</span>' : "") +
            '<div class="small-muted">' +
              [l.phone, l.email].filter(Boolean).join(" &middot; ") +
              ([l.city, l.state].filter(Boolean).length ? ' &middot; ' + [l.city, l.state].filter(Boolean).join(", ") : "") +
              ' &middot; ' + l.pitchCount + ' pitch(es), ' + l.contactCount + ' contact(s) logged' +
              (l.createdAt ? ' &middot; added ' + formatDate(l.createdAt) : "") +
            '</div>' +
          '</span>' +
        '</label>';
      }).join("") +
      '<div class="nav-row" style="justify-content:flex-end; margin-top:6px;">' +
        '<button class="btn primary small dup-merge-btn" data-group-index="' + groupIndex + '">Merge This Group</button>' +
      '</div>' +
    '</div>';
  }).join("");

  window.__duplicateGroups = groups;

  Array.from(container.querySelectorAll(".dup-merge-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const groupIndex = Number(btn.getAttribute("data-group-index"));
      const group = window.__duplicateGroups[groupIndex];
      const selected = container.querySelector('input[name="dup-keep-' + groupIndex + '"]:checked');
      if (!selected) { showToast("Pick which lead to keep first.", true); return; }
      const keepId = selected.value;
      const mergeIds = group.map(function (l) { return l.buyerLeadId; }).filter(function (id) { return id !== keepId; });

      if (btn.disabled) return;
      btn.disabled = true;
      const res = await api("adminMergeBuyerLeads", { keepId: keepId, mergeIds: mergeIds });
      if (!res.ok) { btn.disabled = false; showToast(res.error || "Could not merge this group.", true); return; }
      const groupEl = container.querySelector('.item-row[data-group-index="' + groupIndex + '"]');
      if (groupEl) groupEl.remove();
      await loadBuyerLeadsAdmin();
      showToast("Merged " + res.mergedCount + " duplicate(s).");
    });
  });
}

// Shared by the admin buyer detail panel and the rep's pitch detail panel
// -- both edit the exact same set of fields via updateBuyerLeadProfile,
// which the backend now permits for either an admin or a rep with an open
// pitch on this one buyer (one lead at a time; mass-editing many at once
// is admin-only, see the Buyer Leads tab's Mass Edit section). `prefix`
// keeps element ids distinct between the two contexts (e.g. "admin" vs
// "rep") so both can exist in the DOM without colliding.
function renderBuyerProfileFields(lead, prefix) {
  const leadCats = (lead.AssetCategories || "").split(",").map(function (c) { return c.trim().toLowerCase(); });
  return (
    '<div class="section-title" style="margin-top:0;">Phone Numbers</div>' +
    '<div class="row2">' +
      '<div><label class="field-label">Phone</label><input type="text" id="' + prefix + '-buyer-phone-input" value="' + esc(lead.Phone || "") + '"></div>' +
      '<div><label class="field-label">Type</label><select id="' + prefix + '-buyer-phonetype-input"><option value="Mobile"' + (lead.PhoneType === "Mobile" ? " selected" : "") + '>Mobile</option><option value="Landline"' + (lead.PhoneType === "Landline" ? " selected" : "") + '>Landline</option></select></div>' +
    '</div>' +
    '<div class="row2">' +
      '<div><label class="field-label">Phone 2</label><input type="text" id="' + prefix + '-buyer-phone2-input" value="' + esc(lead.Phone2 || "") + '"></div>' +
      '<div><label class="field-label">Type</label><select id="' + prefix + '-buyer-phone2type-input"><option value="">&mdash;</option><option value="Mobile"' + (lead.Phone2Type === "Mobile" ? " selected" : "") + '>Mobile</option><option value="Landline"' + (lead.Phone2Type === "Landline" ? " selected" : "") + '>Landline</option></select></div>' +
    '</div>' +
    '<div class="row2">' +
      '<div><label class="field-label">Phone 3</label><input type="text" id="' + prefix + '-buyer-phone3-input" value="' + esc(lead.Phone3 || "") + '"></div>' +
      '<div><label class="field-label">Type</label><select id="' + prefix + '-buyer-phone3type-input"><option value="">&mdash;</option><option value="Mobile"' + (lead.Phone3Type === "Mobile" ? " selected" : "") + '>Mobile</option><option value="Landline"' + (lead.Phone3Type === "Landline" ? " selected" : "") + '>Landline</option></select></div>' +
    '</div>' +
    '<div class="row2">' +
      '<div><label class="field-label">Email</label><input type="text" id="' + prefix + '-buyer-email-input" value="' + esc(lead.Email || "") + '" placeholder="buyer@example.com"></div>' +
      '<div><label class="field-label">County</label><input type="text" id="' + prefix + '-buyer-county-input" value="' + esc(lead.County || "") + '"></div>' +
    '</div>' +
    '<label class="field-label">Buyer Documents Drive Link <span class="small-muted">(proof of funds, signed agreements, etc.)</span></label>' +
    '<input type="text" id="' + prefix + '-buyer-drivelink-input" value="' + esc(lead.DriveLink || "") + '" placeholder="https://drive.google.com/...">' +
    '<label class="field-label">Last Known Purchase Price <span class="small-muted">(informational — an asset we found they bought, suggests a similar price range)</span></label>' +
    '<input type="text" id="' + prefix + '-buyer-lastpurchase-input" value="' + esc(lead.LastKnownPurchasePrice || "") + '" placeholder="e.g. $180,000 (Phoenix, 2023)">' +
    '<label class="field-label">Estimated Value <span class="small-muted">(informational — current estimated value of one specific property we found they own)</span></label>' +
    '<input type="text" id="' + prefix + '-buyer-estimatedvalue-input" value="' + esc(lead.EstimatedPropertyValue || "") + '" placeholder="e.g. $180,000 (100% equity)">' +
    '<label class="field-label">Portfolio Value <span class="small-muted">(informational — total value of real estate we believe they own across their whole portfolio, a signal of how well-capitalized they are)</span></label>' +
    '<input type="text" id="' + prefix + '-buyer-portfolio-input" value="' + esc(lead.PortfolioValue || "") + '" placeholder="e.g. $500,000 – $1,000,000">' +
    '<div class="row2">' +
      '<div><label class="field-label">Ownership Length <span class="small-muted">(months, on the one property above — a long hold on vacant land can signal an inherited or low-priority parcel)</span></label><input type="text" id="' + prefix + '-buyer-ownershiplength-input" value="' + esc(lead.OwnershipLengthMonths || "") + '" placeholder="e.g. 237"></div>' +
      // Source Listing URL is admin-only -- not shown to reps. See
      // ADMIN_ONLY_PROFILE_FIELDS in Code.gs, which backs this up
      // server-side too (a rep can't write it even via a direct API call).
      (prefix === "admin" ? '<div><label class="field-label">Source Listing URL</label><input type="text" id="' + prefix + '-buyer-propertyurl-input" value="' + esc(lead.PropertyURL || "") + '" placeholder="https://propwire.com/..."></div>' : '<div></div>') +
    '</div>' +
    '<label class="field-label">Price Range Buyer Has Told Us They Want <span class="small-muted">(if known — used for matching)</span></label>' +
    '<div class="row2">' +
      '<div><input type="text" id="' + prefix + '-buyer-pricemin-input" value="' + esc(lead.PriceRangeMin || "") + '" placeholder="Min"></div>' +
      '<div><input type="text" id="' + prefix + '-buyer-pricemax-input" value="' + esc(lead.PriceRangeMax || "") + '" placeholder="Max"></div>' +
    '</div>' +
    '<label class="field-label">Asset Categories <span class="small-muted">(what this buyer wants — used for matching; leave all unchecked to match any deal)</span></label>' +
    '<div class="chip-list">' +
      assetCategoryOptionsCache.map(function (c) {
        const checked = leadCats.indexOf(c.toLowerCase()) !== -1 ? " checked" : "";
        return '<label class="checkbox-row" style="margin:0 12px 6px 0;"><input type="checkbox" class="' + prefix + '-buyer-category-checkbox" value="' + esc(c) + '"' + checked + '> ' + esc(c) + '</label>';
      }).join("") +
    '</div>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="' + prefix + '-buyer-profile-save-btn">Save Buyer Info</button>' +
    '</div>'
  );
}

function wireBuyerProfileFieldsHandlers(prefix, buyerLeadId, onSaved) {
  const btn = document.getElementById(prefix + "-buyer-profile-save-btn");
  btn.addEventListener("click", async function () {
    if (btn.disabled) return;
    btn.disabled = true;
    const payload = {
      buyerLeadId: buyerLeadId,
      phone: document.getElementById(prefix + "-buyer-phone-input").value.trim(),
      phoneType: document.getElementById(prefix + "-buyer-phonetype-input").value,
      phone2: document.getElementById(prefix + "-buyer-phone2-input").value.trim(),
      phone2Type: document.getElementById(prefix + "-buyer-phone2type-input").value,
      phone3: document.getElementById(prefix + "-buyer-phone3-input").value.trim(),
      phone3Type: document.getElementById(prefix + "-buyer-phone3type-input").value,
      email: document.getElementById(prefix + "-buyer-email-input").value.trim(),
      driveLink: document.getElementById(prefix + "-buyer-drivelink-input").value.trim(),
      county: document.getElementById(prefix + "-buyer-county-input").value.trim(),
      lastKnownPurchasePrice: document.getElementById(prefix + "-buyer-lastpurchase-input").value.trim(),
      estimatedPropertyValue: document.getElementById(prefix + "-buyer-estimatedvalue-input").value.trim(),
      portfolioValue: document.getElementById(prefix + "-buyer-portfolio-input").value.trim(),
      ownershipLengthMonths: document.getElementById(prefix + "-buyer-ownershiplength-input").value.trim(),
      priceRangeMin: document.getElementById(prefix + "-buyer-pricemin-input").value.trim(),
      priceRangeMax: document.getElementById(prefix + "-buyer-pricemax-input").value.trim(),
      assetCategories: Array.from(document.querySelectorAll("." + prefix + "-buyer-category-checkbox:checked")).map(function (cb) { return cb.value; }).join(", ")
    };
    // Source Listing URL field only exists in the DOM for admin -- see the
    // matching prefix === "admin" gate in renderBuyerProfileFields.
    const propertyUrlInput = document.getElementById(prefix + "-buyer-propertyurl-input");
    if (propertyUrlInput) payload.propertyUrl = propertyUrlInput.value.trim();
    const res = await api("updateBuyerLeadProfile", payload);
    if (!res.ok) { btn.disabled = false; showToast(res.error || "Could not save buyer info.", true); return; }
    showToast("Buyer info saved.");
    await onSaved();
  });
}

async function openAdminBuyerLeadDetail(buyerLeadId) {
  const lead = adminBuyerLeads.find(function (l) { return l.BuyerLeadID === buyerLeadId; });
  if (!lead) return;

  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const needsSelects = buyerLeadsActiveReps.length === 0 || buyerLeadsActiveDeals.length === 0;
  const [pitchesRes] = await Promise.all([
    api("adminGetPitchesForBuyerLead", { buyerLeadId: buyerLeadId }),
    needsSelects ? populateBulkGiveSelects() : Promise.resolve()
  ]);
  const pitches = pitchesRes.ok ? pitchesRes.pitches : [];

  // Every active deal is givable, even ones this buyer already has a pitch
  // on -- multiple reps can share a buyer+deal (e.g. two people covering
  // the same market), so the only real restriction is giving the exact
  // same rep the exact same buyer+deal twice, which the backend rejects
  // with a clear error rather than this list needing to guess it in advance.
  const givableDeals = buyerLeadsActiveDeals;

  const isDnc = !!(lead.DoNotContact === true || lead.DoNotContact === "TRUE");

  panel.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div><h2 class="step-title">' + esc(lead.BuyerName) + '</h2>' +
      '<p class="step-sub">' + esc(lead.Phone) + ' &middot; ' + esc(lead.PhoneType || "") +
      ([lead.City, lead.State, lead.Zip].filter(Boolean).length ? ' &middot; ' + [lead.City, lead.State, lead.Zip].filter(Boolean).join(", ") : "") + '</p></div>' +
      '<button class="link-btn" id="close-detail-btn">Close</button>' +
    '</div>' +

    (isDnc ? '<div class="banner danger"><strong>Do Not Contact.</strong> No rep can log a new call/text for this buyer, and they can\'t be given a new pitch.</div>' : "") +

    renderBuyerProfileFields(lead, "admin") +

    '<div class="section-title">General Buyer Notes</div>' +
    '<p class="small-muted">Shared across every deal this buyer is ever pitched — ARV%, price range, areas of interest, cash vs. financed, etc.</p>' +
    '<textarea id="admin-general-notes-input">' + esc(lead.GeneralNotes || "") + '</textarea>' +
    '<div class="nav-row" style="justify-content:flex-end;">' +
      '<button class="btn secondary" id="admin-general-notes-save-btn">Save Notes</button>' +
    '</div>' +

    (isDnc ? '' :
    '<div class="section-title">Give For a Deal</div>' +
    '<p class="small-muted">Works even for a deal this buyer\'s already been given for — picks a different team member, not a different lead, so more than one person can cover the same deal.</p>' +
    (givableDeals.length > 0
      ? '<div class="row2">' +
          '<div><select id="give-new-deal-select">' + givableDeals.map(function (d) { return '<option value="' + esc(d.DealID) + '">' + esc(d.DealCode ? d.DealCode + " — " + d.Address : d.Address) + '</option>'; }).join("") + '</select></div>' +
          '<div><select id="give-new-rep-select">' + buyerLeadsActiveReps.map(function (r) { return '<option value="' + esc(r.username) + '">' + esc(r.name) + (r.isAdmin ? " — Admin" : "") + '</option>'; }).join("") + '</select></div>' +
        '</div>' +
        '<div class="nav-row" style="justify-content:flex-end;"><button class="btn primary small" id="give-new-pitch-btn">Give This Buyer Lead To</button></div>'
      : '<p class="small-muted">No active deals yet.</p>')) +

    '<div class="section-title">Pitches</div>' +
    '<div id="pitches-list">' + renderAdminPitchesList(pitches) + '</div>' +

    '<div class="section-title">Do Not Contact</div>' +
    '<p class="small-muted">Blocks any rep from logging a new call/text against this buyer and stops them from being given a new pitch. Existing pitch history is kept.</p>' +
    '<button class="btn ' + (isDnc ? "secondary" : "danger") + ' small" id="admin-dnc-toggle-btn">' + (isDnc ? "Allow Contact Again" : "Mark Do Not Contact") + '</button>';

  document.getElementById("close-detail-btn").addEventListener("click", function () { overlay.hidden = true; loadBuyerLeadsAdmin(); });

  document.getElementById("admin-general-notes-save-btn").addEventListener("click", async function () {
    const btn = this;
    if (btn.disabled) return;
    btn.disabled = true;
    await api("updateBuyerLeadNotes", { buyerLeadId: buyerLeadId, notes: document.getElementById("admin-general-notes-input").value.trim() });
    await loadBuyerLeadsAdmin();
    showToast("Notes saved.");
  });

  wireBuyerProfileFieldsHandlers("admin", buyerLeadId, async function () {
    await loadBuyerLeadsAdmin();
    openAdminBuyerLeadDetail(buyerLeadId);
  });

  document.getElementById("admin-dnc-toggle-btn").addEventListener("click", async function () {
    const btn = this;
    if (btn.disabled) return;
    btn.disabled = true;
    const willBeDnc = !isDnc;
    await api("updateBuyerLeadDoNotContact", { buyerLeadId: buyerLeadId, doNotContact: willBeDnc });
    await loadBuyerLeadsAdmin();
    openAdminBuyerLeadDetail(buyerLeadId);
    showToast(willBeDnc ? "Marked Do Not Contact." : "Contact allowed again.");
  });

  const giveBtn = document.getElementById("give-new-pitch-btn");
  if (giveBtn) {
    giveBtn.addEventListener("click", async function () {
      if (giveBtn.disabled) return;
      giveBtn.disabled = true;
      giveBtn.textContent = "Giving…";
      const dealId = document.getElementById("give-new-deal-select").value;
      const username = document.getElementById("give-new-rep-select").value;
      const res = await api("adminGiveBuyerLeadToRep", { buyerLeadId: buyerLeadId, dealId: dealId, username: username });
      if (!res.ok) {
        giveBtn.disabled = false;
        giveBtn.textContent = "Give This Buyer Lead To";
        showToast(res.error || "Could not give this buyer lead.", true);
        return;
      }
      openAdminBuyerLeadDetail(buyerLeadId);
      showToast("Buyer given.");
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
          buyerLeadsActiveReps.map(function (r) { return '<option value="' + esc(r.username) + '"' + (r.username === p.Username ? " selected" : "") + '>' + esc(r.name) + (r.isAdmin ? " — Admin" : "") + '</option>'; }).join("") +
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
      if (btn.disabled) return;
      btn.disabled = true;
      const pitchId = btn.getAttribute("data-pitch-id");
      const select = panel.querySelector('.pitch-reassign-select[data-pitch-id="' + pitchId + '"]');
      const res = await api("adminReassignPitch", { pitchId: pitchId, username: select.value });
      if (!res.ok) { btn.disabled = false; showToast(res.error || "Could not reassign.", true); return; }
      openAdminBuyerLeadDetail(buyerLeadId);
      showToast("Pitch reassigned.");
    });
  });
  Array.from(panel.querySelectorAll(".pitch-withdraw-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      if (btn.disabled) return;
      btn.disabled = true;
      const res = await api("adminWithdrawPitch", { pitchId: btn.getAttribute("data-pitch-id") });
      if (!res.ok) { btn.disabled = false; showToast(res.error || "Could not withdraw.", true); return; }
      openAdminBuyerLeadDetail(buyerLeadId);
      showToast("Pitch withdrawn.");
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

/* ---------- Pitches tab (whole-team view; find & pull back any rep's
   leads without hunting through each buyer's detail panel first) ---------- */

let adminAllPitches = [];
let adminPitchesSelectedIds = new Set();
let pitchesFilterRepsCache = [];
let pitchesFilterDealsCache = [];

async function initAdminPitchesTab() {
  const [repsRes, dealsRes] = await Promise.all([api("adminGetReps", {}), api("getDeals", {})]);
  if (repsRes.ok) pitchesFilterRepsCache = repsRes.reps;
  if (dealsRes.ok) pitchesFilterDealsCache = dealsRes.deals;

  document.getElementById("pitches-filter-rep").innerHTML = '<option value="">All Team Members</option>' +
    pitchesFilterRepsCache.map(function (r) { return '<option value="' + esc(r.username) + '">' + esc(r.name) + (r.isAdmin ? " — Admin" : "") + '</option>'; }).join("");
  document.getElementById("pitches-filter-deal").innerHTML = '<option value="">All Deals</option>' +
    pitchesFilterDealsCache.map(function (d) { return '<option value="' + esc(d.DealID) + '">' + esc(d.DealCode ? d.DealCode + " — " + d.Address : d.Address) + '</option>'; }).join("");
  document.getElementById("pitches-reassign-selected-select").innerHTML =
    pitchesFilterRepsCache.map(function (r) { return '<option value="' + esc(r.username) + '">' + esc(r.name) + (r.isAdmin ? " — Admin" : "") + '</option>'; }).join("");

  await loadAdminPitches();
}

async function loadAdminPitches() {
  const res = await api("adminGetAllPitches", {});
  if (!res.ok) return;
  adminAllPitches = res.pitches;
  renderAdminPitchesTable();
}

function getFilteredAdminPitches() {
  const q = document.getElementById("pitches-search").value.trim().toLowerCase();
  const rep = document.getElementById("pitches-filter-rep").value;
  const dealId = document.getElementById("pitches-filter-deal").value;
  return adminAllPitches.filter(function (p) {
    if (rep && p.Username !== rep) return false;
    if (dealId && p.DealID !== dealId) return false;
    if (q && ![p.buyerName, p.buyerPhone, p.dealCode, p.dealAddress].some(function (f) { return String(f || "").toLowerCase().indexOf(q) !== -1; })) return false;
    return true;
  });
}

function repNameFor(username) {
  const rep = pitchesFilterRepsCache.find(function (r) { return r.username === username; });
  return rep ? rep.name : username;
}

function renderAdminPitchesTable() {
  const tbody = document.getElementById("pitches-tbody");
  const empty = document.getElementById("pitches-empty");
  const filtered = getFilteredAdminPitches();
  empty.hidden = filtered.length > 0;

  tbody.innerHTML = filtered.slice().reverse().map(function (p) {
    const checked = adminPitchesSelectedIds.has(p.PitchID) ? " checked" : "";
    return '<tr>' +
      '<td><input type="checkbox" class="pitch-select-checkbox" data-pitch-id="' + esc(p.PitchID) + '"' + checked + '></td>' +
      '<td>' + esc(p.buyerName) + '</td>' +
      '<td>' + esc(p.buyerPhone || "") + '</td>' +
      '<td>' + (p.dealCode ? esc(p.dealCode) + " — " : "") + esc(p.dealAddress) + '</td>' +
      '<td>' + esc(repNameFor(p.Username)) + '</td>' +
      '<td>' + (p.dealStillActive
        ? '<span class="status-pill ' + statusClass(p.status) + '">' + esc(p.status) + '</span>'
        : '<span class="status-pill status-fully-worked">Deal ' + esc((p.dealStatus || "closed").toLowerCase()) + '</span>') + '</td>' +
      '<td class="small-muted">' + formatDate(p.GivenAt) + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<select class="pitch-row-reassign-select" data-pitch-id="' + esc(p.PitchID) + '">' +
          pitchesFilterRepsCache.map(function (r) { return '<option value="' + esc(r.username) + '"' + (r.username === p.Username ? " selected" : "") + '>' + esc(r.name) + (r.isAdmin ? " — Admin" : "") + '</option>'; }).join("") +
        '</select> ' +
        '<button class="btn secondary small pitch-row-reassign-btn" data-pitch-id="' + esc(p.PitchID) + '">Give to</button> ' +
        '<button class="btn danger small pitch-row-withdraw-btn" data-pitch-id="' + esc(p.PitchID) + '">Withdraw</button>' +
      '</td>' +
      '</tr>';
  }).join("");

  Array.from(tbody.querySelectorAll(".pitch-select-checkbox")).forEach(function (cb) {
    cb.addEventListener("change", function () {
      const id = cb.getAttribute("data-pitch-id");
      if (cb.checked) adminPitchesSelectedIds.add(id); else adminPitchesSelectedIds.delete(id);
      updatePitchesSelectionUI();
    });
  });
  Array.from(tbody.querySelectorAll(".pitch-row-reassign-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const pitchId = btn.getAttribute("data-pitch-id");
      const select = tbody.querySelector('.pitch-row-reassign-select[data-pitch-id="' + pitchId + '"]');
      btn.disabled = true;
      const res = await api("adminReassignPitch", { pitchId: pitchId, username: select.value });
      if (!res.ok) { btn.disabled = false; showToast(res.error || "Could not reassign this pitch.", true); return; }
      await loadAdminPitches();
      showToast("Pitch reassigned.");
    });
  });
  Array.from(tbody.querySelectorAll(".pitch-row-withdraw-btn")).forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const pitchId = btn.getAttribute("data-pitch-id");
      btn.disabled = true;
      const res = await api("adminWithdrawPitch", { pitchId: pitchId });
      if (!res.ok) { btn.disabled = false; showToast(res.error || "Could not withdraw this pitch.", true); return; }
      adminPitchesSelectedIds.delete(pitchId);
      await loadAdminPitches();
      showToast("Pitch withdrawn.");
    });
  });

  updatePitchesSelectionUI();
}

function updatePitchesSelectionUI() {
  document.getElementById("pitches-selection-count").textContent = adminPitchesSelectedIds.size + " selected";
}

document.getElementById("pitches-search").addEventListener("input", renderAdminPitchesTable);
document.getElementById("pitches-filter-rep").addEventListener("change", renderAdminPitchesTable);
document.getElementById("pitches-filter-deal").addEventListener("change", renderAdminPitchesTable);

document.getElementById("pitches-select-all-btn").addEventListener("click", function () {
  getFilteredAdminPitches().forEach(function (p) { adminPitchesSelectedIds.add(p.PitchID); });
  renderAdminPitchesTable();
});
document.getElementById("pitches-clear-selection-btn").addEventListener("click", function () {
  adminPitchesSelectedIds = new Set();
  renderAdminPitchesTable();
});

document.getElementById("pitches-withdraw-selected-btn").addEventListener("click", async function () {
  const resultEl = document.getElementById("pitches-bulk-result");
  if (adminPitchesSelectedIds.size === 0) { resultEl.textContent = "No pitches selected."; return; }
  const btn = this;
  btn.disabled = true;
  const res = await api("adminBulkWithdrawPitches", { pitchIds: Array.from(adminPitchesSelectedIds) });
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not withdraw."; showToast(res.error || "Could not withdraw.", true); return; }
  resultEl.textContent = "Withdrew " + res.withdrawnCount + " pitch(es).";
  adminPitchesSelectedIds = new Set();
  await loadAdminPitches();
  showToast("Withdrew " + res.withdrawnCount + " pitch(es).");
});

document.getElementById("pitches-reassign-selected-btn").addEventListener("click", async function () {
  const resultEl = document.getElementById("pitches-bulk-result");
  if (adminPitchesSelectedIds.size === 0) { resultEl.textContent = "No pitches selected."; return; }
  const username = document.getElementById("pitches-reassign-selected-select").value;
  if (!username) { resultEl.textContent = "Pick who to reassign to."; return; }
  const btn = this;
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("adminBulkReassignPitches", { pitchIds: Array.from(adminPitchesSelectedIds), username: username });
  btn.disabled = false;
  if (!res.ok) { resultEl.textContent = res.error || "Could not reassign."; showToast(res.error || "Could not reassign.", true); return; }
  resultEl.textContent = "Reassigned " + res.reassignedCount + " pitch(es)." + (res.droppedCount ? " Dropped " + res.droppedCount + " duplicate(s) that team member already had." : "");
  adminPitchesSelectedIds = new Set();
  await loadAdminPitches();
  showToast("Reassigned " + res.reassignedCount + " pitch(es).");
});

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
      btn.disabled = true;
      await api("adminRemoveStatusOption", { status: btn.getAttribute("data-status") });
      loadStatusOptions();
      showToast("Status removed.");
    });
  });
}

document.getElementById("add-status-btn").addEventListener("click", async function () {
  const btn = this;
  const input = document.getElementById("new-status-input");
  const status = input.value.trim();
  if (!status) return;
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("adminAddStatusOption", { status: status });
  btn.disabled = false;
  if (res.ok) {
    input.value = "";
    loadStatusOptions();
    showToast("Status added.");
  } else {
    showToast(res.error || "Could not add status.", true);
  }
});

let assetCategoryOptionsCache = [];

async function loadAssetCategoryOptions() {
  const res = await api("getAssetCategoryOptions", {});
  if (!res.ok) return;
  assetCategoryOptionsCache = res.categories;
  const list = document.getElementById("assetcategory-chip-list");
  if (list) {
    list.innerHTML = assetCategoryOptionsCache.map(function (c) {
      return '<span class="chip">' + esc(c) + '<button data-category="' + esc(c) + '" class="remove-assetcategory-btn">&times;</button></span>';
    }).join("");
    Array.from(list.querySelectorAll(".remove-assetcategory-btn")).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        await api("adminRemoveAssetCategory", { category: btn.getAttribute("data-category") });
        loadAssetCategoryOptions();
        showToast("Category removed.");
      });
    });
  }
  const dealSelect = document.getElementById("deal-assetcategory-input");
  if (dealSelect) {
    dealSelect.innerHTML = '<option value="">&mdash; none &mdash;</option>' +
      assetCategoryOptionsCache.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join("");
  }
  const filterSelect = document.getElementById("buyerleads-filter-category");
  if (filterSelect) {
    filterSelect.innerHTML = '<option value="">All Asset Categories</option>' +
      assetCategoryOptionsCache.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join("");
  }
}

document.getElementById("add-assetcategory-btn").addEventListener("click", async function () {
  const btn = this;
  const input = document.getElementById("new-assetcategory-input");
  const category = input.value.trim();
  if (!category) return;
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await api("adminAddAssetCategory", { category: category });
  btn.disabled = false;
  if (res.ok) {
    input.value = "";
    loadAssetCategoryOptions();
    showToast("Category added.");
  } else {
    showToast(res.error || "Could not add category.", true);
  }
});
