/**
 * SendMyBuyer — Apps Script backend.
 *
 * Deploy this bound to a Google Sheet (see SETUP.md). It is the entire
 * "server": rep + admin login, deal management, per-deal access control,
 * interested-buyer logging, Facebook post approvals, and the master buyer
 * leads calling list (with its own call/text-response SOP and auto-feed)
 * all live here.
 *
 * Required Script Properties (Project Settings -> Script Properties):
 *   SESSION_SECRET      - random long string, used to sign session tokens
 *   ADMIN_NOTIFY_EMAIL  - where "new Facebook post request" and
 *                         "new interested buyer" emails are sent
 *   AUTO_FEED_ENABLED, AUTO_FEED_BATCH_SIZE - set via the admin panel, not
 *                         by hand; see adminSetAutoFeed
 *
 * Address secrecy model: a deal's exact street Address is stripped from
 * every non-admin session by default -- reps instead identify a deal by its
 * DealCode (a short admin-assigned label like "A-1") plus
 * City/State/Zip/County/Price. The one exception is an explicit, reversible,
 * per-rep-per-deal grant (AddressGrants sheet; adminGrantAddressAccess /
 * adminRevokeAddressAccess) -- everyone starts with no address access, and
 * only sees one after admin deliberately turns it on for that specific
 * rep+deal, revocable any time. getDeals/getDeal strip Address server-side
 * rather than relying on the front-end to hide it, since the value would
 * otherwise sit in the browser's network tab regardless of what's rendered.
 * getMyPitches (buyer-leads calling list) never includes Address at all --
 * grants are deal-detail-only, not plumbed into the calling-list pitch view.
 * AdminPrivateNotes and SourceLink on a Deal get the same unconditional
 * admin-only treatment as SensitiveDriveLink (no grant path for those).
 *
 * Buyer leads model: a buyer/LLC on the master calling list (BuyerLeads)
 * only ever becomes a work item once it's paired with one specific active
 * deal via a Pitch ("give this buyer lead to this rep for this deal") --
 * see PITCH_COLUMNS. There is deliberately no bare "assign this buyer to a
 * rep" without a deal attached, so nobody's queue can fill up with buyers
 * there's nothing currently for sale to offer them. A buyer's cross-deal
 * preferences (ARV%, price range, area, cash vs. financed) live in
 * BuyerLeads.GeneralNotes and persist across every pitch that buyer ever
 * gets, in any city, so a buyer who passed on one market can be correctly
 * re-pitched when a matching deal shows up somewhere else later.
 */

const REPS_SHEET = 'Reps';
const DEALS_SHEET = 'Deals';
const ASSIGNMENTS_SHEET = 'Assignments';
const BUYERS_SHEET = 'InterestedBuyers';
const FB_SHEET = 'FBPostRequests';
const STATUS_SHEET = 'StatusOptions';
const BUYER_LEADS_SHEET = 'BuyerLeads';
const PITCHES_SHEET = 'Pitches';
const BUYER_LEAD_CONTACTS_SHEET = 'BuyerLeadContacts';
const ADDRESS_GRANTS_SHEET = 'AddressGrants';
const ADDRESS_GRANT_COLUMNS = ['DealID', 'Username', 'GrantedAt'];
const ASSET_CATEGORIES_SHEET = 'AssetCategories';
const SESSION_HOURS = 12;
const DEFAULT_STATUSES = ['Active', 'Under Contract', 'Sold', 'Dead', 'On Hold'];
const FOLLOWUP_HOURS = 24;
const MATCH_STATUSES = ['Active Match', 'Negotiating', 'Closing', 'Dead Match'];
const DEFAULT_ASSET_CATEGORIES = ['Single Family', 'Condominium / Townhouse', 'Multifamily (1-4 Units)', 'Multifamily (4+ Units)', 'Fix and Flip', 'Residential Vacant Land', 'Commercial'];

const REP_COLUMNS = ['Username', 'Name', 'Phone', 'Email', 'PasswordHash', 'Salt', 'AllAccess', 'IsAdmin', 'Active', 'CreatedAt', 'LastActive', 'PreferredCity', 'PreferredState', 'PreferredZip'];
// DealCode (e.g. "A-1") plus City/State/Zip/County/Price is everything a
// rep ever sees to identify a deal -- Address is admin-only, unconditionally
// (see file header comment). GeneralDriveLink is visible to any rep with
// access to the deal; SensitiveDriveLink, AdminPrivateNotes, and SourceLink
// are all admin-only, stripped out for every non-admin session, the same
// way Address is -- there's no rep-facing unlock path for any of them.
// ARV and RehabEstimate are visible to reps (unlike Address/SensitiveDriveLink/
// AdminPrivateNotes/SourceLink) -- reps use them to pitch buyers. GrossMargin
// (ARV - RehabEstimate - Price) is never stored; it's computed fresh on every
// read by withComputedFields so it can't drift out of sync with the three
// inputs it depends on.
// AssetCategory (one of AssetCategoriesSheet's list, or blank) and
// MatchCities (comma-separated extra city names in the same State that
// should also count as "in this deal's area") both exist purely to drive
// buyer<->deal auto-matching -- see buyerMatchesDeal. AssetType stays a
// free-text description field ("SFR - 3bd/2ba") separate from the
// structured AssetCategory used for matching.
const DEAL_COLUMNS = ['DealID', 'DealCode', 'Address', 'City', 'State', 'Zip', 'County', 'MatchCities', 'AssetType', 'AssetCategory', 'Price', 'ARV', 'RehabEstimate', 'AsIsValue', 'Status', 'Description', 'GeneralDriveLink', 'SensitiveDriveLink', 'AdminPrivateNotes', 'SourceLink', 'CreatedAt', 'UpdatedAt'];
const ASSIGNMENT_COLUMNS = ['DealID', 'Username', 'AssignedAt'];
// MatchStatus tracks the buyer<->deal relationship itself ('Active Match' by
// default, through 'Negotiating'/'Closing', or 'Dead Match' once the buyer
// couldn't agree) -- separate from the one-time approval gate this used to
// be, since a deal's address was the only thing that gate ever unlocked and
// reps never see the address at all anymore. Notes is a running,
// rep-updatable conversation log ("copy and paste important notes"), not a
// one-time field; AdminNote is admin's own separate note on the match.
// ARVPercent/AsIsPercent capture what % of ARV or as-is value this buyer has
// expressed interest at for this specific deal, if they've said -- neither
// is required, but across every match they build a real picture of what
// buyers actually pay relative to value.
const BUYER_COLUMNS = ['BuyerID', 'DealID', 'Username', 'BuyerName', 'BuyerContact', 'Notes', 'MatchStatus', 'ARVPercent', 'AsIsPercent', 'AdminNote', 'CreatedAt', 'StatusUpdatedAt'];
const FB_COLUMNS = ['RequestID', 'DealID', 'Username', 'PostText', 'TargetGroups', 'Status', 'AdminNote', 'CreatedAt', 'DecidedAt'];

// One row per buyer/LLC on the master calling list. There is no direct
// "assigned rep" here on purpose -- a buyer lead only becomes an actual work
// item once a Pitch pairs it with a specific active deal (see PITCH_COLUMNS
// below), so nobody's follow-up queue ever fills up with buyers there's
// nothing current to sell them. GeneralNotes is a cross-deal profile (ARV%
// they want, price range, areas of interest, cash vs. financed, etc.) that
// persists no matter how many different deals/pitches this buyer goes
// through over time -- it's what lets a buyer who passed on a Phoenix deal
// get re-pitched correctly when a matching deal shows up in Dallas instead.
// Email is optional (not every source list has one). Phone2/Phone3 are
// optional alternate numbers (each with its own PhoneType, since one might
// be a mobile and another a landline) -- reps pick which one they're
// calling/texting each time (see PhoneSlot on BuyerLeadContacts).
// DoNotContact is a hard stop: once true, no rep can log a new contact
// against this buyer on any phone number (addPitchContact rejects it), and
// admin can no longer give this buyer a new pitch for any deal
// (adminGiveBuyerLeadToRep/adminGiveBuyerLeadsBulk/autoFeedCheck all skip
// it) -- existing pitches just stop being workable rather than being
// deleted, so the history stays intact. DriveLink is a folder URL for
// buyer-specific documents (proof of funds, signed agreements, etc.) --
// editable by admin only (adminUpdateBuyerLeadProfile), but any rep with an
// open pitch on this buyer can see it, same visibility as GeneralNotes.
// County is imported only if the source data actually has it (never
// required). AssetCategories is a comma-separated list drawn from the
// AssetCategories sheet ("Single Family, Fix and Flip") -- a buyer with no
// categories set is treated as open to anything for matching purposes
// (buyerMatchesDeal), so existing leads imported before this field existed
// don't get silently excluded. LastKnownPurchasePrice is a free-text note
// ("$180k, Phoenix, 2023") on a deal this buyer is known to have actually
// bought -- informational only, not used in matching. PriceRangeMin/Max are
// what the buyer has told us they want to spend, if known; like
// AssetCategories, a buyer with neither set is treated as open to any
// price for matching purposes.
const BUYER_LEAD_COLUMNS = ['BuyerLeadID', 'BuyerName', 'Phone', 'PhoneType', 'Phone2', 'Phone2Type', 'Phone3', 'Phone3Type', 'Email', 'City', 'State', 'Zip', 'County', 'AssetCategories', 'LastKnownPurchasePrice', 'EstimatedPropertyValue', 'PortfolioValue', 'OwnershipLengthMonths', 'PropertyURL', 'PriceRangeMin', 'PriceRangeMax', 'GeneralNotes', 'DriveLink', 'DoNotContact', 'PendingDealID', 'CreatedAt'];

// A Pitch is "give this buyer lead to this rep, to work against this one
// specific deal." This is the only thing that creates an actionable item in
// a rep's queue or blocks Auto-Feed -- a buyer lead with zero open pitches
// just sits in the pool, generating no follow-up pressure for anyone.
// Reassigning a pitch to a different rep (adminReassignPitch) keeps its
// contact history intact; withdrawing one (adminWithdrawPitch) deletes the
// pitch row itself but never touches BuyerLeadContacts, so the record of
// what was said stays put even after the pitch is gone.
const PITCH_COLUMNS = ['PitchID', 'BuyerLeadID', 'DealID', 'Username', 'GivenAt'];

// One row per contact attempt against a specific Pitch -- this is both the
// call/text touchpoint log that drives computeLeadStatus's 24/48-hour SOP
// (scoped to that one buyer+deal pairing, not the buyer lead as a whole),
// and the feedback history ("buyer said X about deal Y") that feeds the
// buyer's GeneralNotes over time. BuyerLeadID/DealID are denormalized here
// (copied from the Pitch at write time) so this history is still readable
// even after the Pitch itself has been withdrawn. PhoneSlot ('Phone',
// 'Phone2', or 'Phone3') records which of the buyer's numbers this specific
// attempt was against; defaults to 'Phone' for rows written before this
// existed. ARVPercent/AsIsPercent (both optional) capture what % of ARV or
// as-is value the buyer expressed interest at during this specific
// touchpoint, same purpose as on BUYER_COLUMNS but for the buyer-leads
// calling-list side of the app.
const BUYER_LEAD_CONTACT_COLUMNS = ['ContactID', 'PitchID', 'BuyerLeadID', 'DealID', 'Username', 'Method', 'PhoneSlot', 'ContactedAt', 'Responded', 'VoicemailLeft', 'ARVPercent', 'AsIsPercent', 'Notes'];

// e is undefined if you click "Run" on doGet directly in the Apps Script
// editor (it doesn't simulate a real request) -- guarded so that doesn't
// throw. A real web request always supplies e.parameter, so this doesn't
// affect the deployed app at all.
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'ping') {
    return jsonOut({ ok: true, message: 'SendMyBuyer backend is alive.' });
  }
  return jsonOut({ ok: false, error: 'Use POST for this API.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents); // throws (caught below) if e/e.postData is missing, e.g. run manually in the editor
  } catch (err) {
    return jsonOut({ ok: false, error: 'Bad request body.' });
  }

  const action = body.action;
  try {
    switch (action) {
      case 'login':
        return jsonOut(login(body));
      case 'getJoinContact':
        return jsonOut(getJoinContact());

      // ---- authenticated, any rep ----
      case 'getDeals':
        return jsonOut(withSession(body, getDeals));
      case 'getDeal':
        return jsonOut(withSession(body, getDeal));
      case 'getStatusOptions':
        return jsonOut(withSession(body, getStatusOptions));
      case 'getAssetCategoryOptions':
        return jsonOut(withSession(body, getAssetCategoryOptions));
      case 'addInterestedBuyer':
        return jsonOut(withSession(body, addInterestedBuyer));
      case 'getInterestedBuyers':
        return jsonOut(withSession(body, getInterestedBuyers));
      case 'updateInterestedBuyerNotes':
        return jsonOut(withSession(body, updateInterestedBuyerNotes));
      case 'updateInterestedBuyerMatchStatus':
        return jsonOut(withSession(body, updateInterestedBuyerMatchStatus));
      case 'submitFbPostRequest':
        return jsonOut(withSession(body, submitFbPostRequest));
      case 'getMyFbRequests':
        return jsonOut(withSession(body, getMyFbRequests));
      case 'getMyPitches':
        return jsonOut(withSession(body, getMyPitches));
      case 'getPitchContacts':
        return jsonOut(withSession(body, getPitchContacts));
      case 'addPitchContact':
        return jsonOut(withSession(body, addPitchContact));
      case 'updateBuyerLeadNotes':
        return jsonOut(withSession(body, updateBuyerLeadNotes));
      case 'updateBuyerLeadDoNotContact':
        return jsonOut(withSession(body, updateBuyerLeadDoNotContact));

      // ---- admin only ----
      case 'adminAddDeal':
        return jsonOut(withAdminSession(body, adminAddDeal));
      case 'adminUpdateDeal':
        return jsonOut(withAdminSession(body, adminUpdateDeal));
      case 'adminUpdateDealStatus':
        return jsonOut(withAdminSession(body, adminUpdateDealStatus));
      case 'adminGetReps':
        return jsonOut(withAdminSession(body, adminGetReps));
      case 'adminAddRep':
        return jsonOut(withAdminSession(body, adminAddRep));
      case 'adminSetRepAccess':
        return jsonOut(withAdminSession(body, adminSetRepAccess));
      case 'adminResetPassword':
        return jsonOut(withAdminSession(body, adminResetPassword));
      case 'adminAssignRep':
        return jsonOut(withAdminSession(body, adminAssignRep));
      case 'adminUnassignRep':
        return jsonOut(withAdminSession(body, adminUnassignRep));
      case 'adminGetAssignments':
        return jsonOut(withAdminSession(body, adminGetAssignments));
      case 'adminGrantAddressAccess':
        return jsonOut(withAdminSession(body, adminGrantAddressAccess));
      case 'adminRevokeAddressAccess':
        return jsonOut(withAdminSession(body, adminRevokeAddressAccess));
      case 'adminGetAddressGrants':
        return jsonOut(withAdminSession(body, adminGetAddressGrants));
      case 'adminGetFbRequests':
        return jsonOut(withAdminSession(body, adminGetFbRequests));
      case 'adminDecideFbRequest':
        return jsonOut(withAdminSession(body, adminDecideFbRequest));
      case 'adminGetBuyerRequests':
        return jsonOut(withAdminSession(body, adminGetBuyerRequests));
      case 'adminImportBuyerLeads':
        return jsonOut(withAdminSession(body, adminImportBuyerLeads));
      case 'adminGetBuyerLeads':
        return jsonOut(withAdminSession(body, adminGetBuyerLeads));
      case 'adminFindDuplicateBuyerLeads':
        return jsonOut(withAdminSession(body, adminFindDuplicateBuyerLeads));
      case 'adminMergeBuyerLeads':
        return jsonOut(withAdminSession(body, adminMergeBuyerLeads));
      case 'updateBuyerLeadProfile':
        return jsonOut(withSession(body, updateBuyerLeadProfile));
      case 'adminBulkUpdateBuyerLeads':
        return jsonOut(withAdminSession(body, adminBulkUpdateBuyerLeads));
      case 'adminGiveBuyerLeadToRep':
        return jsonOut(withAdminSession(body, adminGiveBuyerLeadToRep));
      case 'adminGiveBuyerLeadsBulk':
        return jsonOut(withAdminSession(body, adminGiveBuyerLeadsBulk));
      case 'adminGiveSelectedBuyerLeads':
        return jsonOut(withAdminSession(body, adminGiveSelectedBuyerLeads));
      case 'adminTagBuyerLeadsForDeal':
        return jsonOut(withAdminSession(body, adminTagBuyerLeadsForDeal));
      case 'adminAddAssetCategory':
        return jsonOut(withAdminSession(body, adminAddAssetCategory));
      case 'adminRemoveAssetCategory':
        return jsonOut(withAdminSession(body, adminRemoveAssetCategory));
      case 'adminReassignPitch':
        return jsonOut(withAdminSession(body, adminReassignPitch));
      case 'adminBulkReassignPitches':
        return jsonOut(withAdminSession(body, adminBulkReassignPitches));
      case 'adminWithdrawPitch':
        return jsonOut(withAdminSession(body, adminWithdrawPitch));
      case 'adminGetPitchesForBuyerLead':
        return jsonOut(withAdminSession(body, adminGetPitchesForBuyerLead));
      case 'adminGetPitchContacts':
        return jsonOut(withAdminSession(body, adminGetPitchContacts));
      case 'adminGetAllPitches':
        return jsonOut(withAdminSession(body, adminGetAllPitches));
      case 'adminBulkWithdrawPitches':
        return jsonOut(withAdminSession(body, adminBulkWithdrawPitches));
      case 'adminSetRepPreferredArea':
        return jsonOut(withAdminSession(body, adminSetRepPreferredArea));
      case 'adminSetJoinContact':
        return jsonOut(withAdminSession(body, adminSetJoinContact));
      case 'adminGetAutoFeedSettings':
        return jsonOut(withAdminSession(body, adminGetAutoFeedSettings));
      case 'adminSetAutoFeed':
        return jsonOut(withAdminSession(body, adminSetAutoFeed));
      case 'adminRunAutoFeedNow':
        return jsonOut(withAdminSession(body, adminRunAutoFeedNow));
      case 'adminAddStatusOption':
        return jsonOut(withAdminSession(body, adminAddStatusOption));
      case 'adminRemoveStatusOption':
        return jsonOut(withAdminSession(body, adminRemoveStatusOption));

      default:
        return jsonOut({ ok: false, error: 'Unknown action.' });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Sheets helpers ----------

function getSheet(name, columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
  } else {
    ensureHeaders(sheet, columns);
  }
  return sheet;
}

function ensureHeaders(sheet, columns) {
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = columns.filter(function (c) { return existing.indexOf(c) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

function getColumnIndex(sheet, headerName) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  return headers.indexOf(headerName) + 1;
}

function appendRowByHeaders(sheet, dataObj) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = headers.map(function (h) {
    const v = dataObj[h];
    return (v === undefined || v === null) ? '' : v;
  });
  sheet.appendRow(row);
}

// Batch version of appendRowByHeaders -- reads the header row once and
// writes every new row in a single setValues() call instead of one
// getRange()+appendRow() round trip per row. Each individual Sheets
// service call is the dominant cost in Apps Script (tens to low hundreds
// of ms), so importing/giving N rows one at a time is O(N) remote calls;
// this is 2 total, regardless of N. No-op on an empty list.
function appendRowsByHeaders(sheet, dataObjs) {
  if (dataObjs.length === 0) return;
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const rows = dataObjs.map(function (dataObj) {
    return headers.map(function (h) {
      const v = dataObj[h];
      return (v === undefined || v === null) ? '' : v;
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    const obj = {};
    headers.forEach(function (h, idx) { obj[h] = row[idx]; });
    obj._row = i + 1;
    rows.push(obj);
  }
  return rows;
}

// ---------- Auth ----------

function hmacHex(value, secret) {
  const raw = Utilities.computeHmacSha256Signature(value, secret);
  return raw.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function sha256Hex(value) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value);
  return raw.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function hashPassword(password, salt) {
  return sha256Hex(salt + ':' + password);
}

function makeSessionToken(rep) {
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  const payload = {
    u: rep['Username'],
    n: rep['Name'],
    a: rep['IsAdmin'] === true || rep['IsAdmin'] === 'TRUE',
    all: rep['AllAccess'] === true || rep['AllAccess'] === 'TRUE',
    exp: Date.now() + SESSION_HOURS * 60 * 60 * 1000
  };
  const payloadStr = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sig = hmacHex(payloadStr, secret);
  return payloadStr + '.' + sig;
}

function parseSessionToken(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const parts = token.split('.');
  const payloadStr = parts[0];
  const sig = parts[1];
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  if (hmacHex(payloadStr, secret) !== sig) return null;
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadStr)).getDataAsString());
  } catch (err) {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function withSession(body, fn) {
  const session = parseSessionToken(body.token);
  if (!session) return { ok: false, error: 'Session expired or invalid. Please log in again.' };
  return fn(body, session);
}

// Serializes read-check-then-write operations (like "give this buyer a
// pitch if they don't already have one for this deal") across concurrent
// Web App executions. Without this, two near-simultaneous requests (a
// double-click, or a manual Give firing at the same moment auto-feed runs)
// can both read "no existing pitch" before either has written its row,
// producing duplicate Pitches for the same buyer+deal. 10s wait is well
// above how long a single give operation actually takes.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function withAdminSession(body, fn) {
  const session = parseSessionToken(body.token);
  if (!session) return { ok: false, error: 'Session expired or invalid. Please log in again.' };
  if (!session.a) return { ok: false, error: 'Admin access required.' };
  return fn(body, session);
}

function login(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) return { ok: false, error: 'Username and password are required.' };

  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet);
  const rep = reps.find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === username; });
  if (!rep) return { ok: false, error: 'Incorrect username or password.' };
  if (rep['Active'] === false || rep['Active'] === 'FALSE') return { ok: false, error: 'This account has been deactivated.' };

  const computed = hashPassword(password, rep['Salt']);
  if (computed !== rep['PasswordHash']) return { ok: false, error: 'Incorrect username or password.' };

  // "Last active" is last successful login -- cheap to track (once per
  // session, not per request) and close enough to what admin actually
  // wants to know: is this person still logging in and working deals.
  sheet.getRange(rep['_row'], getColumnIndex(sheet, 'LastActive')).setValue(new Date().toISOString());

  return {
    ok: true,
    token: makeSessionToken(rep),
    name: rep['Name'],
    username: rep['Username'],
    isAdmin: rep['IsAdmin'] === true || rep['IsAdmin'] === 'TRUE',
    allAccess: rep['AllAccess'] === true || rep['AllAccess'] === 'TRUE'
  };
}

// ---------- Access control ----------

function canAccessDeal(session, dealId) {
  if (session.a || session.all) return true;
  const sheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const assignments = sheetToObjects(sheet);
  return assignments.some(function (row) {
    return row['DealID'] === dealId && String(row['Username'] || '').trim().toLowerCase() === session.u;
  });
}

function accessibleDealIds(session) {
  const sheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const assignments = sheetToObjects(sheet);
  const ids = {};
  assignments.forEach(function (row) {
    if (String(row['Username'] || '').trim().toLowerCase() === session.u) ids[row['DealID']] = true;
  });
  return ids;
}

// ---------- Deals ----------

function getDeals(body, session) {
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  let deals = sheetToObjects(sheet);
  if (!session.a && !session.all) {
    const ids = accessibleDealIds(session);
    deals = deals.filter(function (d) { return ids[d['DealID']]; });
  }
  deals = deals.map(withComputedFields);
  if (!session.a) {
    const grants = loadAddressGrantsSet();
    deals = deals.map(function (d) { return applyAddressSecrecy(d, session, grants); });
  } else {
    // Admin-only: how many active, non-admin team members can currently
    // work each deal -- an all-access rep counts toward every deal,
    // everyone else only counts for deals they're specifically assigned
    // to (same math as the Team tab's per-rep "# Deals", just inverted to
    // per-deal). Lets admin spot at a glance which deals are thin on
    // coverage and could use another rep pushed onto them.
    const repsSheet = getSheet(REPS_SHEET, REP_COLUMNS);
    const activeReps = sheetToObjects(repsSheet).filter(function (r) {
      const active = !(r['Active'] === false || r['Active'] === 'FALSE');
      const isAdmin = r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE';
      return active && !isAdmin;
    });
    const allAccessCount = activeReps.filter(function (r) { return r['AllAccess'] === true || r['AllAccess'] === 'TRUE'; }).length;
    const specificallyAssignableUsernames = {};
    activeReps.forEach(function (r) {
      if (!(r['AllAccess'] === true || r['AllAccess'] === 'TRUE')) specificallyAssignableUsernames[String(r['Username'] || '').trim().toLowerCase()] = true;
    });

    const assignmentsSheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
    const specificCountByDeal = {};
    sheetToObjects(assignmentsSheet).forEach(function (a) {
      const u = String(a['Username'] || '').trim().toLowerCase();
      if (!specificallyAssignableUsernames[u]) return; // inactive, admin, or already counted via all-access
      specificCountByDeal[a['DealID']] = (specificCountByDeal[a['DealID']] || 0) + 1;
    });

    deals = deals.map(function (d) {
      const copy = Object.assign({}, d);
      copy.repsWithAccessCount = allAccessCount + (specificCountByDeal[d['DealID']] || 0);
      return copy;
    });
  }
  return { ok: true, deals: deals };
}

function getDeal(body, session) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const rawDeal = sheetToObjects(sheet).find(function (d) { return d['DealID'] === body.dealId; });
  if (!rawDeal) return { ok: false, error: 'Deal not found.' };
  const deal = withComputedFields(rawDeal);
  return { ok: true, deal: session.a ? deal : applyAddressSecrecy(deal, session, loadAddressGrantsSet()) };
}

// GrossMargin = ARV - RehabEstimate - Price, computed fresh on every read
// (never stored) so it can't go stale relative to those three inputs.
// Visible to reps, same as ARV/RehabEstimate themselves -- unlike Address
// and the admin-only fields, there's no stripping needed here.
function withComputedFields(deal) {
  const copy = Object.assign({}, deal);
  copy.GrossMargin = computeGrossMargin(deal);
  copy.AsIsEquity = computeAsIsEquity(deal);
  return copy;
}

function computeGrossMargin(deal) {
  const arv = parseMoney(deal['ARV']);
  const rehab = parseMoney(deal['RehabEstimate']);
  const price = parseMoney(deal['Price']);
  if (arv === null || rehab === null || price === null) return null;
  return arv - rehab - price;
}

// For a deal whose selling point is being undervalued as-is rather than a
// rehab spread -- e.g. no repairs needed, so ARV/RehabEstimate may not
// even be filled in. As-Is Value is optional and separate from ARV (which
// implies "after repairs").
function computeAsIsEquity(deal) {
  const asIsValue = parseMoney(deal['AsIsValue']);
  const price = parseMoney(deal['Price']);
  if (asIsValue === null || price === null) return null;
  return asIsValue - price;
}

// Strips $ signs, commas, and other formatting so "$250,000" and "250000"
// both parse the same way. Returns null (not 0) for blank/non-numeric input
// so computeGrossMargin can tell "missing" apart from "actually zero."
function parseMoney(v) {
  if (v === undefined || v === null || v === '') return null;
  const num = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(num) ? null : num;
}

// Every open grant, keyed "dealId::username" for O(1) lookup -- loaded once
// per request rather than once per deal, since getDeals maps over a whole
// list.
function loadAddressGrantsSet() {
  const sheet = getSheet(ADDRESS_GRANTS_SHEET, ADDRESS_GRANT_COLUMNS);
  const set = {};
  sheetToObjects(sheet).forEach(function (r) {
    set[r['DealID'] + '::' + String(r['Username'] || '').toLowerCase()] = true;
  });
  return set;
}

// Strips every admin-only field from a deal object for a non-admin session
// -- SensitiveDriveLink, AdminPrivateNotes, and SourceLink unconditionally,
// and Address unless this specific rep has been explicitly granted it for
// this specific deal (see adminGrantAddressAccess/adminRevokeAddressAccess).
// Done here server-side rather than relying on the front-end to hide them,
// since the values would otherwise sit in the browser's network tab
// regardless of what's rendered.
function applyAddressSecrecy(deal, session, grants) {
  const copy = Object.assign({}, deal);
  const granted = !!(grants && grants[deal['DealID'] + '::' + session.u]);
  if (!granted) delete copy.Address;
  copy.addressGranted = granted;
  delete copy.SensitiveDriveLink;
  delete copy.AdminPrivateNotes;
  delete copy.SourceLink;
  return copy;
}

function adminAddDeal(body) {
  const d = body.data || {};
  if (!d.address) return { ok: false, error: 'Address is required.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealId = Utilities.getUuid();
  const now = new Date().toISOString();
  appendRowByHeaders(sheet, {
    'DealID': dealId, 'DealCode': d.dealCode || '', 'Address': d.address, 'City': d.city || '', 'State': d.state || '', 'Zip': d.zip || '',
    'County': d.county || '', 'MatchCities': d.matchCities || '', 'AssetType': d.assetType || '', 'AssetCategory': d.assetCategory || '',
    'Price': d.price || '', 'ARV': d.arv || '', 'RehabEstimate': d.rehabEstimate || '', 'AsIsValue': d.asIsValue || '',
    'Status': d.status || DEFAULT_STATUSES[0],
    'Description': d.description || '', 'GeneralDriveLink': d.generalDriveLink || '', 'SensitiveDriveLink': d.sensitiveDriveLink || '',
    'AdminPrivateNotes': d.adminPrivateNotes || '', 'SourceLink': d.sourceLink || '',
    'CreatedAt': now, 'UpdatedAt': now
  });
  return { ok: true, dealId: dealId };
}

function adminUpdateDeal(body) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deals = sheetToObjects(sheet);
  const match = deals.find(function (d) { return d['DealID'] === body.dealId; });
  if (!match) return { ok: false, error: 'Deal not found.' };
  const d = body.data || {};
  const editable = ['DealCode', 'Address', 'City', 'State', 'Zip', 'County', 'MatchCities', 'AssetType', 'AssetCategory', 'Price', 'ARV', 'RehabEstimate', 'AsIsValue', 'Description', 'GeneralDriveLink', 'SensitiveDriveLink', 'AdminPrivateNotes', 'SourceLink'];
  editable.forEach(function (field) {
    if (d[field] === undefined) return;
    const col = getColumnIndex(sheet, field);
    sheet.getRange(match._row, col).setValue(d[field]);
  });
  const updatedCol = getColumnIndex(sheet, 'UpdatedAt');
  sheet.getRange(match._row, updatedCol).setValue(new Date().toISOString());
  return { ok: true };
}

function adminUpdateDealStatus(body) {
  if (!body.dealId || !body.status) return { ok: false, error: 'Missing dealId or status.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deals = sheetToObjects(sheet);
  const match = deals.find(function (d) { return d['DealID'] === body.dealId; });
  if (!match) return { ok: false, error: 'Deal not found.' };
  const statusCol = getColumnIndex(sheet, 'Status');
  sheet.getRange(match._row, statusCol).setValue(body.status);
  const updatedCol = getColumnIndex(sheet, 'UpdatedAt');
  sheet.getRange(match._row, updatedCol).setValue(new Date().toISOString());
  return { ok: true };
}

// ---------- Status options ----------

function getStatusOptions(body, session) {
  const sheet = getSheet(STATUS_SHEET, ['Status']);
  let rows = sheetToObjects(sheet);
  if (rows.length === 0) {
    DEFAULT_STATUSES.forEach(function (s) { appendRowByHeaders(sheet, { 'Status': s }); });
    rows = sheetToObjects(sheet);
  }
  return { ok: true, statuses: rows.map(function (r) { return r['Status']; }) };
}

function adminAddStatusOption(body) {
  const status = String(body.status || '').trim();
  if (!status) return { ok: false, error: 'Status name is required.' };
  const sheet = getSheet(STATUS_SHEET, ['Status']);
  const rows = sheetToObjects(sheet);
  if (rows.some(function (r) { return String(r['Status'] || '').trim().toLowerCase() === status.toLowerCase(); })) {
    return { ok: false, error: 'That status already exists.' };
  }
  appendRowByHeaders(sheet, { 'Status': status });
  return { ok: true };
}

function adminRemoveStatusOption(body) {
  const status = String(body.status || '').trim();
  const sheet = getSheet(STATUS_SHEET, ['Status']);
  const rows = sheetToObjects(sheet);
  const match = rows.find(function (r) { return r['Status'] === status; });
  if (!match) return { ok: false, error: 'Status not found.' };
  sheet.deleteRow(match._row);
  return { ok: true };
}

// ---------- Reps (team) ----------

// "# of deals" is active deals (not Sold/Dead) the rep can currently work
// -- for an all-access rep that's every active deal; for anyone else it's
// however many active deals they've specifically been assigned (a stale
// assignment to a deal that's since sold/died doesn't count, so the
// number always matches what they'd actually see in their own app).
function adminGetReps(body) {
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const activeDealIds = {};
  let activeDealsCount = 0;
  sheetToObjects(dealsSheet).forEach(function (d) {
    if (dealIsActive(d)) { activeDealIds[d['DealID']] = true; activeDealsCount++; }
  });

  const assignmentsSheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const assignedActiveCountByUsername = {};
  sheetToObjects(assignmentsSheet).forEach(function (a) {
    if (!activeDealIds[a['DealID']]) return;
    const u = String(a['Username'] || '').trim().toLowerCase();
    assignedActiveCountByUsername[u] = (assignedActiveCountByUsername[u] || 0) + 1;
  });

  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet).map(function (r) {
    const allAccess = r['AllAccess'] === true || r['AllAccess'] === 'TRUE';
    const username = String(r['Username'] || '').trim().toLowerCase();
    return {
      username: r['Username'], name: r['Name'], phone: r['Phone'] || '', email: r['Email'] || '',
      allAccess: allAccess,
      isAdmin: r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE',
      active: !(r['Active'] === false || r['Active'] === 'FALSE'),
      createdAt: r['CreatedAt'], lastActive: r['LastActive'] || '',
      dealsAssignedCount: allAccess ? activeDealsCount : (assignedActiveCountByUsername[username] || 0),
      preferredCity: r['PreferredCity'] || '', preferredState: r['PreferredState'] || '', preferredZip: r['PreferredZip'] || ''
    };
  });
  return { ok: true, reps: reps };
}

function adminAddRep(body) {
  const d = body.data || {};
  const username = String(d.username || '').trim().toLowerCase();
  if (!username || !d.name || !d.password) return { ok: false, error: 'Name, username, and password are required.' };
  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet);
  if (reps.some(function (r) { return String(r['Username'] || '').trim().toLowerCase() === username; })) {
    return { ok: false, error: 'That username is already in use.' };
  }
  const salt = Utilities.getUuid();
  appendRowByHeaders(sheet, {
    'Username': username, 'Name': d.name, 'Phone': d.phone || '', 'Email': d.email || '', 'PasswordHash': hashPassword(d.password, salt), 'Salt': salt,
    'AllAccess': !!d.allAccess, 'IsAdmin': !!d.isAdmin, 'Active': true, 'CreatedAt': new Date().toISOString(), 'LastActive': ''
  });
  return { ok: true };
}

function adminSetRepAccess(body) {
  const username = String(body.username || '').trim().toLowerCase();
  if (!username) return { ok: false, error: 'Missing username.' };
  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet);
  const match = reps.find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === username; });
  if (!match) return { ok: false, error: 'Rep not found.' };
  ['allAccess', 'isAdmin', 'active'].forEach(function (field) {
    if (body[field] === undefined) return;
    const col = getColumnIndex(sheet, field === 'allAccess' ? 'AllAccess' : field === 'isAdmin' ? 'IsAdmin' : 'Active');
    sheet.getRange(match._row, col).setValue(!!body[field]);
  });
  return { ok: true };
}

function adminResetPassword(body) {
  const username = String(body.username || '').trim().toLowerCase();
  if (!username || !body.newPassword) return { ok: false, error: 'Missing username or newPassword.' };
  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet);
  const match = reps.find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === username; });
  if (!match) return { ok: false, error: 'Rep not found.' };
  const salt = Utilities.getUuid();
  sheet.getRange(match._row, getColumnIndex(sheet, 'Salt')).setValue(salt);
  sheet.getRange(match._row, getColumnIndex(sheet, 'PasswordHash')).setValue(hashPassword(body.newPassword, salt));
  return { ok: true };
}

// ---------- Assignments (per-deal access) ----------

function adminAssignRep(body) {
  if (!body.dealId || !body.username) return { ok: false, error: 'Missing dealId or username.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const rows = sheetToObjects(sheet);
  const exists = rows.some(function (r) { return r['DealID'] === body.dealId && String(r['Username'] || '').trim().toLowerCase() === username; });
  if (exists) return { ok: true };
  appendRowByHeaders(sheet, { 'DealID': body.dealId, 'Username': username, 'AssignedAt': new Date().toISOString() });
  return { ok: true };
}

function adminUnassignRep(body) {
  if (!body.dealId || !body.username) return { ok: false, error: 'Missing dealId or username.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const rows = sheetToObjects(sheet);
  const match = rows.find(function (r) { return r['DealID'] === body.dealId && String(r['Username'] || '').trim().toLowerCase() === username; });
  if (!match) return { ok: false, error: 'Assignment not found.' };
  sheet.deleteRow(match._row);
  return { ok: true };
}

function adminGetAssignments(body) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  const sheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const rows = sheetToObjects(sheet).filter(function (r) { return r['DealID'] === body.dealId; });
  return { ok: true, usernames: rows.map(function (r) { return r['Username']; }) };
}

// ---------- Address disclosure ----------
// Deliberately separate from Assignments (deal visibility) -- a rep can
// work a deal without ever seeing its address, and granting the address is
// a distinct, explicit, per-rep, per-deal admin action, reversible any time.

function adminGrantAddressAccess(body) {
  if (!body.dealId || !body.username) return { ok: false, error: 'Missing dealId or username.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(ADDRESS_GRANTS_SHEET, ADDRESS_GRANT_COLUMNS);
  const exists = sheetToObjects(sheet).some(function (r) { return r['DealID'] === body.dealId && String(r['Username'] || '').toLowerCase() === username; });
  if (exists) return { ok: true };
  appendRowByHeaders(sheet, { 'DealID': body.dealId, 'Username': username, 'GrantedAt': new Date().toISOString() });
  return { ok: true };
}

function adminRevokeAddressAccess(body) {
  if (!body.dealId || !body.username) return { ok: false, error: 'Missing dealId or username.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(ADDRESS_GRANTS_SHEET, ADDRESS_GRANT_COLUMNS);
  const rows = sheetToObjects(sheet);
  const match = rows.find(function (r) { return r['DealID'] === body.dealId && String(r['Username'] || '').toLowerCase() === username; });
  if (!match) return { ok: false, error: 'That grant was not found (already revoked?).' };
  sheet.deleteRow(match._row);
  return { ok: true };
}

function adminGetAddressGrants(body) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  const sheet = getSheet(ADDRESS_GRANTS_SHEET, ADDRESS_GRANT_COLUMNS);
  const rows = sheetToObjects(sheet).filter(function (r) { return r['DealID'] === body.dealId; });
  return { ok: true, usernames: rows.map(function (r) { return r['Username']; }) };
}

// ---------- Interested buyers ----------

function addInterestedBuyer(body, session) {
  if (!body.dealId || !body.buyerName) return { ok: false, error: 'Missing dealId or buyerName.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(BUYERS_SHEET, BUYER_COLUMNS);
  const buyerId = Utilities.getUuid();
  const now = new Date().toISOString();
  appendRowByHeaders(sheet, {
    'BuyerID': buyerId, 'DealID': body.dealId, 'Username': session.u,
    'BuyerName': body.buyerName, 'BuyerContact': body.buyerContact || '', 'Notes': body.notes || '',
    'MatchStatus': 'Active Match', 'ARVPercent': body.arvPercent || '', 'AsIsPercent': body.asIsPercent || '',
    'AdminNote': '', 'CreatedAt': now, 'StatusUpdatedAt': now
  });

  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_NOTIFY_EMAIL');
  if (adminEmail) {
    const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
    const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
    const dealLabel = deal ? (deal['DealCode'] || deal['Address']) : body.dealId;
    MailApp.sendEmail({
      to: adminEmail,
      subject: 'SendMyBuyer — new interested buyer',
      body: session.n + ' (' + session.u + ') logged an interested buyer on ' + dealLabel + ':\n\n' +
        'Buyer name: ' + body.buyerName +
        (body.buyerContact ? '\nBuyer contact: ' + body.buyerContact : '') +
        (body.notes ? '\nNotes: ' + body.notes : '') +
        '\n\nCheck the deal in the admin panel to follow the conversation and pick it up to close.'
    });
  }

  return { ok: true, buyerId: buyerId };
}

function getInterestedBuyers(body, session) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(BUYERS_SHEET, BUYER_COLUMNS);
  const rows = sheetToObjects(sheet).filter(function (r) { return r['DealID'] === body.dealId; });
  return { ok: true, buyers: rows };
}

// Either the admin, or any rep with access to the underlying deal, can
// update a buyer match's running conversation notes or its MatchStatus --
// there's no "only the rep who logged it" restriction, since other reps or
// admin often need to pick up the same conversation (see file header
// comment: "keep the person updated who brought the buyer").
function findInterestedBuyerRow(buyerId) {
  const sheet = getSheet(BUYERS_SHEET, BUYER_COLUMNS);
  const rows = sheetToObjects(sheet);
  const match = rows.find(function (r) { return r['BuyerID'] === buyerId; });
  return { sheet: sheet, match: match };
}

function updateInterestedBuyerNotes(body, session) {
  if (!body.buyerId) return { ok: false, error: 'Missing buyerId.' };
  const found = findInterestedBuyerRow(body.buyerId);
  if (!found.match) return { ok: false, error: 'Buyer match not found.' };
  if (!session.a && !canAccessDeal(session, found.match['DealID'])) return { ok: false, error: 'You do not have access to this deal.' };
  found.sheet.getRange(found.match._row, getColumnIndex(found.sheet, 'Notes')).setValue(body.notes || '');
  return { ok: true };
}

function updateInterestedBuyerMatchStatus(body, session) {
  if (!body.buyerId || !body.matchStatus) return { ok: false, error: 'Missing buyerId or matchStatus.' };
  if (MATCH_STATUSES.indexOf(body.matchStatus) === -1) return { ok: false, error: 'Invalid match status.' };
  const found = findInterestedBuyerRow(body.buyerId);
  if (!found.match) return { ok: false, error: 'Buyer match not found.' };
  if (!session.a && !canAccessDeal(session, found.match['DealID'])) return { ok: false, error: 'You do not have access to this deal.' };
  found.sheet.getRange(found.match._row, getColumnIndex(found.sheet, 'MatchStatus')).setValue(body.matchStatus);
  found.sheet.getRange(found.match._row, getColumnIndex(found.sheet, 'StatusUpdatedAt')).setValue(new Date().toISOString());
  if (body.arvPercent !== undefined) found.sheet.getRange(found.match._row, getColumnIndex(found.sheet, 'ARVPercent')).setValue(body.arvPercent || '');
  if (body.asIsPercent !== undefined) found.sheet.getRange(found.match._row, getColumnIndex(found.sheet, 'AsIsPercent')).setValue(body.asIsPercent || '');
  if (body.adminNote !== undefined && session.a) {
    found.sheet.getRange(found.match._row, getColumnIndex(found.sheet, 'AdminNote')).setValue(body.adminNote || '');
  }
  return { ok: true };
}

// ---------- Facebook post approvals ----------

function submitFbPostRequest(body, session) {
  if (!body.dealId || !body.postText) return { ok: false, error: 'Missing dealId or postText.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(FB_SHEET, FB_COLUMNS);
  const requestId = Utilities.getUuid();
  appendRowByHeaders(sheet, {
    'RequestID': requestId, 'DealID': body.dealId, 'Username': session.u,
    'PostText': body.postText, 'TargetGroups': body.targetGroups || '', 'Status': 'Pending', 'AdminNote': '',
    'CreatedAt': new Date().toISOString(), 'DecidedAt': ''
  });

  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_NOTIFY_EMAIL');
  if (adminEmail) {
    const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
    const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
    const address = deal ? deal['Address'] : body.dealId;
    MailApp.sendEmail({
      to: adminEmail,
      subject: 'SendMyBuyer — new Facebook post pending approval',
      body: session.n + ' (' + session.u + ') wants to post about:\n\n' + address +
        '\n\nGroups: ' + (body.targetGroups || '(none specified)') +
        '\n\nPost text:\n' + body.postText +
        '\n\nReview it in the admin panel.'
    });
  }

  return { ok: true, requestId: requestId };
}

function getMyFbRequests(body, session) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(FB_SHEET, FB_COLUMNS);
  const rows = sheetToObjects(sheet).filter(function (r) {
    return r['DealID'] === body.dealId && String(r['Username'] || '').trim().toLowerCase() === session.u;
  });
  return { ok: true, requests: rows };
}

function adminGetFbRequests(body) {
  const sheet = getSheet(FB_SHEET, FB_COLUMNS);
  let rows = sheetToObjects(sheet);
  if (body.dealId) rows = rows.filter(function (r) { return r['DealID'] === body.dealId; });
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deals = sheetToObjects(dealsSheet);
  const dealsById = {};
  deals.forEach(function (d) { dealsById[d['DealID']] = d; });
  rows.forEach(function (r) {
    const deal = dealsById[r['DealID']];
    r.address = deal ? deal['Address'] : '(deleted deal)';
  });
  return { ok: true, requests: rows };
}

// ---------- One-time bootstrap ----------
// Run manually from the Apps Script editor (Run -> bootstrapFirstAdmin) to
// create your very first admin login, since the Team tab that normally adds
// reps is itself gated behind an admin login. Edit the three values below
// first. Safe to leave in place afterward -- it refuses to run a second time
// once any Reps row already exists, so it can't be used to inject a rogue
// admin later.
function bootstrapFirstAdmin() {
  const NAME = 'Your Name';
  const USERNAME = 'admin';
  const PASSWORD = 'change-me-immediately';

  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  if (sheetToObjects(sheet).length > 0) {
    throw new Error('Reps sheet already has at least one account -- bootstrapFirstAdmin only runs once. Use the Team tab instead.');
  }
  const salt = Utilities.getUuid();
  appendRowByHeaders(sheet, {
    'Username': USERNAME.trim().toLowerCase(), 'Name': NAME, 'PasswordHash': hashPassword(PASSWORD, salt), 'Salt': salt,
    'AllAccess': true, 'IsAdmin': true, 'Active': true, 'CreatedAt': new Date().toISOString()
  });
}

function adminDecideFbRequest(body) {
  if (!body.requestId || !body.decision) return { ok: false, error: 'Missing requestId or decision.' };
  if (body.decision !== 'Approved' && body.decision !== 'Rejected') return { ok: false, error: 'Invalid decision.' };
  const sheet = getSheet(FB_SHEET, FB_COLUMNS);
  const rows = sheetToObjects(sheet);
  const match = rows.find(function (r) { return r['RequestID'] === body.requestId; });
  if (!match) return { ok: false, error: 'Request not found.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'Status')).setValue(body.decision);
  sheet.getRange(match._row, getColumnIndex(sheet, 'AdminNote')).setValue(body.note || '');
  sheet.getRange(match._row, getColumnIndex(sheet, 'DecidedAt')).setValue(new Date().toISOString());
  return { ok: true };
}

// ---------- Admin: buyer matches overview ----------
// A read-only, all-deals view of every buyer<->deal match and its
// MatchStatus, for admin to spot what's negotiating/closing across the
// board and pick up any conversation. Updating a match (notes or status)
// happens through updateInterestedBuyerNotes / updateInterestedBuyerMatchStatus,
// same as reps use, since admin is just another eligible editor for these.

function adminGetBuyerRequests(body) {
  const sheet = getSheet(BUYERS_SHEET, BUYER_COLUMNS);
  let rows = sheetToObjects(sheet);
  if (body.dealId) rows = rows.filter(function (r) { return r['DealID'] === body.dealId; });
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealsById = {};
  sheetToObjects(dealsSheet).forEach(function (d) { dealsById[d['DealID']] = d; });
  rows.forEach(function (r) {
    const deal = dealsById[r['DealID']];
    r.address = deal ? deal['Address'] : '(deleted deal)';
    r.dealCode = deal ? deal['DealCode'] : '';
  });
  return { ok: true, requests: rows };
}

// ---------- Buyer leads (master calling list) ----------
//
// A buyer lead only generates follow-up pressure once it's paired with a
// specific active deal via a Pitch (see PITCH_COLUMNS). Status SOP is
// computed fresh from a pitch's contact log, never stored, so it can't drift:
//   Not Contacted        - nothing logged yet
//   Awaiting Response     - one contact logged, under 24 hours ago
//   Follow-Up In Progress - past 24h, but the required second-touch method(s)
//                           for this phone type aren't all logged yet
//   Follow-Up Due         - past 24h and no follow-up attempted at all
//   Responded             - any contact was marked as getting a response
//   Fully Worked          - the phone-type-appropriate two-touch SOP is
//                           complete (two calls for a landline; a call AND
//                           a text for a mobile) with no response -- this
//                           pitch no longer blocks that rep/deal from
//                           Auto-Feed giving out more
//
// Landlines can only ever be called (never texted). Mobiles can eventually
// be texted too, but only after the buyer has responded to a call (see
// addPitchContact) -- calling first, before any texting, is required
// regardless of phone type: sending texts to numbers with no reply history
// is what gets a business number flagged/blocked from texting by carriers.
// So the "worked, no response" outcome is always two calls -- if a text
// exists in the log at all, a response must already be on file too (texting
// pre-response is rejected server-side), which means status would already
// read 'Responded' above before this even matters.
function computeLeadStatus(phoneType, contacts) {
  if (!contacts || contacts.length === 0) return 'Not Contacted';
  const responded = contacts.some(function (c) { return c['Responded'] === true || c['Responded'] === 'TRUE'; });
  if (responded) return 'Responded';

  const sorted = contacts.slice().sort(function (a, b) { return new Date(a['ContactedAt']) - new Date(b['ContactedAt']); });
  const hoursSinceFirst = (Date.now() - new Date(sorted[0]['ContactedAt']).getTime()) / (60 * 60 * 1000);
  const followUpSatisfied = contacts.length >= 2;

  if (followUpSatisfied) return 'Fully Worked';
  if (hoursSinceFirst < FOLLOWUP_HOURS) return contacts.length === 1 ? 'Awaiting Response' : 'Follow-Up In Progress';
  return 'Follow-Up Due';
}

// ---------- Buyer calling hours (8am-7pm in the buyer's own time zone) ----------
// Approximate: mapped by State only (not exact city), since a real
// city-level time zone lookup needs a paid geocoding API. Good enough to
// keep reps from calling someone at 5am or 11pm; states that legitimately
// span multiple zones (TX, FL, etc.) get their majority zone.
const STATE_TIMEZONES = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Denver',
  IL: 'America/Chicago', IN: 'America/New_York', IA: 'America/Chicago', KS: 'America/Chicago',
  KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles',
  NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York',
  NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago',
  OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York',
  WI: 'America/Chicago', WY: 'America/Denver', DC: 'America/New_York'
};

function timeZoneForState(state) {
  const abbr = String(state || '').trim().toUpperCase();
  return STATE_TIMEZONES[abbr] || null;
}

// Returns { hour, withinCallingHours, timeZone } for a given US state
// abbreviation, or null if the state isn't recognized (calling hours can't
// be checked, so callers should treat that as "allow it" rather than block).
function callingHoursInfo(state) {
  const tz = timeZoneForState(state);
  if (!tz) return null;
  const hour = Number(Utilities.formatDate(new Date(), tz, 'H'));
  return { hour: hour, withinCallingHours: hour >= 8 && hour < 19, timeZone: tz };
}

// A pitch stops requiring action once its deal is no longer active (Sold or
// Dead) -- there's nothing left to sell that buyer on it, so it shouldn't
// keep generating follow-up pressure or block Auto-Feed from giving that rep
// something that's actually still for sale.
function leadNeedsAction(status, dealStillActive) {
  if (!dealStillActive) return false;
  return status === 'Not Contacted' || status === 'Awaiting Response' || status === 'Follow-Up Due' || status === 'Follow-Up In Progress';
}

function dealIsActive(deal) {
  return !!deal && deal['Status'] !== 'Sold' && deal['Status'] !== 'Dead';
}

// Case/whitespace-insensitive normalization for matching city/state/category
// names -- "Phoenix", " phoenix ", "PHOENIX" and "Phoenix  " all collapse to
// the same value, so imported data with inconsistent formatting still
// matches correctly instead of silently filtering everything out.
function normalizeText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Digits only, with a leading US country code stripped -- "555-123-4567",
// "(555) 123-4567", "+1 555 123 4567", and "15551234567" all normalize to
// the same 10-digit key, so format differences alone don't let the same
// buyer in twice.
function normalizePhoneForDedup(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return (digits.length === 11 && digits[0] === '1') ? digits.slice(1) : digits;
}

function splitCommaList(s) {
  return String(s || '').split(',').map(function (v) { return v.trim(); }).filter(Boolean);
}

// Whether a buyer lead should be offered a given deal, for both manual
// bulk-give (auto mode, no override) and Auto-Feed:
//   - State must match exactly (normalized) if the deal has one set.
//   - City must be either the deal's own City or one of its MatchCities
//     (normalized) -- if the deal has neither set, city isn't filtered on
//     at all. This is the multi-city-per-state matching area, since a real
//     "within 50 miles" radius would need a paid geocoding API.
//   - AssetCategory: if the deal has one set, the buyer must either have no
//     category preferences at all (treated as open to anything) or must
//     explicitly include this deal's category among theirs.
//   - Price range: if the buyer has told us both a min and max they'll
//     spend, and the deal's Price parses as a number, the deal's price must
//     fall within that range. Either side missing/unparseable skips this
//     dimension entirely rather than excluding the buyer.
// Any dimension the deal (or buyer, for price) hasn't set is simply not
// filtered on.
function buyerMatchesDeal(lead, deal) {
  const dealState = normalizeText(deal['State']);
  if (dealState && normalizeText(lead['State']) !== dealState) return false;

  const matchCities = [deal['City']].concat(splitCommaList(deal['MatchCities'])).map(normalizeText).filter(Boolean);
  if (matchCities.length > 0 && lead['City']) {
    if (matchCities.indexOf(normalizeText(lead['City'])) === -1) return false;
  }

  const dealCategory = normalizeText(deal['AssetCategory']);
  if (dealCategory) {
    const leadCategories = splitCommaList(lead['AssetCategories']).map(normalizeText);
    if (leadCategories.length > 0 && leadCategories.indexOf(dealCategory) === -1) return false;
  }

  const priceMin = parseMoney(lead['PriceRangeMin']);
  const priceMax = parseMoney(lead['PriceRangeMax']);
  if (priceMin !== null && priceMax !== null) {
    const dealPrice = parseMoney(deal['Price']);
    if (dealPrice !== null && (dealPrice < priceMin || dealPrice > priceMax)) return false;
  }

  return true;
}

// ---------- Asset categories ----------

function getAssetCategoryOptions(body, session) {
  const sheet = getSheet(ASSET_CATEGORIES_SHEET, ['Category']);
  let rows = sheetToObjects(sheet);
  if (rows.length === 0) {
    DEFAULT_ASSET_CATEGORIES.forEach(function (c) { appendRowByHeaders(sheet, { 'Category': c }); });
    rows = sheetToObjects(sheet);
  }
  return { ok: true, categories: rows.map(function (r) { return r['Category']; }) };
}

function adminAddAssetCategory(body) {
  const category = String(body.category || '').trim();
  if (!category) return { ok: false, error: 'Category name is required.' };
  const sheet = getSheet(ASSET_CATEGORIES_SHEET, ['Category']);
  const rows = sheetToObjects(sheet);
  if (rows.some(function (r) { return normalizeText(r['Category']) === normalizeText(category); })) {
    return { ok: false, error: 'That category already exists.' };
  }
  appendRowByHeaders(sheet, { 'Category': category });
  return { ok: true };
}

function adminRemoveAssetCategory(body) {
  const category = String(body.category || '').trim();
  const sheet = getSheet(ASSET_CATEGORIES_SHEET, ['Category']);
  const rows = sheetToObjects(sheet);
  const match = rows.find(function (r) { return r['Category'] === category; });
  if (!match) return { ok: false, error: 'Category not found.' };
  sheet.deleteRow(match._row);
  return { ok: true };
}

// Parses pasted CSV/TSV/spreadsheet text: BuyerName, Phone, PhoneType,
// City, State, Zip, Email, County -- comma or tab separated, one buyer per
// line. Email and County are last and optional specifically so they never
// shift the position of the other columns whether or not a given source
// list has them -- a 6-cell row (neither), 7-cell row (email only), and
// 8-cell row (both) all parse the same first six fields identically. Skips
// a header row if the first cell of the first line isn't a phone-looking
// value. PhoneType is normalized to exactly 'Mobile' or 'Landline'; any
// other value is kept as typed so an admin notices and fixes it rather
// than having it silently miscategorized as one or the other.
function parseBuyerLeadRows(text) {
  const lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  if (lines.length === 0) return [];
  const splitLine = function (line) { return line.indexOf('\t') !== -1 ? line.split('\t') : line.split(','); };

  let startIdx = 0;
  const firstCells = splitLine(lines[0]).map(function (c) { return c.trim(); });
  if (firstCells[0] && !/\d/.test(firstCells[0])) startIdx = 1; // looks like a header row

  const rows = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cells = splitLine(lines[i]).map(function (c) { return c.trim(); });
    if (cells.length === 0 || !cells[0]) continue;
    const rawType = (cells[2] || '').trim().toLowerCase();
    const phoneType = rawType === 'mobile' ? 'Mobile' : rawType === 'landline' ? 'Landline' : (cells[2] || '');
    rows.push({
      buyerName: cells[0] || '', phone: cells[1] || '', phoneType: phoneType,
      city: cells[3] || '', state: cells[4] || '', zip: cells[5] || '', email: cells[6] || '', county: cells[7] || ''
    });
  }
  return rows;
}

// Groups existing BuyerLeads rows that share a normalized phone or a
// normalized email into duplicate clusters (union-find, so if A matches B
// on phone and B matches C on email, all three land in one group together
// instead of two separate pairs). Only import-time dedup was in place
// before, so leads already in the sheet from earlier imports, manual
// paste, or direct spreadsheet edits could still collide -- this is the
// cleanup pass for what's already there.
function adminFindDuplicateBuyerLeads(body) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);

  const parent = {};
  leads.forEach(function (l) { parent[l['BuyerLeadID']] = l['BuyerLeadID']; });
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  [
    leads.reduce(function (groups, l) {
      const key = normalizePhoneForDedup(l['Phone']);
      if (key) { (groups[key] = groups[key] || []).push(l); }
      return groups;
    }, {}),
    leads.reduce(function (groups, l) {
      const key = normalizeText(l['Email']);
      if (key) { (groups[key] = groups[key] || []).push(l); }
      return groups;
    }, {})
  ].forEach(function (groups) {
    Object.keys(groups).forEach(function (key) {
      const group = groups[key];
      for (let i = 1; i < group.length; i++) union(group[0]['BuyerLeadID'], group[i]['BuyerLeadID']);
    });
  });

  const clusters = {};
  leads.forEach(function (l) {
    const root = find(l['BuyerLeadID']);
    (clusters[root] = clusters[root] || []).push(l);
  });

  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const pitchCountByLead = {};
  sheetToObjects(pitchesSheet).forEach(function (p) { pitchCountByLead[p['BuyerLeadID']] = (pitchCountByLead[p['BuyerLeadID']] || 0) + 1; });

  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const contactCountByLead = {};
  sheetToObjects(contactsSheet).forEach(function (c) { contactCountByLead[c['BuyerLeadID']] = (contactCountByLead[c['BuyerLeadID']] || 0) + 1; });

  const groups = Object.keys(clusters).map(function (root) { return clusters[root]; }).filter(function (g) { return g.length > 1; });

  return {
    ok: true,
    groups: groups.map(function (g) {
      return g.map(function (l) {
        return {
          buyerLeadId: l['BuyerLeadID'], buyerName: l['BuyerName'], phone: l['Phone'], email: l['Email'],
          city: l['City'], state: l['State'], createdAt: l['CreatedAt'],
          doNotContact: !!(l['DoNotContact'] === true || l['DoNotContact'] === 'TRUE'),
          pitchCount: pitchCountByLead[l['BuyerLeadID']] || 0,
          contactCount: contactCountByLead[l['BuyerLeadID']] || 0
        };
      });
    })
  };
}

// Folds one or more duplicate buyer leads into a single "keep" lead:
// reassigns their pitches to the kept lead (dropping any that would
// collide with a deal the kept lead already has a pitch on, rather than
// creating an actual duplicate pitch), reassigns all contact history
// unconditionally so nothing is lost, backfills any profile field the kept
// lead is missing from whichever duplicate has it, carries over Do Not
// Contact if any of them were flagged, and finally deletes the merged
// rows. Never deletes contact history -- only ever repoints it.
function adminMergeBuyerLeads(body) {
  if (!body.keepId || !body.mergeIds || body.mergeIds.length === 0) return { ok: false, error: 'Missing keepId or mergeIds.' };
  const mergeIds = body.mergeIds.filter(function (id) { return id !== body.keepId; });
  if (mergeIds.length === 0) return { ok: false, error: 'Nothing to merge.' };
  const mergeSet = {};
  mergeIds.forEach(function (id) { mergeSet[id] = true; });

  return withLock(function () {
    const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    const leads = sheetToObjects(leadsSheet);
    const keepLead = leads.find(function (l) { return l['BuyerLeadID'] === body.keepId; });
    if (!keepLead) return { ok: false, error: 'Lead to keep not found.' };
    const mergeLeads = leads.filter(function (l) { return mergeSet[l['BuyerLeadID']]; });
    if (mergeLeads.length === 0) return { ok: false, error: 'Leads to merge not found.' };

    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const allPitches = sheetToObjects(pitchesSheet);
    const keepDealIds = {};
    allPitches.forEach(function (p) { if (p['BuyerLeadID'] === body.keepId) keepDealIds[p['DealID']] = true; });

    const pitchRowsToDelete = [];
    allPitches.forEach(function (p) {
      if (!mergeSet[p['BuyerLeadID']]) return;
      if (keepDealIds[p['DealID']]) {
        pitchRowsToDelete.push(p._row);
      } else {
        pitchesSheet.getRange(p._row, getColumnIndex(pitchesSheet, 'BuyerLeadID')).setValue(body.keepId);
        keepDealIds[p['DealID']] = true;
      }
    });
    pitchRowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (row) { pitchesSheet.deleteRow(row); });

    const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
    sheetToObjects(contactsSheet).forEach(function (c) {
      if (mergeSet[c['BuyerLeadID']]) {
        contactsSheet.getRange(c._row, getColumnIndex(contactsSheet, 'BuyerLeadID')).setValue(body.keepId);
      }
    });

    const fillableFields = ['Phone2', 'Phone2Type', 'Phone3', 'Phone3Type', 'Email', 'County', 'AssetCategories', 'LastKnownPurchasePrice', 'EstimatedPropertyValue', 'PortfolioValue', 'OwnershipLengthMonths', 'PropertyURL', 'PriceRangeMin', 'PriceRangeMax', 'DriveLink', 'GeneralNotes'];
    fillableFields.forEach(function (f) {
      if (keepLead[f]) return;
      const donor = mergeLeads.find(function (l) { return l[f]; });
      if (donor) leadsSheet.getRange(keepLead._row, getColumnIndex(leadsSheet, f)).setValue(donor[f]);
    });

    const anyDnc = mergeLeads.some(function (l) { return l['DoNotContact'] === true || l['DoNotContact'] === 'TRUE'; });
    if (anyDnc && !(keepLead['DoNotContact'] === true || keepLead['DoNotContact'] === 'TRUE')) {
      leadsSheet.getRange(keepLead._row, getColumnIndex(leadsSheet, 'DoNotContact')).setValue(true);
    }

    mergeLeads.sort(function (a, b) { return b._row - a._row; }).forEach(function (l) { leadsSheet.deleteRow(l._row); });

    return { ok: true, mergedCount: mergeLeads.length };
  });
}

function adminImportBuyerLeads(body) {
  const rows = body.pasteText ? parseBuyerLeadRows(body.pasteText) : (body.rows || []);
  if (rows.length === 0) return { ok: false, error: 'No rows found to import.' };

  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const existing = sheetToObjects(sheet);
  const existingPhones = {};
  const existingEmails = {};
  existing.forEach(function (l) {
    const p = normalizePhoneForDedup(l['Phone']);
    if (p) existingPhones[p] = true;
    const e = normalizeText(l['Email']);
    if (e) existingEmails[e] = true;
  });

  let skippedDuplicates = 0;
  const now = new Date().toISOString();
  const newRows = [];
  rows.forEach(function (r) {
    if (!r.buyerName || !r.phone) return;
    const normalizedPhone = normalizePhoneForDedup(r.phone);
    const normalizedEmail = normalizeText(r.email);
    if (existingPhones[normalizedPhone] || (normalizedEmail && existingEmails[normalizedEmail])) { skippedDuplicates++; return; }
    existingPhones[normalizedPhone] = true;
    if (normalizedEmail) existingEmails[normalizedEmail] = true;
    newRows.push({
      'BuyerLeadID': Utilities.getUuid(), 'BuyerName': r.buyerName, 'Phone': r.phone, 'PhoneType': r.phoneType || '',
      'Phone2': r.phone2 || '', 'Phone2Type': r.phone2Type || '', 'Phone3': r.phone3 || '', 'Phone3Type': r.phone3Type || '',
      'Email': r.email || '', 'City': r.city || '', 'State': r.state || '', 'Zip': r.zip || '', 'County': r.county || '',
      'AssetCategories': r.assetCategories || '', 'LastKnownPurchasePrice': r.lastKnownPurchasePrice || '',
      'EstimatedPropertyValue': r.estimatedPropertyValue || '', 'PortfolioValue': r.portfolioValue || '',
      'OwnershipLengthMonths': r.ownershipLengthMonths || '', 'PropertyURL': r.propertyUrl || '',
      'PriceRangeMin': r.priceRangeMin || '', 'PriceRangeMax': r.priceRangeMax || '',
      'GeneralNotes': '', 'DriveLink': '', 'DoNotContact': false, 'PendingDealID': '', 'CreatedAt': now
    });
  });
  appendRowsByHeaders(sheet, newRows);

  // Lets the frontend offer a "just show what I uploaded" view right after
  // an import, instead of the new batch getting lost in however many leads
  // were already in the sheet.
  return { ok: true, imported: newRows.length, skippedDuplicates: skippedDuplicates, importedIds: newRows.map(function (r) { return r['BuyerLeadID']; }), importedAt: now };
}

// Joins every pitch to its contacts and computes each one's live status,
// tagging whether its deal is still active. dealsById must be a map of
// DealID -> deal object (caller builds this once and reuses it).
// dealAddress is included here for admin-only callers (adminGetPitchesForBuyerLead)
// -- getMyPitches (rep-facing) strips it back out before returning, since a
// rep must never receive a deal's Address at all. dealCode is always safe
// for either audience.
function pitchesWithStatus(pitchRows, allContacts, dealsById) {
  const contactsByPitch = {};
  allContacts.forEach(function (c) {
    if (!contactsByPitch[c['PitchID']]) contactsByPitch[c['PitchID']] = [];
    contactsByPitch[c['PitchID']].push(c);
  });
  return pitchRows.map(function (p) {
    const deal = dealsById[p['DealID']];
    const contacts = contactsByPitch[p['PitchID']] || [];
    const copy = Object.assign({}, p);
    // Do Not Contact overrides the call-progress status entirely -- once a
    // buyer's marked DNC there's no more "New"/"Called"/"Responded" to
    // track, and this is the one place that status is ever displayed from,
    // so every pitch list (admin's whole-team Pitches tab, a buyer's own
    // pitch history, a rep's My Pitches) shows it consistently without each
    // caller needing its own check.
    copy.status = p._doNotContact ? 'Do Not Contact' : computeLeadStatus(p._phoneType, contacts);
    copy.contactCount = contacts.length;
    copy.dealAddress = deal ? deal['Address'] : '(deleted deal)';
    copy.dealCode = deal ? deal['DealCode'] : '';
    copy.dealStatus = deal ? deal['Status'] : '';
    copy.dealStillActive = dealIsActive(deal);
    return copy;
  });
}

function adminGetBuyerLeads(body) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  let leads = sheetToObjects(sheet);
  const f = body.filters || {};
  if (f.city) leads = leads.filter(function (l) { return normalizeText(l['City']) === normalizeText(f.city); });
  if (f.state) leads = leads.filter(function (l) { return normalizeText(l['State']) === normalizeText(f.state); });
  if (f.zip) leads = leads.filter(function (l) { return String(l['Zip'] || '') === String(f.zip); });
  if (f.assetCategory) {
    leads = leads.filter(function (l) { return splitCommaList(l['AssetCategories']).map(normalizeText).indexOf(normalizeText(f.assetCategory)) !== -1; });
  }
  if (f.doNotContact === false) leads = leads.filter(function (l) { return l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE'; });

  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const allPitches = sheetToObjects(pitchesSheet);
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealsById = {};
  sheetToObjects(dealsSheet).forEach(function (d) { dealsById[d['DealID']] = d; });

  const openPitchesByLead = {};
  allPitches.forEach(function (p) {
    if (!openPitchesByLead[p['BuyerLeadID']]) openPitchesByLead[p['BuyerLeadID']] = [];
    const deal = dealsById[p['DealID']];
    openPitchesByLead[p['BuyerLeadID']].push({
      pitchId: p['PitchID'], dealId: p['DealID'],
      dealAddress: deal ? deal['Address'] : '(deleted deal)', username: p['Username']
    });
  });

  const withPitches = leads.map(function (l) {
    const copy = Object.assign({}, l);
    copy.openPitches = openPitchesByLead[l['BuyerLeadID']] || [];
    return copy;
  });
  return { ok: true, leads: withPitches };
}

function updateBuyerLeadNotes(body, session) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  if (!session.a) {
    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const ownsAPitch = sheetToObjects(pitchesSheet).some(function (p) {
      return p['BuyerLeadID'] === body.buyerLeadId && String(p['Username'] || '').toLowerCase() === session.u;
    });
    if (!ownsAPitch) return { ok: false, error: 'You need an active pitch on this buyer to edit their notes.' };
  }
  sheet.getRange(match._row, getColumnIndex(sheet, 'GeneralNotes')).setValue(body.notes || '');
  return { ok: true };
}

// Same permission model as updateBuyerLeadNotes/updateBuyerLeadDoNotContact:
// admin, or any rep with an open pitch on this one buyer, can edit -- one
// lead at a time. (Mass-editing many leads at once is admin-only, see
// adminBulkUpdateBuyerLeads below.)
const BUYER_LEAD_PROFILE_FIELDS = {
  email: 'Email', driveLink: 'DriveLink', phone: 'Phone', phoneType: 'PhoneType', phone2: 'Phone2', phone2Type: 'Phone2Type',
  phone3: 'Phone3', phone3Type: 'Phone3Type', county: 'County', assetCategories: 'AssetCategories',
  lastKnownPurchasePrice: 'LastKnownPurchasePrice', estimatedPropertyValue: 'EstimatedPropertyValue', portfolioValue: 'PortfolioValue',
  ownershipLengthMonths: 'OwnershipLengthMonths', propertyUrl: 'PropertyURL',
  priceRangeMin: 'PriceRangeMin', priceRangeMax: 'PriceRangeMax'
};

// The Propwire (or similar) source listing URL is admin-only -- not shown
// to or editable by reps. Checked against BUYER_LEAD_PROFILE_FIELDS keys.
const ADMIN_ONLY_PROFILE_FIELDS = ['propertyUrl'];

function updateBuyerLeadProfile(body, session) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const match = sheetToObjects(sheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  if (!session.a) {
    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const ownsAPitch = sheetToObjects(pitchesSheet).some(function (p) {
      return p['BuyerLeadID'] === body.buyerLeadId && String(p['Username'] || '').toLowerCase() === session.u;
    });
    if (!ownsAPitch) return { ok: false, error: 'You need an active pitch on this buyer to edit their info.' };
  }
  Object.keys(BUYER_LEAD_PROFILE_FIELDS).forEach(function (key) {
    if (ADMIN_ONLY_PROFILE_FIELDS.indexOf(key) !== -1 && !session.a) return;
    if (body[key] !== undefined) sheet.getRange(match._row, getColumnIndex(sheet, BUYER_LEAD_PROFILE_FIELDS[key])).setValue(body[key] || '');
  });
  return { ok: true };
}

// Admin-only. Applies the same value to every listed buyer lead for
// whichever fields are present in body.data (fields the admin didn't check
// an "apply" box for in the UI are simply absent from data, not touched
// here at all) -- the backfill tool for "I know these 50 leads are all
// Single Family but never got that set on import."
// Reads the whole sheet once and writes it back once, instead of one
// getRange()+setValue() round trip per field per row (which for, say, 50
// leads x 2 fields was 200 separate Sheets service calls). Editing the
// in-memory grid and writing it back in a single setValues() is 2 calls
// total no matter how many rows or fields are involved.
function adminBulkUpdateBuyerLeads(body) {
  if (!body.buyerLeadIds || body.buyerLeadIds.length === 0) return { ok: false, error: 'No leads selected.' };
  const data = body.data || {};
  const keys = Object.keys(data).filter(function (k) { return BUYER_LEAD_PROFILE_FIELDS[k]; });
  if (keys.length === 0) return { ok: false, error: 'No fields selected to apply.' };

  const wanted = {};
  body.buyerLeadIds.forEach(function (id) { wanted[id] = true; });

  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('BuyerLeadID');
  const fieldCols = keys.map(function (key) {
    return { col: headers.indexOf(BUYER_LEAD_PROFILE_FIELDS[key]), value: data[key] || '' };
  });

  let updatedCount = 0;
  for (let i = 1; i < values.length; i++) {
    if (!wanted[values[i][idCol]]) continue;
    fieldCols.forEach(function (f) { values[i][f.col] = f.value; });
    updatedCount++;
  }
  if (updatedCount > 0) {
    sheet.getRange(1, 1, values.length, headers.length).setValues(values);
  }
  return { ok: true, updatedCount: updatedCount };
}

// Either admin, or a rep with an open pitch on this buyer, can flag Do Not
// Contact -- most often it'll be whichever rep is on the phone when the
// buyer says to stop calling. Once true: addPitchContact refuses to log any
// new call/text against this buyer on any phone number/pitch, and
// adminGiveBuyerLeadToRep/adminGiveBuyerLeadsBulk/autoFeedCheck all skip
// this buyer entirely, so nobody can be newly pitched to them either.
// Existing pitches and their history are left alone -- only new contact is
// blocked.
function updateBuyerLeadDoNotContact(body, session) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const match = sheetToObjects(sheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  if (!session.a) {
    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const ownsAPitch = sheetToObjects(pitchesSheet).some(function (p) {
      return p['BuyerLeadID'] === body.buyerLeadId && String(p['Username'] || '').toLowerCase() === session.u;
    });
    if (!ownsAPitch) return { ok: false, error: 'You need an active pitch on this buyer to change this.' };
  }
  sheet.getRange(match._row, getColumnIndex(sheet, 'DoNotContact')).setValue(!!body.doNotContact);
  return { ok: true };
}

// Gives one buyer lead to one rep for one specific deal -- creates a Pitch.
// Two reps can each have their own pitch on the same buyer for two
// different deals, but giving the SAME deal to two different reps for the
// SAME buyer is blocked, since that's exactly the double-call scenario this
// whole model exists to prevent.
function adminGiveBuyerLeadToRep(body) {
  if (!body.buyerLeadId || !body.dealId || !body.username) return { ok: false, error: 'Missing buyerLeadId, dealId, or username.' };
  const username = String(body.username).trim().toLowerCase();
  return withLock(function () {
    const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    const lead = sheetToObjects(leadsSheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
    if (lead && (lead['DoNotContact'] === true || lead['DoNotContact'] === 'TRUE')) {
      return { ok: false, error: 'This buyer is marked Do Not Contact and cannot be given a new pitch.' };
    }
    const sheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const existing = sheetToObjects(sheet);
    // Multiple reps CAN share the same buyer+deal now (e.g. two people
    // working the same market as backup for each other) -- only block a
    // literal duplicate: this same rep getting this same buyer for this
    // same deal twice.
    const clash = existing.find(function (p) { return p['BuyerLeadID'] === body.buyerLeadId && p['DealID'] === body.dealId && String(p['Username'] || '').toLowerCase() === username; });
    if (clash) return { ok: false, error: 'This buyer already has an open pitch for this deal with this team member.' };

    const pitchId = Utilities.getUuid();
    appendRowByHeaders(sheet, {
      'PitchID': pitchId, 'BuyerLeadID': body.buyerLeadId, 'DealID': body.dealId,
      'Username': username, 'GivenAt': new Date().toISOString()
    });
    return { ok: true, pitchId: pitchId };
  });
}

// Gives a batch of buyer leads to one rep for one deal, skipping any buyer
// lead THIS REP already has an open pitch on for this deal (a different rep
// already having it is fine -- e.g. two people covering the same market) or
// is marked Do Not Contact. With no city/state/zip override typed in,
// matching is auto: same State, City equal to the deal's own City or one of
// its MatchCities, and AssetCategory compatible -- all case/whitespace-
// insensitive (see buyerMatchesDeal). Typing an explicit city/state/zip
// override switches to a plain exact-match filter on just those fields
// instead, for deliberate manual control.
function adminGiveBuyerLeadsBulk(body) {
  if (!body.dealId || !body.username || !body.count) return { ok: false, error: 'Missing dealId, username, or count.' };
  const username = String(body.username).trim().toLowerCase();

  return withLock(function () {
    const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
    const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
    if (!deal) return { ok: false, error: 'Deal not found.' };

    const hasOverride = body.city || body.state || body.zip;

    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const existingPitches = sheetToObjects(pitchesSheet);
    const alreadyPitchedByThisRepForThisDeal = {};
    existingPitches.forEach(function (p) {
      if (p['DealID'] === body.dealId && String(p['Username'] || '').toLowerCase() === username) alreadyPitchedByThisRepForThisDeal[p['BuyerLeadID']] = true;
    });

    const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    let pool = sheetToObjects(leadsSheet).filter(function (l) {
      return !alreadyPitchedByThisRepForThisDeal[l['BuyerLeadID']] && l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE';
    });
    if (hasOverride) {
      if (body.city) pool = pool.filter(function (l) { return normalizeText(l['City']) === normalizeText(body.city); });
      if (body.state) pool = pool.filter(function (l) { return normalizeText(l['State']) === normalizeText(body.state); });
      if (body.zip) pool = pool.filter(function (l) { return String(l['Zip'] || '') === String(body.zip); });
    } else {
      pool = pool.filter(function (l) { return buyerMatchesDeal(l, deal); });
    }

    const batch = pool.slice(0, Number(body.count));
    const now = new Date().toISOString();
    appendRowsByHeaders(pitchesSheet, batch.map(function (l) {
      return { 'PitchID': Utilities.getUuid(), 'BuyerLeadID': l['BuyerLeadID'], 'DealID': body.dealId, 'Username': username, 'GivenAt': now };
    }));
    return { ok: true, givenCount: batch.length, remainingInPool: pool.length - batch.length };
  });
}

// Gives a specific, admin-picked set of buyer leads (e.g. from a mass
// selection filtered by asset category) to one rep for one deal. Silently
// skips any THIS REP already has an open pitch on for this deal, or that
// are Do Not Contact, rather than failing the whole batch over a few.
function adminGiveSelectedBuyerLeads(body) {
  if (!body.dealId || !body.username || !body.buyerLeadIds || body.buyerLeadIds.length === 0) {
    return { ok: false, error: 'Missing dealId, username, or buyerLeadIds.' };
  }
  const username = String(body.username).trim().toLowerCase();
  const wanted = {};
  body.buyerLeadIds.forEach(function (id) { wanted[id] = true; });

  return withLock(function () {
    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const existingPitches = sheetToObjects(pitchesSheet);
    const alreadyPitchedByThisRepForThisDeal = {};
    existingPitches.forEach(function (p) {
      if (p['DealID'] === body.dealId && String(p['Username'] || '').toLowerCase() === username) alreadyPitchedByThisRepForThisDeal[p['BuyerLeadID']] = true;
    });

    const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    const candidates = sheetToObjects(leadsSheet).filter(function (l) {
      return wanted[l['BuyerLeadID']] && !alreadyPitchedByThisRepForThisDeal[l['BuyerLeadID']] &&
        l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE';
    });

    const now = new Date().toISOString();
    appendRowsByHeaders(pitchesSheet, candidates.map(function (l) {
      return { 'PitchID': Utilities.getUuid(), 'BuyerLeadID': l['BuyerLeadID'], 'DealID': body.dealId, 'Username': username, 'GivenAt': now };
    }));

    // A lead tagged "pending" for this exact deal just became a real pitch
    // for it, so the pending tag has served its purpose -- clear it (one
    // batched read+write, not a per-row call). Leaves alone any lead
    // pending for a *different* deal, in case it's deliberately being
    // tracked for both.
    const clearIds = {};
    candidates.forEach(function (l) { if (l['PendingDealID'] === body.dealId) clearIds[l['BuyerLeadID']] = true; });
    if (Object.keys(clearIds).length > 0) {
      const values = leadsSheet.getDataRange().getValues();
      const headers = values[0];
      const idCol = headers.indexOf('BuyerLeadID');
      const pendingCol = headers.indexOf('PendingDealID');
      for (let i = 1; i < values.length; i++) {
        if (clearIds[values[i][idCol]]) values[i][pendingCol] = '';
      }
      leadsSheet.getRange(1, 1, values.length, headers.length).setValues(values);
    }

    return { ok: true, givenCount: candidates.length, skipped: body.buyerLeadIds.length - candidates.length };
  });
}

// Earmarks a batch of buyer leads for a deal WITHOUT creating any pitches
// (no rep involved) -- purely an admin-side organizational tag so leads
// can be sorted by "which deal are these for" before deciding who actually
// works them. Never appears in any rep's queue; only adminGetBuyerLeads
// surfaces it. Passing an empty dealId clears the tag instead of setting
// one, so the same action doubles as "un-tag."
function adminTagBuyerLeadsForDeal(body) {
  if (!body.buyerLeadIds || body.buyerLeadIds.length === 0) return { ok: false, error: 'No leads selected.' };
  const dealId = body.dealId || '';
  const wanted = {};
  body.buyerLeadIds.forEach(function (id) { wanted[id] = true; });

  return withLock(function () {
    const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const idCol = headers.indexOf('BuyerLeadID');
    const pendingCol = headers.indexOf('PendingDealID');

    let taggedCount = 0;
    for (let i = 1; i < values.length; i++) {
      if (!wanted[values[i][idCol]]) continue;
      values[i][pendingCol] = dealId;
      taggedCount++;
    }
    if (taggedCount > 0) {
      sheet.getRange(1, 1, values.length, headers.length).setValues(values);
    }
    return { ok: true, taggedCount: taggedCount };
  });
}

function adminReassignPitch(body) {
  if (!body.pitchId || !body.username) return { ok: false, error: 'Missing pitchId or username.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const pitches = sheetToObjects(sheet);
  const match = pitches.find(function (p) { return p['PitchID'] === body.pitchId; });
  if (!match) return { ok: false, error: 'Pitch not found.' };
  // Multiple reps can share a buyer+deal, but the same rep can't have it
  // twice -- block only if the target rep already has a *different* open
  // pitch on this exact buyer+deal.
  const clash = pitches.find(function (p) {
    return p['PitchID'] !== body.pitchId && p['BuyerLeadID'] === match['BuyerLeadID'] && p['DealID'] === match['DealID'] && String(p['Username'] || '').toLowerCase() === username;
  });
  if (clash) return { ok: false, error: 'That team member already has an open pitch for this exact buyer on this deal.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'Username')).setValue(username);
  return { ok: true };
}

// Reassigns many pitches to one rep at once. If two selected pitches (or a
// selected pitch and one the target rep already holds, outside the
// selection) share the same buyer+deal, reassigning all of them onto the
// same rep would create a literal duplicate -- those extras are dropped
// (deleted) rather than reassigned, so the target rep ends up with at most
// one pitch per buyer+deal, same rule as everywhere else.
function adminBulkReassignPitches(body) {
  if (!body.pitchIds || body.pitchIds.length === 0) return { ok: false, error: 'No pitches selected.' };
  if (!body.username) return { ok: false, error: 'Missing username.' };
  const username = String(body.username).trim().toLowerCase();
  const wanted = {};
  body.pitchIds.forEach(function (id) { wanted[id] = true; });

  return withLock(function () {
    const sheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const idCol = headers.indexOf('PitchID');
    const buyerCol = headers.indexOf('BuyerLeadID');
    const dealCol = headers.indexOf('DealID');
    const userCol = headers.indexOf('Username');

    const targetAlreadyHasCombo = {};
    for (let i = 1; i < values.length; i++) {
      if (wanted[values[i][idCol]]) continue;
      if (String(values[i][userCol] || '').toLowerCase() === username) {
        targetAlreadyHasCombo[values[i][buyerCol] + '|' + values[i][dealCol]] = true;
      }
    }

    let reassignedCount = 0;
    const rowsToDrop = [];
    const claimedCombosInBatch = {};
    for (let i = 1; i < values.length; i++) {
      if (!wanted[values[i][idCol]]) continue;
      const comboKey = values[i][buyerCol] + '|' + values[i][dealCol];
      if (targetAlreadyHasCombo[comboKey] || claimedCombosInBatch[comboKey]) {
        rowsToDrop.push(i + 1);
        continue;
      }
      values[i][userCol] = username;
      claimedCombosInBatch[comboKey] = true;
      reassignedCount++;
    }

    sheet.getRange(1, 1, values.length, headers.length).setValues(values);
    rowsToDrop.sort(function (a, b) { return b - a; }).forEach(function (row) { sheet.deleteRow(row); });

    return { ok: true, reassignedCount: reassignedCount, droppedCount: rowsToDrop.length };
  });
}

// Deletes the pitch row itself (so the buyer lead becomes available for a
// fresh pitch on this deal again) but never touches BuyerLeadContacts --
// the record of what was actually said to this buyer about this deal stays
// permanently, even after the pitch that generated it is gone.
function adminWithdrawPitch(body) {
  if (!body.pitchId) return { ok: false, error: 'Missing pitchId.' };
  const sheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const pitches = sheetToObjects(sheet);
  const match = pitches.find(function (p) { return p['PitchID'] === body.pitchId; });
  if (!match) return { ok: false, error: 'Pitch not found.' };
  sheet.deleteRow(match._row);
  return { ok: true };
}

function adminGetPitchesForBuyerLead(body) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const pitches = sheetToObjects(pitchesSheet).filter(function (p) { return p['BuyerLeadID'] === body.buyerLeadId; });

  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const lead = sheetToObjects(leadsSheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealsById = {};
  sheetToObjects(dealsSheet).forEach(function (d) { dealsById[d['DealID']] = d; });
  pitches.forEach(function (p) {
    p._phoneType = lead ? lead['PhoneType'] : '';
    p._doNotContact = !!(lead && (lead['DoNotContact'] === true || lead['DoNotContact'] === 'TRUE'));
  });

  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const allContacts = sheetToObjects(contactsSheet).filter(function (c) { return c['BuyerLeadID'] === body.buyerLeadId; });

  return { ok: true, pitches: pitchesWithStatus(pitches, allContacts, dealsById) };
}

// A single, whole-team view of every open pitch -- unlike
// adminGetPitchesForBuyerLead (one buyer at a time, buried inside that
// buyer's detail panel), this is the admin's one-stop place to see who has
// what and pull work back from a rep (dead deal, overloaded queue, etc.)
// without hunting through individual buyers first.
function adminGetAllPitches(body) {
  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const pitches = sheetToObjects(pitchesSheet);

  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leadsById = {};
  sheetToObjects(leadsSheet).forEach(function (l) { leadsById[l['BuyerLeadID']] = l; });

  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealsById = {};
  sheetToObjects(dealsSheet).forEach(function (d) { dealsById[d['DealID']] = d; });

  pitches.forEach(function (p) {
    const lead = leadsById[p['BuyerLeadID']];
    p._phoneType = lead ? lead['PhoneType'] : '';
    p._doNotContact = !!(lead && (lead['DoNotContact'] === true || lead['DoNotContact'] === 'TRUE'));
    p.buyerName = lead ? lead['BuyerName'] : '(deleted buyer)';
    p.buyerPhone = lead ? lead['Phone'] : '';
  });

  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const allContacts = sheetToObjects(contactsSheet);

  return { ok: true, pitches: pitchesWithStatus(pitches, allContacts, dealsById) };
}

// Withdraws many pitches at once (e.g. "pull everything this rep has on a
// deal that just went dead"). Same effect as calling adminWithdrawPitch
// repeatedly -- deletes the Pitches rows only, never touches
// BuyerLeadContacts, so contact history survives.
function adminBulkWithdrawPitches(body) {
  if (!body.pitchIds || body.pitchIds.length === 0) return { ok: false, error: 'No pitches selected.' };
  const wanted = {};
  body.pitchIds.forEach(function (id) { wanted[id] = true; });

  const sheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const rows = sheetToObjects(sheet).filter(function (p) { return wanted[p['PitchID']]; });
  // Delete highest row first so earlier _row indexes stay valid as rows shift up.
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (p) { sheet.deleteRow(p._row); });

  return { ok: true, withdrawnCount: rows.length };
}

function adminGetPitchContacts(body) {
  if (!body.pitchId) return { ok: false, error: 'Missing pitchId.' };
  const sheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const contacts = sheetToObjects(sheet).filter(function (c) { return c['PitchID'] === body.pitchId; });
  return { ok: true, contacts: contacts };
}

// Also doubles as the general "edit a rep's details" save -- phone plus
// their preferred working area (city/zip are still single values; state
// is a comma-separated list so a rep can be matched against deals across
// several states at once, same convention as a deal's MatchCities).
function adminSetRepPreferredArea(body) {
  if (!body.username) return { ok: false, error: 'Missing username.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet);
  const match = reps.find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === username; });
  if (!match) return { ok: false, error: 'Rep not found.' };
  if (body.phone !== undefined) sheet.getRange(match._row, getColumnIndex(sheet, 'Phone')).setValue(body.phone || '');
  if (body.email !== undefined) sheet.getRange(match._row, getColumnIndex(sheet, 'Email')).setValue(body.email || '');
  sheet.getRange(match._row, getColumnIndex(sheet, 'PreferredCity')).setValue(body.city || '');
  sheet.getRange(match._row, getColumnIndex(sheet, 'PreferredState')).setValue(body.state || '');
  sheet.getRange(match._row, getColumnIndex(sheet, 'PreferredZip')).setValue(body.zip || '');
  return { ok: true };
}

// ---------- "Want to join?" contact (shown on the login page) ----------
// Deliberately just script properties rather than a Reps row -- this isn't
// a real login, it's a contact card for anyone who doesn't have an account
// yet and wants to ask about joining the dispositions team to get deals.
// Admin can point it at themselves, someone else, or swap it any time
// without touching the actual team roster. getJoinContact is public (no
// session) since it has to render before anyone logs in.
function getJoinContact() {
  const props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    name: props.getProperty('JOIN_CONTACT_NAME') || '',
    phone: props.getProperty('JOIN_CONTACT_PHONE') || '',
    email: props.getProperty('JOIN_CONTACT_EMAIL') || ''
  };
}

function adminSetJoinContact(body) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('JOIN_CONTACT_NAME', body.name || '');
  props.setProperty('JOIN_CONTACT_PHONE', body.phone || '');
  props.setProperty('JOIN_CONTACT_EMAIL', body.email || '');
  return { ok: true };
}

// ---------- Auto-feed ----------
// When enabled, looks at every active deal (not Sold/Dead) and, for each rep
// with access to it who has zero open pitches on that deal still needing
// action, gives them more matching buyer leads for that deal automatically
// (see adminGiveBuyerLeadsBulk's matching logic). A rep's PreferredCity/
// State/Zip, if set, additionally restricts which of their deals qualify --
// so a rep working Phoenix doesn't get auto-given a pitch for a deal in a
// city they've never been assigned to work. Callable on demand via
// adminRunAutoFeedNow, or on a schedule if you install a time-driven
// trigger calling autoFeedCheck (see SETUP.md).
function adminGetAutoFeedSettings(body) {
  const props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    enabled: props.getProperty('AUTO_FEED_ENABLED') === 'TRUE',
    batchSize: Number(props.getProperty('AUTO_FEED_BATCH_SIZE') || '50')
  };
}

function adminSetAutoFeed(body) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('AUTO_FEED_ENABLED', body.enabled ? 'TRUE' : 'FALSE');
  if (body.batchSize) props.setProperty('AUTO_FEED_BATCH_SIZE', String(Number(body.batchSize)));
  return { ok: true };
}

function adminRunAutoFeedNow(body) {
  return autoFeedCheck();
}

function repMatchesArea(rep, deal) {
  if (rep['PreferredCity'] && normalizeText(rep['PreferredCity']) !== normalizeText(deal['City'])) return false;
  if (rep['PreferredState']) {
    const states = splitCommaList(rep['PreferredState']).map(normalizeText);
    if (states.length > 0 && states.indexOf(normalizeText(deal['State'])) === -1) return false;
  }
  if (rep['PreferredZip'] && String(rep['PreferredZip']) !== String(deal['Zip'] || '')) return false;
  return true;
}

function autoFeedCheck() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('AUTO_FEED_ENABLED') !== 'TRUE') return { ok: true, fed: [], reason: 'Auto-feed is turned off.' };
  return withLock(function () { return autoFeedCheckLocked(props); });
}

function autoFeedCheckLocked(props) {
  const batchSize = Number(props.getProperty('AUTO_FEED_BATCH_SIZE') || '50');

  const repsSheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(repsSheet).filter(function (r) {
    const active = !(r['Active'] === false || r['Active'] === 'FALSE');
    const isAdmin = r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE';
    return active && !isAdmin;
  });

  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const activeDeals = sheetToObjects(dealsSheet).filter(dealIsActive);

  const assignmentsSheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const allAssignments = sheetToObjects(assignmentsSheet);
  const assignedUsernamesByDeal = {};
  allAssignments.forEach(function (a) {
    if (!assignedUsernamesByDeal[a['DealID']]) assignedUsernamesByDeal[a['DealID']] = [];
    assignedUsernamesByDeal[a['DealID']].push(String(a['Username'] || '').toLowerCase());
  });

  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const allPitches = sheetToObjects(pitchesSheet);
  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const allContacts = sheetToObjects(contactsSheet);
  const contactsByPitch = {};
  allContacts.forEach(function (c) {
    if (!contactsByPitch[c['PitchID']]) contactsByPitch[c['PitchID']] = [];
    contactsByPitch[c['PitchID']].push(c);
  });

  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const allLeads = sheetToObjects(leadsSheet);
  const leadsById = {};
  allLeads.forEach(function (l) { leadsById[l['BuyerLeadID']] = l; });

  const fed = [];
  const newPitchRows = [];
  activeDeals.forEach(function (deal) {
    const eligibleReps = reps.filter(function (rep) {
      const hasAccess = rep['AllAccess'] === true || rep['AllAccess'] === 'TRUE' ||
        (assignedUsernamesByDeal[deal['DealID']] || []).indexOf(rep['Username']) !== -1;
      return hasAccess && repMatchesArea(rep, deal);
    });
    if (eligibleReps.length === 0) return;

    // Shared across every rep considered for this deal (not rebuilt per
    // rep) so a buyer lead handed to one rep here can't also be handed to
    // a second rep later in this same run -- allPitches is a snapshot from
    // before this run started, so without this it wouldn't know about
    // leads already claimed earlier in the loop.
    const alreadyPitchedForThisDeal = {};
    allPitches.forEach(function (p) { if (p['DealID'] === deal['DealID']) alreadyPitchedForThisDeal[p['BuyerLeadID']] = true; });

    eligibleReps.forEach(function (rep) {
      const username = rep['Username'];
      const myPitchesOnThisDeal = allPitches.filter(function (p) { return p['DealID'] === deal['DealID'] && p['Username'] === username; });
      const stillNeedsAction = myPitchesOnThisDeal.some(function (p) {
        const lead = leadsById[p['BuyerLeadID']];
        return leadNeedsAction(computeLeadStatus(lead ? lead['PhoneType'] : '', contactsByPitch[p['PitchID']] || []), true);
      });
      if (stillNeedsAction) return;

      const pool = allLeads.filter(function (l) {
        return !alreadyPitchedForThisDeal[l['BuyerLeadID']] && l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE' && buyerMatchesDeal(l, deal);
      });
      if (pool.length === 0) return;

      const batch = pool.slice(0, batchSize);
      const now = new Date().toISOString();
      batch.forEach(function (l) {
        newPitchRows.push({ 'PitchID': Utilities.getUuid(), 'BuyerLeadID': l['BuyerLeadID'], 'DealID': deal['DealID'], 'Username': username, 'GivenAt': now });
        alreadyPitchedForThisDeal[l['BuyerLeadID']] = true;
      });
      fed.push({ username: username, name: rep['Name'], dealAddress: deal['Address'], count: batch.length });
    });
  });

  appendRowsByHeaders(pitchesSheet, newPitchRows);

  return { ok: true, fed: fed };
}

// One-time convenience: run manually from the Apps Script editor to create
// an hourly time-driven trigger for autoFeedCheck, so auto-feed runs on its
// own instead of only when the admin clicks "Run Auto-Feed Now." Safe to
// run once; re-running adds a duplicate trigger, so check Triggers (clock
// icon) in the editor first if unsure whether it's already installed.
function installAutoFeedHourlyTrigger() {
  ScriptApp.newTrigger('autoFeedCheck').timeBased().everyHours(1).create();
}

// ---------- Rep-facing pitches ----------

function getMyPitches(body, session) {
  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const myPitches = sheetToObjects(pitchesSheet).filter(function (p) { return String(p['Username'] || '').toLowerCase() === session.u; });

  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leadsById = {};
  sheetToObjects(leadsSheet).forEach(function (l) { leadsById[l['BuyerLeadID']] = l; });
  myPitches.forEach(function (p) {
    const lead = leadsById[p['BuyerLeadID']];
    p._phoneType = lead ? lead['PhoneType'] : '';
    p._doNotContact = !!(lead && (lead['DoNotContact'] === true || lead['DoNotContact'] === 'TRUE'));
  });

  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealsById = {};
  sheetToObjects(dealsSheet).forEach(function (d) { dealsById[d['DealID']] = d; });

  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const allContacts = sheetToObjects(contactsSheet).filter(function (c) { return String(c['Username'] || '').toLowerCase() === session.u; });

  const addressGrants = loadAddressGrantsSet();
  const withStatus = pitchesWithStatus(myPitches, allContacts, dealsById);
  withStatus.forEach(function (p) {
    const lead = leadsById[p['BuyerLeadID']];
    const rawDeal = dealsById[p['DealID']];
    // Full deal context (Address if granted, Description, financials,
    // General Drive Link) so a rep can see everything about the deal a
    // buyer match is for without leaving this pitch to look it up
    // separately -- same secrecy rules as the deal detail view itself:
    // applyAddressSecrecy strips Address unless specifically granted for a
    // real rep session, but same as getDeal/getDeals, an admin session
    // (including admin previewing this screen via "Work as Rep") always
    // sees the address without needing a grant -- it's the same person who
    // could just open the deal itself and see it there anyway.
    const dealWithFields = rawDeal ? withComputedFields(rawDeal) : null;
    p.deal = dealWithFields ? (session.a ? dealWithFields : applyAddressSecrecy(dealWithFields, session, addressGrants)) : null;
    p.buyerName = lead ? lead['BuyerName'] : '(deleted buyer)';
    p.phone = lead ? lead['Phone'] : '';
    p.phoneType = lead ? lead['PhoneType'] : '';
    p.phone2 = lead ? lead['Phone2'] : '';
    p.phone2Type = lead ? lead['Phone2Type'] : '';
    p.phone3 = lead ? lead['Phone3'] : '';
    p.phone3Type = lead ? lead['Phone3Type'] : '';
    p.city = lead ? lead['City'] : '';
    p.state = lead ? lead['State'] : '';
    p.generalNotes = lead ? lead['GeneralNotes'] : '';
    p.email = lead ? lead['Email'] : '';
    p.driveLink = lead ? lead['DriveLink'] : '';
    // Shown as its own column in the rep's pitch list, not just inside
    // leadProfile, so a rep can see it for every buyer at a glance without
    // opening each one -- same as it already is for admin's table.
    p.portfolioValue = lead ? lead['PortfolioValue'] : '';
    p.doNotContact = !!(lead && (lead['DoNotContact'] === true || lead['DoNotContact'] === 'TRUE'));
    p.hasResponded = allContacts.some(function (c) { return c['PitchID'] === p['PitchID'] && (c['Responded'] === true || c['Responded'] === 'TRUE'); });
    p.callingHours = lead ? callingHoursInfo(lead['State']) : null;
    // Everything editable via updateBuyerLeadProfile, in the same shape as a
    // raw BuyerLeads row, so the frontend can reuse its shared profile-editing
    // markup for reps (one lead at a time) exactly as it does for admin.
    p.leadProfile = lead ? {
      Phone: lead['Phone'], PhoneType: lead['PhoneType'], Phone2: lead['Phone2'], Phone2Type: lead['Phone2Type'],
      Phone3: lead['Phone3'], Phone3Type: lead['Phone3Type'], Email: lead['Email'], County: lead['County'],
      DriveLink: lead['DriveLink'], LastKnownPurchasePrice: lead['LastKnownPurchasePrice'],
      EstimatedPropertyValue: lead['EstimatedPropertyValue'], PortfolioValue: lead['PortfolioValue'],
      OwnershipLengthMonths: lead['OwnershipLengthMonths'],
      // PropertyURL (the Propwire/source listing link) is admin-only, see
      // ADMIN_ONLY_PROFILE_FIELDS -- deliberately left out of what reps get.
      PriceRangeMin: lead['PriceRangeMin'], PriceRangeMax: lead['PriceRangeMax'], AssetCategories: lead['AssetCategories']
    } : null;
    delete p.dealAddress; // rep-facing -- never send the deal's Address, see file header comment
  });
  return { ok: true, pitches: withStatus };
}

function ownsPitchOrAdmin(session, pitch) {
  return session.a || String(pitch['Username'] || '').toLowerCase() === session.u;
}

function getPitchContacts(body, session) {
  if (!body.pitchId) return { ok: false, error: 'Missing pitchId.' };
  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const pitch = sheetToObjects(pitchesSheet).find(function (p) { return p['PitchID'] === body.pitchId; });
  if (!pitch) return { ok: false, error: 'Pitch not found.' };
  if (!ownsPitchOrAdmin(session, pitch)) return { ok: false, error: 'This pitch is not yours.' };
  const sheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const contacts = sheetToObjects(sheet).filter(function (c) { return c['PitchID'] === body.pitchId; });
  return { ok: true, contacts: contacts };
}

// Maps a phone slot ('Phone', 'Phone2', or 'Phone3') to its {number, type}
// on a buyer lead row. Defaults to 'Phone' when body.phoneSlot is omitted,
// so older callers/URLs that never knew about Phone2/Phone3 keep working.
function phoneForSlot(lead, slot) {
  const s = (slot === 'Phone2' || slot === 'Phone3') ? slot : 'Phone';
  return { number: lead ? lead[s] : '', type: lead ? lead[s + 'Type'] : '', slot: s };
}

function addPitchContact(body, session) {
  if (!body.pitchId || !body.method) return { ok: false, error: 'Missing pitchId or method.' };
  if (body.method !== 'Call' && body.method !== 'Text') return { ok: false, error: 'Method must be Call or Text.' };

  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  const pitch = sheetToObjects(pitchesSheet).find(function (p) { return p['PitchID'] === body.pitchId; });
  if (!pitch) return { ok: false, error: 'Pitch not found.' };
  if (!ownsPitchOrAdmin(session, pitch)) return { ok: false, error: 'This pitch is not yours.' };

  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const lead = sheetToObjects(leadsSheet).find(function (l) { return l['BuyerLeadID'] === pitch['BuyerLeadID']; });

  if (lead && (lead['DoNotContact'] === true || lead['DoNotContact'] === 'TRUE')) {
    return { ok: false, error: 'This buyer has asked not to be contacted again — no further calls or texts can be logged.' };
  }

  const phone = phoneForSlot(lead, body.phoneSlot);
  if (!phone.number) return { ok: false, error: 'That phone number isn\'t on file for this buyer.' };

  if (body.method === 'Text') {
    if (String(phone.type || '').trim().toLowerCase() === 'landline') {
      return { ok: false, error: 'This is a landline — it can only be called, not texted.' };
    }
    const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
    const priorContacts = sheetToObjects(contactsSheet).filter(function (c) { return c['PitchID'] === body.pitchId; });
    const alreadyResponded = priorContacts.some(function (c) { return c['Responded'] === true || c['Responded'] === 'TRUE'; });
    if (!alreadyResponded) {
      return { ok: false, error: 'Call first — texting isn\'t allowed until this buyer has responded to a call. High-volume texting with no reply history is what gets a number blocked from texting.' };
    }
  }

  // Calling hours (8am-7pm in the buyer's time zone) are a heads-up, not a
  // hard rule -- the pitch detail banner warns before a rep logs anything,
  // but it's never enforced here. A blanket block would also stop a rep
  // from logging a contact the BUYER initiated outside those hours (they
  // called in late, or a rep is just working a little earlier/later than
  // usual), which isn't the outbound-cold-contact behavior this was meant
  // to discourage in the first place.

  const sheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const contactId = Utilities.getUuid();
  appendRowByHeaders(sheet, {
    'ContactID': contactId, 'PitchID': body.pitchId, 'BuyerLeadID': pitch['BuyerLeadID'], 'DealID': pitch['DealID'],
    'Username': session.u, 'Method': body.method, 'PhoneSlot': phone.slot, 'ContactedAt': new Date().toISOString(),
    'Responded': !!body.responded, 'VoicemailLeft': !!body.voicemailLeft, 'ARVPercent': body.arvPercent || '', 'AsIsPercent': body.asIsPercent || '', 'Notes': body.notes || ''
  });
  return { ok: true, contactId: contactId };
}
