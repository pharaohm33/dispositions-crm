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

const REP_COLUMNS = ['Username', 'Name', 'Phone', 'Email', 'PasswordHash', 'Salt', 'AllAccess', 'IsAdmin', 'Active', 'CreatedAt', 'LastActive', 'PreferredCity', 'PreferredState', 'PreferredZip', 'PersonType', 'CategoryAccess', 'BulkAssignOverride', 'TargetMarket', 'BuyBoxNationwide', 'BuyBoxStates', 'BuyBoxCities', 'BuyBoxDealTypes', 'BuyBoxAssetCategories', 'BuyBoxOtherAssetClass', 'BuyBoxNotes'];

// A Buyer's self-reported purchase criteria, collected at signup (see
// publicSignup) -- Deal Type is a fixed strategy list (does this buyer
// flip, hold rentals, or want raw land), separate from and in addition
// to Asset Category (the same site-wide category list every deal is
// tagged with) since a buyer's strategy and their preferred property
// type are two different questions. Admin can review/edit all of this
// from a Buyer's row on the Team tab.
const BUY_BOX_DEAL_TYPES = ['Fix and Flip', 'Land', 'Buy and Hold'];

// Self-identified at signup -- informational only (admin visibility/
// filtering in the Team tab), doesn't gate any functionality. Not
// required for an admin-created rep, only for public signup.
const PERSON_TYPES = ['Buyer', 'Wholesaler', 'Realtor', 'Other'];
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
const DEAL_COLUMNS = ['DealID', 'DealCode', 'Address', 'City', 'State', 'Zip', 'County', 'MatchCities', 'AssetType', 'AssetCategory', 'Price', 'ARV', 'RehabEstimate', 'AsIsValue', 'Status', 'Description', 'GeneralDriveLink', 'SensitiveDriveLink', 'AdminPrivateNotes', 'SourceLink', 'CreatedAt', 'UpdatedAt', 'Locked', 'DealTypes'];
// Source distinguishes a deliberate, one-deal-at-a-time grant ('manual' --
// the Access section's "Add Access" dropdown, or "Assign Myself") from one
// written by the bulk-assign mechanism ('bulk' -- see applyDealAssignMode).
// Only 'manual' rows count as "already has deals" for a future "All Users
// With No Assigned Deals" bulk run -- a rep swept into an earlier bulk
// batch isn't excluded from being swept into a later one too, so the
// "generic, nobody's specifically looking out for them" pool doesn't
// shrink to nothing the first time this gets used.
const ASSIGNMENT_COLUMNS = ['DealID', 'Username', 'AssignedAt', 'Source'];
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
const BUYER_LEAD_COLUMNS = ['BuyerLeadID', 'BuyerName', 'Phone', 'PhoneType', 'Phone2', 'Phone2Type', 'Phone3', 'Phone3Type', 'Email', 'City', 'State', 'Zip', 'County', 'AssetCategories', 'LastKnownPurchasePrice', 'EstimatedPropertyValue', 'PortfolioValue', 'OwnershipLengthMonths', 'PropertyURL', 'PriceRangeMin', 'PriceRangeMax', 'GeneralNotes', 'DriveLink', 'DoNotContact', 'PendingDealID', 'CreatedAt', 'UploadedBy', 'DuplicateOfBuyerLeadID', 'DealTypes', 'IsResponsive', 'IsVip', 'HasClosedDeal'];

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
      case 'publicSignup':
        return jsonOut(publicSignup(body));
      case 'getSignupCaptcha':
        return jsonOut(getSignupCaptcha());
      case 'getSignupAssetCategoryOptions':
        return jsonOut(getAssetCategoryOptions(body));
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
      case 'requestAddressAccess':
        return jsonOut(withSession(body, requestAddressAccess));
      case 'importBuyerLeads':
        return jsonOut(withSession(body, importBuyerLeads));
      case 'getMyBuyerLeads':
        return jsonOut(withSession(body, getMyBuyerLeads));
      case 'deleteMyBuyerLeads':
        return jsonOut(withSession(body, deleteMyBuyerLeads));
      case 'giveMyBuyerLeads':
        return jsonOut(withSession(body, giveMyBuyerLeads));
      case 'giveMySelectedBuyerLeads':
        return jsonOut(withSession(body, giveMySelectedBuyerLeads));
      case 'getVisibleBuyerCities':
        return jsonOut(withSession(body, getVisibleBuyerCities));
      case 'repUpdateMyBuyBox':
        return jsonOut(withSession(body, repUpdateMyBuyBox));
      case 'updateBuyerLeadNotes':
        return jsonOut(withSession(body, updateBuyerLeadNotes));
      case 'updateBuyerLeadDoNotContact':
        return jsonOut(withSession(body, updateBuyerLeadDoNotContact));
      case 'updateBuyerLeadVipStatus':
        return jsonOut(withSession(body, updateBuyerLeadVipStatus));
      case 'updateBuyerLeadClosedStatus':
        return jsonOut(withSession(body, updateBuyerLeadClosedStatus));

      // ---- admin only ----
      case 'adminAddDeal':
        return jsonOut(withAdminSession(body, adminAddDeal));
      case 'adminUpdateDeal':
        return jsonOut(withAdminSession(body, adminUpdateDeal));
      case 'adminUpdateDealStatus':
        return jsonOut(withAdminSession(body, adminUpdateDealStatus));
      case 'adminCheckDealLive':
        return jsonOut(withAdminSession(body, adminCheckDealLive));
      case 'adminCheckAllDealsLive':
        return jsonOut(withAdminSession(body, adminCheckAllDealsLive));
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
      case 'adminBulkAssignDeal':
        return jsonOut(withAdminSession(body, adminBulkAssignDeal));
      case 'adminGiveUnassignedRepsOpenPool':
        return jsonOut(withAdminSession(body, adminGiveUnassignedRepsOpenPool));
      case 'adminSetDealLocked':
        return jsonOut(withAdminSession(body, adminSetDealLocked));
      case 'adminFindRepsByTargetMarket':
        return jsonOut(withAdminSession(body, adminFindRepsByTargetMarket));
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
      case 'adminGetBuyerLeads':
        return jsonOut(withAdminSession(body, adminGetBuyerLeads));
      case 'adminGetBuyerLeadIdsForFilters':
        return jsonOut(withAdminSession(body, adminGetBuyerLeadIdsForFilters));
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
      case 'adminGetAutoApproveSettings':
        return jsonOut(withAdminSession(body, adminGetAutoApproveSettings));
      case 'adminSetAutoApprove':
        return jsonOut(withAdminSession(body, adminSetAutoApprove));
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
    allAccess: rep['AllAccess'] === true || rep['AllAccess'] === 'TRUE',
    // Self-identified at signup (see publicSignup) -- purely for the
    // frontend to decide what to show this person (e.g. a Buyer doesn't
    // get the "build a buyer list" SOP), never a permission check.
    personType: rep['PersonType'] || '',
    // A Buyer's self-reported purchase criteria, carried in the session so
    // the Deals tab can filter to matching deals client-side without a
    // separate round trip. Blank/false for anyone who isn't a Buyer, or a
    // Buyer who hasn't set any of this.
    buyBox: {
      nationwide: rep['BuyBoxNationwide'] === true || rep['BuyBoxNationwide'] === 'TRUE',
      states: splitCommaList(rep['BuyBoxStates']),
      cities: splitCommaList(rep['BuyBoxCities']),
      dealTypes: splitCommaList(rep['BuyBoxDealTypes']),
      assetCategories: splitCommaList(rep['BuyBoxAssetCategories']),
      otherAssetClass: rep['BuyBoxOtherAssetClass'] || '',
      notes: rep['BuyBoxNotes'] || ''
    }
  };
}

// Anyone can create their own account with an email + password -- no
// invite code, no admin action needed first. Username is just the email,
// lowercased, so login() (which looks up by Username) needs no changes.
// New accounts are Active immediately (can log in right away) but start
// with no deal access at all -- AllAccess is false and there's no
// Assignments row yet, so they see an empty Deals tab until admin either
// bulk-assigns them via a new deal's "assign to all/unassigned users"
// option, or assigns them individually. Self-signup is deliberately never
// IsAdmin.
// A lightweight, homegrown slider-puzzle CAPTCHA on public signup -- not
// meant to stop a determined, targeted attacker (the target position is
// visible in the challenge response, since the frontend has to know it to
// draw the puzzle piece), just to filter out the much more common case of
// a generic bot blasting a plain POST at this endpoint with no idea it
// needs to solve anything at all. targetX is chosen server-side and
// signed (HMAC + expiry) so a request can't just invent its own
// "correct" answer -- it has to have actually called getSignupCaptcha
// first and echoed back exactly what that call returned.
const CAPTCHA_TRACK_WIDTH = 280;
const CAPTCHA_TOLERANCE = 14;
const CAPTCHA_TTL_MS = 5 * 60 * 1000;

function getSignupCaptcha() {
  const targetX = 40 + Math.floor(Math.random() * (CAPTCHA_TRACK_WIDTH - 80));
  const expiresAt = Date.now() + CAPTCHA_TTL_MS;
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  const token = hmacHex(targetX + '|' + expiresAt, secret);
  return { ok: true, targetX: targetX, expiresAt: expiresAt, token: token, trackWidth: CAPTCHA_TRACK_WIDTH, tolerance: CAPTCHA_TOLERANCE };
}

function verifySignupCaptcha(body) {
  const targetX = Number(body.captchaTargetX);
  const expiresAt = Number(body.captchaExpiresAt);
  const submittedX = Number(body.captchaSubmittedX);
  const token = body.captchaToken;
  if (!token || isNaN(targetX) || isNaN(expiresAt) || isNaN(submittedX)) return false;
  if (Date.now() > expiresAt) return false;
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  const expectedToken = hmacHex(targetX + '|' + expiresAt, secret);
  if (expectedToken !== token) return false;
  return Math.abs(submittedX - targetX) <= CAPTCHA_TOLERANCE;
}

function publicSignup(body) {
  if (!verifySignupCaptcha(body)) return { ok: false, error: "Please line up the puzzle piece to confirm you're not a bot, then try again." };
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const personType = String(body.personType || '').trim();
  if (!email || !name || !password) return { ok: false, error: 'Name, email, and password are required.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (PERSON_TYPES.indexOf(personType) === -1) return { ok: false, error: 'Select what best describes you.' };

  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet);
  const taken = reps.some(function (r) {
    return String(r['Username'] || '').trim().toLowerCase() === email || String(r['Email'] || '').trim().toLowerCase() === email;
  });
  if (taken) return { ok: false, error: 'An account with that email already exists — log in instead, or use Forgot Password to reach support.' };

  const salt = Utilities.getUuid();
  const now = new Date().toISOString();
  // A Buyer signup isn't a rep competing for exclusive deal coverage --
  // they're the actual end buyer, so they should see the whole
  // marketplace right away rather than needing to be swept into an open
  // pool or wait on a Locked deal to free up. AllAccess doesn't touch
  // address disclosure at all (that's the separate, always-hidden-by-
  // default AddressGrants gate) -- a Buyer still sees Deal Code/City/
  // State/Zip/County/price only, same as anyone else, until admin
  // discloses a specific address once that buyer's actually interested.
  const isBuyerSignup = personType === 'Buyer';
  const dealTypes = (Array.isArray(body.buyBoxDealTypes) ? body.buyBoxDealTypes : splitCommaList(body.buyBoxDealTypes))
    .filter(function (t) { return BUY_BOX_DEAL_TYPES.indexOf(t) !== -1; });
  const buyBoxCategories = Array.isArray(body.buyBoxAssetCategories) ? body.buyBoxAssetCategories : splitCommaList(body.buyBoxAssetCategories);
  appendRowByHeaders(sheet, {
    'Username': email, 'Name': name, 'Phone': String(body.phone || '').trim(), 'Email': email,
    'PasswordHash': hashPassword(password, salt), 'Salt': salt,
    'AllAccess': isBuyerSignup, 'IsAdmin': false, 'Active': true, 'CreatedAt': now, 'LastActive': '',
    'PreferredCity': '', 'PreferredState': '', 'PreferredZip': '', 'PersonType': personType,
    'BuyBoxNationwide': !!body.buyBoxNationwide,
    'BuyBoxStates': splitCommaList(body.buyBoxStates).join(', '),
    'BuyBoxCities': splitCommaList(body.buyBoxCities).join(', '),
    'BuyBoxDealTypes': dealTypes.join(', '),
    'BuyBoxAssetCategories': buyBoxCategories.join(', '),
    'BuyBoxOtherAssetClass': String(body.buyBoxOtherAssetClass || '').trim(),
    'BuyBoxNotes': String(body.buyBoxNotes || '').trim()
  });

  // Opt-in (Team tab setting) -- when on, a fresh signup is immediately
  // swept into the same "open pool" the admin's manual "Give New Reps
  // Access To The Open Pool" button runs: every active, unlocked deal,
  // same eligibility rule (only a manual grant disqualifies someone,
  // which a brand-new account can't have yet). Reuses that exact
  // function rather than a separate single-rep code path -- it's already
  // safe to call repeatedly (see its own dedup fix), and running the full
  // sweep here also mops up any other rep who was still sitting
  // unassigned for some other reason, not just this new signup.
  const autoApprove = PropertiesService.getScriptProperties().getProperty('AUTO_APPROVE_NEW_SIGNUPS') === 'TRUE';
  let openPoolResult = null;
  if (autoApprove) {
    openPoolResult = adminGiveUnassignedRepsOpenPool({});
  }

  const supportEmail = getSupportEmail();
  if (supportEmail) {
    MailApp.sendEmail({
      to: supportEmail,
      subject: 'SendMyBuyer — new account signed up (' + personType + ')',
      body: name + ' (' + email + ') just created their own account as a ' + personType + ' and is active immediately.\n\n' +
        (autoApprove
          ? 'Auto-Approve New Signups is on, so they were just automatically given access to every open (unlocked, no-manual-assignment-required) deal.\n\n'
          : 'They have no deals assigned yet — add them individually from a deal\'s Access section, use ' +
            '"Assign to all users" / "Assign to all users with no assigned deals" the next time you upload a deal, ' +
            'or run "Give New Reps Access To The Open Pool" on the Team tab.\n\n')
    });
  }

  return { ok: true };
}

// Shared "who is support" for forgot-password and address-request
// notifications -- reuses the existing "Want to Join?" contact email
// (shown on the login page, admin-configurable, not tied to a real
// login) since that's already the designated point of contact for anyone
// without full access. Falls back to ADMIN_NOTIFY_EMAIL if no join
// contact email is set.
function getSupportEmail() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('JOIN_CONTACT_EMAIL') || props.getProperty('ADMIN_NOTIFY_EMAIL') || '';
}

// ---------- Access control ----------

// A rep's CategoryAccess (comma-separated Asset Categories, see the Team
// tab's Edit Details) is a standing grant -- it covers every deal in that
// category automatically, present AND future, not just whatever existed
// when it was set. Distinct from ASSIGNMENTS_SHEET, which is a one-off
// grant to one specific deal. Both are checked wherever deal access is
// checked (canAccessDeal, accessibleDealIds, getDeals coverage counting,
// Auto-Feed eligibility) so a category-access rep behaves exactly like a
// specifically-assigned one everywhere.
function repCategoryList(rep) {
  return rep ? splitCommaList(rep['CategoryAccess']).map(normalizeText).filter(Boolean) : [];
}

function findRepByUsername(username) {
  const repsSheet = getSheet(REPS_SHEET, REP_COLUMNS);
  return sheetToObjects(repsSheet).find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === username; });
}

function canAccessDeal(session, dealId) {
  if (session.a || session.all) return true;
  const sheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const assignments = sheetToObjects(sheet);
  const directlyAssigned = assignments.some(function (row) {
    return row['DealID'] === dealId && String(row['Username'] || '').trim().toLowerCase() === session.u;
  });
  if (directlyAssigned) return true;

  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === dealId; });
  if (!deal || !deal['AssetCategory']) return false;
  const categories = repCategoryList(findRepByUsername(session.u));
  return categories.indexOf(normalizeText(deal['AssetCategory'])) !== -1;
}

function accessibleDealIds(session) {
  const sheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  const assignments = sheetToObjects(sheet);
  const ids = {};
  assignments.forEach(function (row) {
    if (String(row['Username'] || '').trim().toLowerCase() === session.u) ids[row['DealID']] = true;
  });

  const categories = repCategoryList(findRepByUsername(session.u));
  if (categories.length > 0) {
    const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
    sheetToObjects(dealsSheet).forEach(function (d) {
      if (d['AssetCategory'] && categories.indexOf(normalizeText(d['AssetCategory'])) !== -1) ids[d['DealID']] = true;
    });
  }
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
    // Admin-only: how many active team members can currently work each
    // deal -- an all-access rep counts toward every deal, everyone else
    // only counts for deals they're specifically assigned to (same math as
    // the Team tab's per-rep "# Deals", just inverted to per-deal). Lets
    // admin spot at a glance which deals are thin on coverage and could use
    // another rep pushed onto them.
    //
    // Admin rows are included here too (not excluded), same rules as any
    // other rep -- an admin's AllAccess toggle and any deal they've
    // specifically assigned themselves to (see adminAssignRep) both count.
    // This matters for record-keeping: turning AllAccess off for an admin
    // account is meant to let it show up per-deal, only where actually
    // assigned, rather than unconditionally on every deal. The requesting
    // admin's OWN coverage on each deal is broken out separately
    // (currentAdminHasAccess) so the frontend can call it out by name
    // ("Admin") instead of folding it into the generic count.
    const repsSheet = getSheet(REPS_SHEET, REP_COLUMNS);
    const activeReps = sheetToObjects(repsSheet).filter(function (r) {
      return !(r['Active'] === false || r['Active'] === 'FALSE');
    });
    const allAccessCount = activeReps.filter(function (r) { return r['AllAccess'] === true || r['AllAccess'] === 'TRUE'; }).length;
    const specificallyAssignableUsernames = {};
    const categoryListByUsername = {};
    activeReps.forEach(function (r) {
      if (!(r['AllAccess'] === true || r['AllAccess'] === 'TRUE')) {
        const u = String(r['Username'] || '').trim().toLowerCase();
        specificallyAssignableUsernames[u] = true;
        categoryListByUsername[u] = repCategoryList(r);
      }
    });

    const assignmentsSheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
    // Everyone (directly assigned OR standing category access) who counts
    // toward each deal's coverage, deduped per deal per username.
    const accessUsernamesByDeal = {};
    sheetToObjects(assignmentsSheet).forEach(function (a) {
      const u = String(a['Username'] || '').trim().toLowerCase();
      if (!specificallyAssignableUsernames[u]) return; // inactive or already counted via all-access
      if (!accessUsernamesByDeal[a['DealID']]) accessUsernamesByDeal[a['DealID']] = {};
      accessUsernamesByDeal[a['DealID']][u] = true;
    });

    const currentAdminRow = activeReps.find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === session.u; });
    const currentAdminAllAccess = !!(currentAdminRow && (currentAdminRow['AllAccess'] === true || currentAdminRow['AllAccess'] === 'TRUE'));

    deals = deals.map(function (d) {
      const copy = Object.assign({}, d);
      const dealCategory = normalizeText(d['AssetCategory']);
      const accessUsernames = Object.assign({}, accessUsernamesByDeal[d['DealID']] || {});
      if (dealCategory) {
        Object.keys(categoryListByUsername).forEach(function (u) {
          if (categoryListByUsername[u].indexOf(dealCategory) !== -1) accessUsernames[u] = true;
        });
      }
      const totalCount = allAccessCount + Object.keys(accessUsernames).length;
      const adminCoversThis = currentAdminAllAccess || !!accessUsernames[session.u];
      copy.currentAdminHasAccess = adminCoversThis;
      // "Other" reps -- excludes the requesting admin's own coverage so the
      // frontend doesn't double-count them once as "Admin" and again in
      // this number.
      copy.repsWithAccessCount = totalCount - (adminCoversThis ? 1 : 0);
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

// body.assignMode (optional): 'all' bulk-assigns every active, non-admin,
// non-all-access rep to the new deal; 'unassigned' does the same but only
// for reps who have zero Assignments rows at all right now (checked at
// this exact moment -- a rep who already has any deal, even one that's
// since sold or gone dead, doesn't qualify until they're back down to
// zero). All-access reps are skipped either way since they already see
// every deal without needing an Assignments row, and so is admin (use the
// separate Assign Myself toggle on the deal detail for that).
function adminAddDeal(body) {
  const d = body.data || {};
  if (!d.address) return { ok: false, error: 'Address is required.' };
  if (!d.price) return { ok: false, error: 'Asking Price is required.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealId = Utilities.getUuid();
  const now = new Date().toISOString();
  // Fix and Flip / Land / Buy and Hold -- the exact same three values a
  // Buyer picks as their "Strategy" at signup (BUY_BOX_DEAL_TYPES), so
  // tagging a deal with these actually closes the loop and lets
  // dealMatchesBuyBox match on it, instead of Strategy being reference-only
  // info nothing on a deal could ever be checked against.
  const dealTypes = (Array.isArray(d.dealTypes) ? d.dealTypes : splitCommaList(d.dealTypes)).filter(function (t) { return BUY_BOX_DEAL_TYPES.indexOf(t) !== -1; });
  appendRowByHeaders(sheet, {
    'DealID': dealId, 'DealCode': d.dealCode || '', 'Address': d.address, 'City': d.city || '', 'State': d.state || '', 'Zip': d.zip || '',
    'County': d.county || '', 'MatchCities': d.matchCities || '', 'AssetType': d.assetType || '', 'AssetCategory': d.assetCategory || '',
    'Price': d.price || '', 'ARV': d.arv || '', 'RehabEstimate': d.rehabEstimate || '', 'AsIsValue': d.asIsValue || '',
    'Status': d.status || DEFAULT_STATUSES[0],
    'Description': d.description || '', 'GeneralDriveLink': d.generalDriveLink || '', 'SensitiveDriveLink': d.sensitiveDriveLink || '',
    'AdminPrivateNotes': d.adminPrivateNotes || '', 'SourceLink': d.sourceLink || '',
    'CreatedAt': now, 'UpdatedAt': now, 'DealTypes': dealTypes.join(', ')
  });

  const assignedCount = applyDealAssignMode(dealId, d.assetCategory, body.assignMode, now);
  return { ok: true, dealId: dealId, assignedCount: assignedCount };
}

// Shared by adminAddDeal (a brand new deal) and adminBulkAssignDeal (an
// existing one, opened later) -- the actual "who gets swept into this
// batch" mechanics behind "Tell These Reps To Work This Deal".
//   - 'all': every active, non-admin, non-all-access rep.
//   - 'unassigned': same, but only reps with no MANUAL (Source='manual')
//     Assignments row -- a rep whose only access came from a past bulk
//     run (this same mechanism, Source='bulk') or standing category
//     access never disqualifies them from a future "unassigned" batch,
//     so that pool doesn't shrink to nothing after the first use. An
//     admin can also flag a specific rep's BulkAssignOverride (Team tab)
//     to force-include them in 'unassigned' batches even if they DO have
//     a manual assignment -- shown as an obvious "Override" badge there.
// With an AssetCategory on the deal, this grants standing access to the
// whole category (current deals AND any future one) instead of just this
// one deal -- see canAccessDeal/accessibleDealIds/getDeals/
// autoFeedCheckLocked, all of which treat that the same as a direct
// Assignments row. With no category, it's a one-off Source='bulk' grant
// for just this deal.
function applyDealAssignMode(dealId, assetCategory, assignMode, now) {
  if (assignMode !== 'all' && assignMode !== 'unassigned') return 0;
  const repsSheet = getSheet(REPS_SHEET, REP_COLUMNS);
  let eligibleReps = sheetToObjects(repsSheet).filter(function (r) {
    const active = !(r['Active'] === false || r['Active'] === 'FALSE');
    const isAdmin = r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE';
    const allAccess = r['AllAccess'] === true || r['AllAccess'] === 'TRUE';
    return active && !isAdmin && !allAccess;
  });

  const assignmentsSheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  if (assignMode === 'unassigned') {
    const manuallyAssignedUsernames = {};
    sheetToObjects(assignmentsSheet).forEach(function (a) {
      if (a['Source'] === 'manual') manuallyAssignedUsernames[String(a['Username'] || '').trim().toLowerCase()] = true;
    });
    eligibleReps = eligibleReps.filter(function (r) {
      const u = String(r['Username'] || '').trim().toLowerCase();
      const overridden = r['BulkAssignOverride'] === true || r['BulkAssignOverride'] === 'TRUE';
      return overridden || !manuallyAssignedUsernames[u];
    });
  }

  const category = normalizeText(assetCategory);
  if (category) {
    eligibleReps.forEach(function (r) {
      const existing = repCategoryList(r);
      if (existing.indexOf(category) === -1) {
        const updated = splitCommaList(r['CategoryAccess']).concat([assetCategory]).join(', ');
        repsSheet.getRange(r._row, getColumnIndex(repsSheet, 'CategoryAccess')).setValue(updated);
      }
    });
    return eligibleReps.length;
  }

  // Skip anyone already assigned to this exact deal (any Source) --
  // without this, calling applyDealAssignMode more than once on the same
  // deal (e.g. admin re-running a bulk assign, or a repeated "sweep in
  // whoever's unassigned" pass every time new reps sign up) would append
  // a duplicate Assignments row per rep per call, inflating their "#
  // deals" count and duplicating chips in the UI.
  const alreadyAssignedUsernames = {};
  sheetToObjects(assignmentsSheet).forEach(function (a) {
    if (a['DealID'] === dealId) alreadyAssignedUsernames[String(a['Username'] || '').trim().toLowerCase()] = true;
  });
  const toAssign = eligibleReps.filter(function (r) {
    return !alreadyAssignedUsernames[String(r['Username'] || '').trim().toLowerCase()];
  });
  appendRowsByHeaders(assignmentsSheet, toAssign.map(function (r) {
    return { 'DealID': dealId, 'Username': String(r['Username'] || '').trim().toLowerCase(), 'AssignedAt': now, 'Source': 'bulk' };
  }));
  return toAssign.length;
}

// Same bulk-assign, but for a deal that already exists -- admin opens it
// later and realizes it needs more coverage, instead of only being able
// to do this once, at creation time.
function adminBulkAssignDeal(body) {
  if (!body.dealId || (body.assignMode !== 'all' && body.assignMode !== 'unassigned')) {
    return { ok: false, error: 'Missing dealId or assignMode.' };
  }
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
  if (!deal) return { ok: false, error: 'Deal not found.' };
  // A locked deal is deliberately walled off from bulk sweeps -- whoever's
  // already on it keeps working it, but "All Users" / "All Users With No
  // Assigned Deals" must not pull anyone new in. Add Access (adminAssignRep)
  // is untouched by this -- that's the explicit, one-by-one override admin
  // can still use on a locked deal on purpose.
  if (deal['Locked'] === true || deal['Locked'] === 'TRUE') {
    return { ok: false, error: 'This deal is locked -- use Add Access to add someone individually, or unlock it first to bulk-assign.' };
  }
  const assignedCount = applyDealAssignMode(body.dealId, deal['AssetCategory'], body.assignMode, new Date().toISOString());
  return { ok: true, assignedCount: assignedCount };
}

// One-click version of running "All Users With No Assigned Deals Right
// Now" across every open deal at once, instead of admin having to click
// into each deal individually every time a new rep signs up with nothing
// assigned yet. "Open" here means the two things a deal can be walled off
// by: Locked (reserved for whoever it's target-market-assigned to) is
// skipped entirely, and within each deal applyDealAssignMode's own
// "unassigned" rule already excludes any rep who has a manual, one-by-one
// grant anywhere (so a rep hand-picked for one deal doesn't also get
// swept into every open deal) -- this reuses that exact same eligibility
// rule, just run over every open deal in one pass rather than one deal at
// a time.
function adminGiveUnassignedRepsOpenPool(body) {
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const openDeals = sheetToObjects(dealsSheet).filter(function (d) {
    return dealIsActive(d) && d['Locked'] !== true && d['Locked'] !== 'TRUE';
  });
  const now = new Date().toISOString();
  let totalAssignments = 0;
  let dealsTouched = 0;
  openDeals.forEach(function (d) {
    const count = applyDealAssignMode(d['DealID'], d['AssetCategory'], 'unassigned', now);
    if (count > 0) { totalAssignments += count; dealsTouched++; }
  });
  return { ok: true, dealsConsidered: openDeals.length, dealsTouched: dealsTouched, totalAssignments: totalAssignments };
}

function adminSetDealLocked(body) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
  if (!deal) return { ok: false, error: 'Deal not found.' };
  dealsSheet.getRange(deal._row, getColumnIndex(dealsSheet, 'Locked')).setValue(!!body.locked);
  return { ok: true };
}

// Suggests which reps to hand-assign a deal to based on their stated
// Target Market (see adminSetRepPreferredArea) -- purely a matching aid
// for admin, never automatic on its own. Matches the deal's State against
// each rep's TargetMarket text (comma-separated, same convention as
// PreferredState/CategoryAccess), case/whitespace-insensitive. A rep with
// no TargetMarket set never matches anything, so a deal in a market
// nobody's claimed just comes back with no suggestions -- exactly the
// "stays open to everyone, nothing gets locked" default.
function adminFindRepsByTargetMarket(body) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
  if (!deal) return { ok: false, error: 'Deal not found.' };
  const dealState = normalizeText(deal['State']);
  if (!dealState) return { ok: true, matches: [] };

  const repsSheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const matches = sheetToObjects(repsSheet).filter(function (r) {
    const active = !(r['Active'] === false || r['Active'] === 'FALSE');
    if (!active || (r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE')) return false;
    return splitCommaList(r['TargetMarket']).map(normalizeText).indexOf(dealState) !== -1;
  }).map(function (r) { return { username: r['Username'], name: r['Name'], targetMarket: r['TargetMarket'] || '' }; });

  return { ok: true, matches: matches };
}

function adminUpdateDeal(body) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deals = sheetToObjects(sheet);
  const match = deals.find(function (d) { return d['DealID'] === body.dealId; });
  if (!match) return { ok: false, error: 'Deal not found.' };
  const d = body.data || {};
  // Every deal needs an Asking Price -- only blocks an explicit attempt to
  // clear it (Price present in this save's payload but empty), not saves
  // of other fields that don't touch Price at all.
  if (d.Price !== undefined && !d.Price) return { ok: false, error: 'Asking Price is required.' };
  const editable = ['DealCode', 'Address', 'City', 'State', 'Zip', 'County', 'MatchCities', 'AssetType', 'AssetCategory', 'Price', 'ARV', 'RehabEstimate', 'AsIsValue', 'Description', 'GeneralDriveLink', 'SensitiveDriveLink', 'AdminPrivateNotes', 'SourceLink'];
  editable.forEach(function (field) {
    if (d[field] === undefined) return;
    const col = getColumnIndex(sheet, field);
    sheet.getRange(match._row, col).setValue(d[field]);
  });
  // Fix and Flip / Land / Buy and Hold tags -- same BUY_BOX_DEAL_TYPES
  // vocabulary a Buyer picks as their Strategy, so dealMatchesBuyBox can
  // actually match on it. Handled separately from the generic editable
  // loop above since this is an array (checkboxes), not a plain string.
  if (d.DealTypes !== undefined) {
    const dealTypes = (Array.isArray(d.DealTypes) ? d.DealTypes : splitCommaList(d.DealTypes)).filter(function (t) { return BUY_BOX_DEAL_TYPES.indexOf(t) !== -1; });
    sheet.getRange(match._row, getColumnIndex(sheet, 'DealTypes')).setValue(dealTypes.join(', '));
  }
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

// A dead/pulled InvestorLift listing renders a specific "property not
// found" block server-side (confirmed by fetching a known-dead listing
// with a browser User-Agent and inspecting the raw HTML -- InvestorLift's
// CDN otherwise blocks non-browser requests with a 403, so the User-Agent
// header below isn't optional). Matched on both the specific CSS class
// InvestorLift currently uses AND the visible text, so a wording tweak
// alone doesn't silently break this -- but a real markup change on
// InvestorLift's end absolutely could, and this only ever gets updated by
// hand when that happens; there's no way to detect "the check itself is
// now unreliable" automatically.
const DEAD_LISTING_MARKERS = ['dealcontent-propertyisnotfoundtitle', 'the property is not found'];
const LIVE_CHECK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Fetches one deal's Source Link and reports whether it looks pulled --
// never touches Status itself here (see adminCheckDealLive/
// adminCheckAllDealsLive, which call this and then decide what to do)
// so a fetch error can never be mistaken for "still live."
function checkSourceLinkDead(url) {
  const res = UrlFetchApp.fetch(url, { headers: { 'User-Agent': LIVE_CHECK_USER_AGENT }, muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code === 404) return { ok: true, isDead: true };
  if (code < 200 || code >= 300) return { ok: false, error: 'Source link returned HTTP ' + code + '.' };
  const html = res.getContentText().toLowerCase();
  const isDead = DEAD_LISTING_MARKERS.some(function (marker) { return html.indexOf(marker) !== -1; });
  return { ok: true, isDead: isDead };
}

// Checks one deal's Source Link and marks it Dead if the listing looks
// pulled -- never un-marks a deal that's already Sold or Dead (nothing to
// gain from re-checking a closed deal, and a Sold deal going 404 on its
// source listing is expected, not a signal to overwrite that Sold status).
function adminCheckDealLive(body) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deals = sheetToObjects(sheet);
  const match = deals.find(function (d) { return d['DealID'] === body.dealId; });
  if (!match) return { ok: false, error: 'Deal not found.' };
  if (!match['SourceLink']) return { ok: false, error: 'This deal has no Source Link set.' };

  let checkResult;
  try {
    checkResult = checkSourceLinkDead(match['SourceLink']);
  } catch (err) {
    return { ok: false, error: 'Could not check the source link: ' + String(err) };
  }
  if (!checkResult.ok) return checkResult;

  if (checkResult.isDead && match['Status'] !== 'Sold' && match['Status'] !== 'Dead') {
    sheet.getRange(match._row, getColumnIndex(sheet, 'Status')).setValue('Dead');
    sheet.getRange(match._row, getColumnIndex(sheet, 'UpdatedAt')).setValue(new Date().toISOString());
  }
  return { ok: true, isDead: checkResult.isDead, markedDead: checkResult.isDead && match['Status'] !== 'Sold' && match['Status'] !== 'Dead' };
}

// Same check across every deal that has a Source Link and isn't already
// Sold/Dead -- one at a time (Apps Script has no concurrent UrlFetch), so
// this scales to however many deals fit in a single execution's time
// budget (roughly a few hundred at typical fetch speeds) before the
// 6-minute Apps Script limit becomes a real concern; fine for the sizes
// this app deals with today, but a very large deal list would need this
// broken into batches down the line.
function adminCheckAllDealsLive(body) {
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deals = sheetToObjects(sheet).filter(function (d) {
    return d['SourceLink'] && d['Status'] !== 'Sold' && d['Status'] !== 'Dead';
  });

  let checkedCount = 0;
  let markedDeadCount = 0;
  const errors = [];
  deals.forEach(function (d) {
    checkedCount++;
    let checkResult;
    try {
      checkResult = checkSourceLinkDead(d['SourceLink']);
    } catch (err) {
      errors.push((d['DealCode'] || d['Address'] || d['DealID']) + ': ' + String(err));
      return;
    }
    if (!checkResult.ok) { errors.push((d['DealCode'] || d['Address'] || d['DealID']) + ': ' + checkResult.error); return; }
    if (checkResult.isDead) {
      sheet.getRange(d._row, getColumnIndex(sheet, 'Status')).setValue('Dead');
      sheet.getRange(d._row, getColumnIndex(sheet, 'UpdatedAt')).setValue(new Date().toISOString());
      markedDeadCount++;
    }
  });

  return { ok: true, checkedCount: checkedCount, markedDeadCount: markedDeadCount, errors: errors };
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
  const activeDeals = sheetToObjects(dealsSheet).filter(dealIsActive);
  const activeDealsCount = activeDeals.length;

  const assignmentsSheet = getSheet(ASSIGNMENTS_SHEET, ASSIGNMENT_COLUMNS);
  // Every active deal a rep is specifically told to work, direct or via
  // standing category access, deduped so a deal that's both doesn't get
  // double-counted -- this is the actual "# Deals They're Specifically
  // Told To Work On" figure, not just raw Assignments rows.
  const specificallyWorkedDealIdsByUsername = {};
  const activeDealIds = {};
  activeDeals.forEach(function (d) { activeDealIds[d['DealID']] = true; });
  sheetToObjects(assignmentsSheet).forEach(function (a) {
    if (!activeDealIds[a['DealID']]) return;
    const u = String(a['Username'] || '').trim().toLowerCase();
    if (!specificallyWorkedDealIdsByUsername[u]) specificallyWorkedDealIdsByUsername[u] = {};
    specificallyWorkedDealIdsByUsername[u][a['DealID']] = true;
  });

  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet).map(function (r) {
    const allAccess = r['AllAccess'] === true || r['AllAccess'] === 'TRUE';
    const username = String(r['Username'] || '').trim().toLowerCase();
    const categories = repCategoryList(r);
    if (categories.length > 0) {
      if (!specificallyWorkedDealIdsByUsername[username]) specificallyWorkedDealIdsByUsername[username] = {};
      activeDeals.forEach(function (d) {
        if (d['AssetCategory'] && categories.indexOf(normalizeText(d['AssetCategory'])) !== -1) {
          specificallyWorkedDealIdsByUsername[username][d['DealID']] = true;
        }
      });
    }
    const dealsAssignedCount = allAccess ? activeDealsCount :
      Object.keys(specificallyWorkedDealIdsByUsername[username] || {}).length;
    return {
      username: r['Username'], name: r['Name'], phone: r['Phone'] || '', email: r['Email'] || '',
      allAccess: allAccess,
      isAdmin: r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE',
      active: !(r['Active'] === false || r['Active'] === 'FALSE'),
      createdAt: r['CreatedAt'], lastActive: r['LastActive'] || '',
      dealsAssignedCount: dealsAssignedCount,
      preferredCity: r['PreferredCity'] || '', preferredState: r['PreferredState'] || '', preferredZip: r['PreferredZip'] || '',
      personType: r['PersonType'] || '', categoryAccess: r['CategoryAccess'] || '',
      bulkAssignOverride: r['BulkAssignOverride'] === true || r['BulkAssignOverride'] === 'TRUE',
      targetMarket: r['TargetMarket'] || '',
      buyBoxNationwide: r['BuyBoxNationwide'] === true || r['BuyBoxNationwide'] === 'TRUE',
      buyBoxStates: r['BuyBoxStates'] || '', buyBoxCities: r['BuyBoxCities'] || '',
      buyBoxDealTypes: r['BuyBoxDealTypes'] || '', buyBoxAssetCategories: r['BuyBoxAssetCategories'] || '',
      buyBoxOtherAssetClass: r['BuyBoxOtherAssetClass'] || '', buyBoxNotes: r['BuyBoxNotes'] || ''
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
  const fieldColumns = { allAccess: 'AllAccess', isAdmin: 'IsAdmin', active: 'Active', bulkOverride: 'BulkAssignOverride' };
  Object.keys(fieldColumns).forEach(function (field) {
    if (body[field] === undefined) return;
    sheet.getRange(match._row, getColumnIndex(sheet, fieldColumns[field])).setValue(!!body[field]);
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
  appendRowByHeaders(sheet, { 'DealID': body.dealId, 'Username': username, 'AssignedAt': new Date().toISOString(), 'Source': 'manual' });
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

// The in-app version of the "ask admin for the address" SOP -- a rep hits
// this from the pitch/deal screen once a matched buyer has expressed real
// interest and specifically wants the address, instead of that request
// happening off-platform with no record of it. Just sends an email (same
// support contact as publicSignup/forgot-password); the actual grant is
// still a deliberate, separate admin action via
// adminGrantAddressAccess, this only asks for it. Never includes the
// Address itself -- this rep doesn't have it yet, that's the whole point.
function requestAddressAccess(body, session) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
  if (!deal) return { ok: false, error: 'Deal not found.' };

  const supportEmail = getSupportEmail();
  if (!supportEmail) return { ok: false, error: 'No support contact is set up yet — ask admin to set the "Need Help After Signing Up?" contact email in the Team tab.' };

  MailApp.sendEmail({
    to: supportEmail,
    subject: 'SendMyBuyer — address requested for ' + (deal['DealCode'] || deal['DealID']),
    body: (session.n || session.u) + ' is requesting the full address for ' + (deal['DealCode'] || deal['DealID']) +
      ' (' + [deal['City'], deal['State']].filter(Boolean).join(', ') + ').\n\n' +
      (body.note ? 'Note from rep: ' + body.note + '\n\n' : '') +
      'Grant or deny from that deal\'s Address Access section in the admin panel.'
  });
  return { ok: true };
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
  // A "Skipped" entry (see addPitchContact) is a rep's own note, not a real
  // outreach attempt -- excluded here so it never counts toward the
  // two-touch follow-up SOP or moves a lead off "Not Contacted" by itself.
  const realContacts = (contacts || []).filter(function (c) { return c['Method'] !== 'Skipped'; });
  if (realContacts.length === 0) return 'Not Contacted';
  const responded = realContacts.some(function (c) { return c['Responded'] === true || c['Responded'] === 'TRUE'; });
  if (responded) return 'Responded';

  const sorted = realContacts.slice().sort(function (a, b) { return new Date(a['ContactedAt']) - new Date(b['ContactedAt']); });
  const hoursSinceFirst = (Date.now() - new Date(sorted[0]['ContactedAt']).getTime()) / (60 * 60 * 1000);
  const followUpSatisfied = realContacts.length >= 2;

  if (followUpSatisfied) return 'Fully Worked';
  if (hoursSinceFirst < FOLLOWUP_HOURS) return realContacts.length === 1 ? 'Awaiting Response' : 'Follow-Up In Progress';
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
  // A Dead or Sold deal is never matchable to anyone -- there's nothing
  // left to sell, so no buyer lead should ever be offered for it, whether
  // that's auto-feed (which already filters to active deals before it
  // gets here), a rep's own "Match My Buyer Leads To This Deal", or
  // admin's manual bulk-give. Checked here, not at each call site, so
  // every current and future caller of this shared predicate gets it for
  // free.
  if (!dealIsActive(deal)) return false;

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

// Any authenticated rep can import their own buyer list (not just admin) --
// when a rep does it, every new lead is tagged UploadedBy that rep's
// username and stays private to them (see buyerLeadVisibleTo /
// adminGiveBuyerLeadToRep and friends, which refuse to hand a
// rep-uploaded lead to anyone but the uploader). Admin's own imports leave
// UploadedBy blank, same as before, since those are meant to be shared
// across the whole team. UploadedBy is admin-only information -- never
// sent back to a rep session (see adminGetBuyerLeads / getMyPitches).
// Fields eligible for the admin duplicate-merge flow below -- deliberately
// excludes identity fields (BuyerName, Phone, PhoneType) since those are
// what defines the duplicate match itself, not "new data" to add.
const BUYER_LEAD_ENRICHABLE_FIELDS = ['Phone2', 'Phone2Type', 'Phone3', 'Phone3Type', 'Email', 'City', 'State', 'Zip', 'County',
  'AssetCategories', 'LastKnownPurchasePrice', 'EstimatedPropertyValue', 'PortfolioValue', 'OwnershipLengthMonths', 'PropertyURL', 'PriceRangeMin', 'PriceRangeMax'];

function buildBuyerLeadRow(r, now, uploadedBy, duplicateOfId, pendingDealId, dealTypes) {
  return {
    'BuyerLeadID': Utilities.getUuid(), 'BuyerName': r.buyerName, 'Phone': r.phone, 'PhoneType': r.phoneType || '',
    'Phone2': r.phone2 || '', 'Phone2Type': r.phone2Type || '', 'Phone3': r.phone3 || '', 'Phone3Type': r.phone3Type || '',
    'Email': r.email || '', 'City': r.city || '', 'State': r.state || '', 'Zip': r.zip || '', 'County': r.county || '',
    'AssetCategories': r.assetCategories || '', 'LastKnownPurchasePrice': r.lastKnownPurchasePrice || '',
    'EstimatedPropertyValue': r.estimatedPropertyValue || '', 'PortfolioValue': r.portfolioValue || '',
    'OwnershipLengthMonths': r.ownershipLengthMonths || '', 'PropertyURL': r.propertyUrl || '',
    'PriceRangeMin': r.priceRangeMin || '', 'PriceRangeMax': r.priceRangeMax || '',
    'GeneralNotes': '', 'DriveLink': '', 'DoNotContact': false, 'PendingDealID': pendingDealId || '', 'CreatedAt': now,
    'UploadedBy': uploadedBy, 'DuplicateOfBuyerLeadID': duplicateOfId || '', 'DealTypes': dealTypes || ''
  };
}

// Duplicates are never silently blocked anymore -- see file notes below --
// but admin and rep uploads handle a duplicate row differently:
//   - Rep: always creates their own row regardless of who else already has
//     this buyer, tagged DuplicateOfBuyerLeadID so admin can spot/hide it
//     later (see adminGetBuyerLeads's isDuplicate + the Buyer Leads table's
//     Hide Duplicates filter). Reps are never blocked by data they can't
//     even see (someone else's private list, or the shared pool).
//   - Admin: never silently overwrites an existing lead. If the new row
//     has data the existing lead doesn't already have (blank -> filled
//     in only, never a conflicting overwrite), that's held back as a
//     pendingMerge for the frontend to show admin and let them decide
//     field by field, rather than being written automatically. If there's
//     truly nothing new, it's just skipped, same as the old behavior.
//     A second call with body.confirmMerges actually applies whichever
//     ones admin approved.
function importBuyerLeads(body, session) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);

  if (body.confirmMerges) {
    if (!session.a) return { ok: false, error: 'Only admin can add data to an existing lead.' };
    const byId = {};
    sheetToObjects(sheet).forEach(function (l) { byId[l['BuyerLeadID']] = l; });
    let mergedCount = 0;
    body.confirmMerges.forEach(function (m) {
      const lead = byId[m.buyerLeadId];
      if (!lead || !m.fields) return;
      Object.keys(m.fields).forEach(function (field) {
        if (BUYER_LEAD_ENRICHABLE_FIELDS.indexOf(field) === -1) return; // guard against writing an arbitrary column
        sheet.getRange(lead._row, getColumnIndex(sheet, field)).setValue(m.fields[field] || '');
      });
      mergedCount++;
    });
    return { ok: true, mergedCount: mergedCount };
  }

  const rows = body.pasteText ? parseBuyerLeadRows(body.pasteText) : (body.rows || []);
  if (rows.length === 0) return { ok: false, error: 'No rows found to import.' };
  const uploadedBy = session.a ? '' : session.u;

  // Optional: tag this whole batch as earmarked for one or more deals (see
  // adminTagBuyerLeadsForDeal's comment on PendingDealID -- purely
  // organizational, never auto-creates a pitch). Stored comma-separated,
  // same convention as AssetCategories, since a buyer list often matches
  // several deals at once (e.g. multiple NC land deals). A rep can only
  // pick deals they can actually see; re-checked server-side rather than
  // trusting whatever the dropdown sent, since body.dealIds is client-supplied.
  const requestedDealIds = body.dealIds || (body.dealId ? [body.dealId] : []);
  const pendingDealId = requestedDealIds
    .filter(function (id) { return id && (session.a || canAccessDeal(session, id)); })
    .join(', ');

  // Same idea as pendingDealId above, but for tagging the batch with what
  // kind of deal these buyers are for (Fix and Flip/Land/Buy and Hold) --
  // no access check needed since these are just category tags, not a grant
  // to any specific deal.
  const dealTypesForBatch = (body.dealTypes || [])
    .filter(function (t) { return BUY_BOX_DEAL_TYPES.indexOf(t) !== -1; })
    .join(', ');

  const existingByPhone = {};
  const existingByEmail = {};
  sheetToObjects(sheet).forEach(function (l) {
    const p = normalizePhoneForDedup(l['Phone']);
    if (p) existingByPhone[p] = l;
    const e = normalizeText(l['Email']);
    if (e) existingByEmail[e] = l;
  });

  const now = new Date().toISOString();
  const newRows = [];
  const pendingMerges = [];
  let skippedDuplicates = 0;
  const seenPhonesThisBatch = {};
  const seenEmailsThisBatch = {};

  rows.forEach(function (r) {
    if (!r.buyerName || !r.phone) return;
    const normalizedPhone = normalizePhoneForDedup(r.phone);
    const normalizedEmail = normalizeText(r.email);

    // A second row in THIS SAME upload matching an earlier one in it --
    // always just skip the repeat, same as before.
    if ((normalizedPhone && seenPhonesThisBatch[normalizedPhone]) || (normalizedEmail && seenEmailsThisBatch[normalizedEmail])) {
      skippedDuplicates++;
      return;
    }
    if (normalizedPhone) seenPhonesThisBatch[normalizedPhone] = true;
    if (normalizedEmail) seenEmailsThisBatch[normalizedEmail] = true;

    const existingMatch = (normalizedPhone && existingByPhone[normalizedPhone]) || (normalizedEmail && existingByEmail[normalizedEmail]);
    if (!existingMatch) {
      newRows.push(buildBuyerLeadRow(r, now, uploadedBy, '', pendingDealId, dealTypesForBatch));
      return;
    }

    if (!session.a) {
      newRows.push(buildBuyerLeadRow(r, now, uploadedBy, existingMatch['BuyerLeadID'], pendingDealId, dealTypesForBatch));
      return;
    }

    const newFieldMap = {
      Phone2: r.phone2, Phone2Type: r.phone2Type, Phone3: r.phone3, Phone3Type: r.phone3Type, Email: r.email,
      City: r.city, State: r.state, Zip: r.zip, County: r.county, AssetCategories: r.assetCategories,
      LastKnownPurchasePrice: r.lastKnownPurchasePrice, EstimatedPropertyValue: r.estimatedPropertyValue, PortfolioValue: r.portfolioValue,
      OwnershipLengthMonths: r.ownershipLengthMonths, PropertyURL: r.propertyUrl, PriceRangeMin: r.priceRangeMin, PriceRangeMax: r.priceRangeMax
    };
    const fieldsToAdd = {};
    BUYER_LEAD_ENRICHABLE_FIELDS.forEach(function (f) {
      const newVal = String(newFieldMap[f] || '').trim();
      const existingVal = String(existingMatch[f] || '').trim();
      if (newVal && !existingVal) fieldsToAdd[f] = newVal;
    });
    if (Object.keys(fieldsToAdd).length > 0) {
      pendingMerges.push({
        buyerLeadId: existingMatch['BuyerLeadID'], existingName: existingMatch['BuyerName'], existingPhone: existingMatch['Phone'],
        newBuyerName: r.buyerName, fields: fieldsToAdd
      });
    } else {
      skippedDuplicates++;
    }
  });
  appendRowsByHeaders(sheet, newRows);

  // Lets the frontend offer a "just show what I uploaded" view right after
  // an import, instead of the new batch getting lost in however many leads
  // were already in the sheet.
  return {
    ok: true, imported: newRows.length, skippedDuplicates: skippedDuplicates,
    importedIds: newRows.map(function (r) { return r['BuyerLeadID']; }), importedAt: now,
    pendingMerges: pendingMerges
  };
}

// A rep's own view of the private buyer list they've uploaded (see
// importBuyerLeads) -- previously there was nowhere in the UI a rep could
// actually see this after uploading it (only admin's Buyer Leads table
// showed UploadedBy), so from the rep's side an upload just vanished with
// no way to browse, edit, or mark Do Not Contact on any of it unless/until
// it happened to get matched to a deal and turn into a pitch. Scoped to
// exactly what this rep uploaded -- not the shared pool, not another
// rep's private list. PropertyURL is admin-only, same as everywhere else
// a lead is shown to a rep.
function getMyBuyerLeads(body, session) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leads = sheetToObjects(sheet).filter(function (l) {
    return String(l['UploadedBy'] || '').trim().toLowerCase() === session.u;
  });
  const stripped = leads.map(function (l) {
    const copy = Object.assign({}, l);
    delete copy.PropertyURL;
    return copy;
  });
  return { ok: true, leads: stripped };
}

// Lets a rep permanently remove buyer leads they personally uploaded --
// never a shared/admin-uploaded lead, even by id, since that's not theirs
// to remove. Only ids that are actually both requested AND owned by this
// rep are deleted; anything else in the request is silently ignored
// rather than failing the whole batch (the frontend only ever offers a
// rep their own leads to pick from, so a mismatch here would only come
// from a stale list, not normal use). A deleted lead's Pitches and
// call-log Contacts go with it -- leaving them behind would just be
// dangling references to a buyer that no longer exists.
function deleteMyBuyerLeads(body, session) {
  if (!body.buyerLeadIds || body.buyerLeadIds.length === 0) return { ok: false, error: 'No leads selected.' };
  const wanted = {};
  body.buyerLeadIds.forEach(function (id) { wanted[id] = true; });

  return withLock(function () {
    const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    const toDelete = sheetToObjects(sheet).filter(function (l) {
      return wanted[l['BuyerLeadID']] && String(l['UploadedBy'] || '').trim().toLowerCase() === session.u;
    });
    if (toDelete.length === 0) return { ok: false, error: 'None of the selected leads belong to you -- only buyers you personally uploaded can be deleted.' };
    const deleteIds = {};
    toDelete.forEach(function (l) { deleteIds[l['BuyerLeadID']] = true; });

    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const pitchRows = sheetToObjects(pitchesSheet).filter(function (p) { return deleteIds[p['BuyerLeadID']]; }).map(function (p) { return p._row; });
    pitchRows.sort(function (a, b) { return b - a; }).forEach(function (row) { pitchesSheet.deleteRow(row); });

    const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
    const contactRows = sheetToObjects(contactsSheet).filter(function (c) { return deleteIds[c['BuyerLeadID']]; }).map(function (c) { return c._row; });
    contactRows.sort(function (a, b) { return b - a; }).forEach(function (row) { contactsSheet.deleteRow(row); });

    toDelete.sort(function (a, b) { return b._row - a._row; }).forEach(function (l) { sheet.deleteRow(l._row); });
    return { ok: true, deletedCount: toDelete.length };
  });
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

// A skip-trace/company-owned property is often held by a more active,
// sophisticated investor than an individual owner -- useful to filter on
// for dispositions outreach. Derived on the fly from BuyerName rather than
// stored as its own field, since the name itself is already the source of
// truth (an LLC name doesn't stop being an LLC name). Mirrors the
// frontend's identically-named helper -- separate runtimes, kept in sync
// by hand since there's no shared module between them.
function isCompanyBuyerName(name) {
  return /\b(llc|inc|incorporated|corp|corporation|trust|lp|llp|ltd|company|co\.?|holdings|group|partners|properties|investments|capital)\b/i.test(String(name || ''));
}

// Estimated Value folds equity in as a "(NN% equity)" suffix (see the
// frontend's mappedCsvRows) -- pulled back out here for filtering rather
// than stored as its own column, so there's one source of truth for the
// figure instead of two copies that could drift apart.
function extractEquityPercent(estimatedPropertyValue) {
  const m = /\((\d+)%\s*equity\)/i.exec(String(estimatedPropertyValue || ''));
  return m ? Number(m[1]) : null;
}

// Every filter dimension the admin Buyer Leads tab offers, applied here
// server-side instead of shipping the whole sheet to the browser and
// filtering a giant in-memory array there. Shared between adminGetBuyerLeads
// (which also paginates) and adminGetBuyerLeadIdsForFilters (ids only, for
// "Select First N (Filtered)" without needing the full rows), so both stay
// in sync on what "matches the current filters" actually means.
function applyBuyerLeadFilters(leads, f) {
  const q = normalizeText(f.q);
  const category = normalizeText(f.category);
  const state = normalizeText(f.state);
  const cities = splitCommaList(f.cities).map(normalizeText);
  const excludeCities = splitCommaList(f.excludeCities).map(normalizeText);
  const pendingDeal = f.pendingDeal || '';
  const ownerType = f.ownerType || '';
  const minEquity = (f.minEquity === undefined || f.minEquity === null || f.minEquity === '') ? null : Number(f.minEquity);
  const minHeldMonths = (f.minHeldYears === undefined || f.minHeldYears === null || f.minHeldYears === '') ? null : Number(f.minHeldYears) * 12;
  const hideDuplicates = !!f.hideDuplicates;
  const tag = f.tag || '';
  // "Show only leads from the last upload" -- the frontend tracks which
  // ids came back from its most recent import call (browser-session state,
  // never stored server-side) and passes them here as an explicit allow
  // list rather than the server trying to track "last upload" itself.
  let onlyIds = null;
  if (f.onlyIds && f.onlyIds.length > 0) {
    onlyIds = {};
    f.onlyIds.forEach(function (id) { onlyIds[id] = true; });
  }

  return leads.filter(function (l) {
    if (onlyIds && !onlyIds[l['BuyerLeadID']]) return false;
    if (hideDuplicates && l['DuplicateOfBuyerLeadID']) return false;
    if (q && ![l['BuyerName'], l['Phone'], l['Email'], l['City'], l['State'], l['Zip'], l['County']].some(function (v) { return normalizeText(v).indexOf(q) !== -1; })) return false;
    if (category && splitCommaList(l['AssetCategories']).map(normalizeText).indexOf(category) === -1) return false;
    if (state && normalizeText(l['State']) !== state) return false;
    if (cities.length > 0 && cities.indexOf(normalizeText(l['City'])) === -1) return false;
    if (excludeCities.length > 0 && excludeCities.indexOf(normalizeText(l['City'])) !== -1) return false;
    if (pendingDeal && splitCommaList(l['PendingDealID']).indexOf(pendingDeal) === -1) return false;
    if (ownerType === 'company' && !isCompanyBuyerName(l['BuyerName'])) return false;
    if (ownerType === 'individual' && isCompanyBuyerName(l['BuyerName'])) return false;
    if (minEquity !== null) {
      const equity = extractEquityPercent(l['EstimatedPropertyValue']);
      if (equity === null || equity < minEquity) return false;
    }
    if (minHeldMonths !== null) {
      const months = Number(l['OwnershipLengthMonths']);
      if (!l['OwnershipLengthMonths'] || isNaN(months) || months < minHeldMonths) return false;
    }
    if (tag === 'vip' && l['IsVip'] !== true && l['IsVip'] !== 'TRUE') return false;
    if (tag === 'closed' && l['HasClosedDeal'] !== true && l['HasClosedDeal'] !== 'TRUE') return false;
    if (tag === 'responsive' && l['IsResponsive'] !== true && l['IsResponsive'] !== 'TRUE') return false;
    return true;
  });
}

// Same "newest"/"oldest" upload-batch sort the admin Buyer Leads table
// offers -- shared so adminGetBuyerLeads and adminGetBuyerLeadIdsForFilters
// return leads/ids in the same order.
function sortBuyerLeadsList(leads, sortMode) {
  if (sortMode === 'newest') {
    leads.sort(function (a, b) { return new Date(b['CreatedAt'] || 0) - new Date(a['CreatedAt'] || 0); });
  } else if (sortMode === 'oldest') {
    leads.sort(function (a, b) { return new Date(a['CreatedAt'] || 0) - new Date(b['CreatedAt'] || 0); });
  }
  return leads;
}

// Ids only (excludes Do Not Contact, same as the old client-side "first N"
// behavior), matching whatever filters/sort the admin Buyer Leads table
// currently has set -- backs "Select First N (Filtered)" without needing
// to ship every matching lead's full row just to read off its id.
function adminGetBuyerLeadIdsForFilters(body) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  let leads = applyBuyerLeadFilters(sheetToObjects(sheet), body.filters || {});
  leads = leads.filter(function (l) { return l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE'; });
  leads = sortBuyerLeadsList(leads, body.sort);
  return { ok: true, buyerLeadIds: leads.map(function (l) { return l['BuyerLeadID']; }) };
}

// Filters, sorts, and paginates server-side -- only the requested page's
// full rows (with their openPitches join) are ever serialized and sent to
// the browser, instead of the whole sheet every time this tab loads or a
// filter changes. Also returns totalCount (for "Page X of Y (N total)")
// and pendingDealIds (every distinct tag across the FILTERED set, not
// just the current page, so the "Pending Deal Tag" dropdown reflects
// what's really out there) computed in the same pass.
function adminGetBuyerLeads(body) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  let leads = applyBuyerLeadFilters(sheetToObjects(sheet), body.filters || {});
  leads = sortBuyerLeadsList(leads, body.sort);
  const totalCount = leads.length;

  const pendingDealIdsSeen = {};
  const pendingDealIds = [];
  leads.forEach(function (l) {
    splitCommaList(l['PendingDealID']).forEach(function (id) {
      if (!pendingDealIdsSeen[id]) { pendingDealIdsSeen[id] = true; pendingDealIds.push(id); }
    });
  });

  const page = Math.max(1, Number(body.page) || 1);
  const pageSize = Math.max(1, Number(body.pageSize) || 50);
  const pageStart = (page - 1) * pageSize;
  const pageItems = leads.slice(pageStart, pageStart + pageSize);

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

  const withPitches = pageItems.map(function (l) {
    const copy = Object.assign({}, l);
    copy.openPitches = openPitchesByLead[l['BuyerLeadID']] || [];
    return copy;
  });
  return { ok: true, leads: withPitches, totalCount: totalCount, pendingDealIds: pendingDealIds };
}

// A rep can edit one buyer lead's own data if: admin, they uploaded it
// themselves (it's their own private data -- no pitch should be required
// to, say, mark a duplicate DNC or jot a note before it's ever been
// matched to a deal), or they currently have an open pitch on it (the
// existing "I'm actively working this buyer" case). Centralized so
// updateBuyerLeadNotes/DoNotContact/Profile stay in sync on what counts.
function canEditBuyerLead(session, lead) {
  if (session.a) return true;
  if (String(lead['UploadedBy'] || '').trim().toLowerCase() === session.u) return true;
  const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
  return sheetToObjects(pitchesSheet).some(function (p) {
    return p['BuyerLeadID'] === lead['BuyerLeadID'] && String(p['Username'] || '').toLowerCase() === session.u;
  });
}

function updateBuyerLeadNotes(body, session) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  if (!canEditBuyerLead(session, match)) return { ok: false, error: 'You need an active pitch on this buyer (or to have uploaded them yourself) to edit their notes.' };
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
  if (!canEditBuyerLead(session, match)) return { ok: false, error: 'You need an active pitch on this buyer (or to have uploaded them yourself) to edit their info.' };
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
  if (!canEditBuyerLead(session, match)) return { ok: false, error: 'You need an active pitch on this buyer (or to have uploaded them yourself) to change this.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'DoNotContact')).setValue(!!body.doNotContact);
  return { ok: true };
}

// Same permission as Do Not Contact -- admin, or whichever rep uploaded
// this buyer or has an active pitch on them, can flag them VIP once they
// seem like a serious buyer (responsive, or they've shared real investment
// criteria). Shown as a tag everywhere this buyer appears; see
// dealTypeTagsHtml-style badge rendering on the frontend (buyerTagsHtml).
function updateBuyerLeadVipStatus(body, session) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const match = sheetToObjects(sheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  if (!canEditBuyerLead(session, match)) return { ok: false, error: 'You need an active pitch on this buyer (or to have uploaded them yourself) to change this.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'IsVip')).setValue(!!body.isVip);
  return { ok: true };
}

// Admin-only -- marking a buyer as having actually closed a deal is a real
// business event (that's who admin needs to keep the relationship with so
// everyone on that deal gets paid), not something to leave to a rep's
// personal judgment call the way VIP is. Closing always implies VIP too --
// a closed buyer is definitionally a serious one, tagged "Top VIP Closed"
// on the frontend once both are true.
function updateBuyerLeadClosedStatus(body, session) {
  if (!session.a) return { ok: false, error: 'Only admin can mark a buyer as closed.' };
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const match = sheetToObjects(sheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  const hasClosedDeal = !!body.hasClosedDeal;
  sheet.getRange(match._row, getColumnIndex(sheet, 'HasClosedDeal')).setValue(hasClosedDeal);
  if (hasClosedDeal) sheet.getRange(match._row, getColumnIndex(sheet, 'IsVip')).setValue(true);
  return { ok: true };
}

// A buyer lead a rep uploaded themselves (see importBuyerLeads) stays
// private to them -- never given to any other rep, whether by admin's
// manual Give actions or Auto-Feed. Blank UploadedBy (admin's own imports,
// or anything uploaded before this field existed) is shared with everyone,
// same as always.
function leadVisibleToUsername(lead, username) {
  const uploadedBy = String(lead['UploadedBy'] || '').trim().toLowerCase();
  return !uploadedBy || uploadedBy === String(username || '').trim().toLowerCase();
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
    if (lead && !leadVisibleToUsername(lead, username)) {
      return { ok: false, error: 'This buyer lead was uploaded privately by another team member and can\'t be given to anyone else.' };
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
    // Checked explicitly here (not just inside buyerMatchesDeal) since the
    // city/state/zip override branch below bypasses that function entirely
    // -- a Dead or Sold deal must never get new leads either way.
    if (!dealIsActive(deal)) return { ok: false, error: 'This deal is no longer active.' };

    const hasOverride = body.city || body.state || body.zip;

    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const existingPitches = sheetToObjects(pitchesSheet);
    const alreadyPitchedByThisRepForThisDeal = {};
    existingPitches.forEach(function (p) {
      if (p['DealID'] === body.dealId && String(p['Username'] || '').toLowerCase() === username) alreadyPitchedByThisRepForThisDeal[p['BuyerLeadID']] = true;
    });

    const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    let pool = sheetToObjects(leadsSheet).filter(function (l) {
      return !alreadyPitchedByThisRepForThisDeal[l['BuyerLeadID']] && l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE' && leadVisibleToUsername(l, username);
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

// Rep-facing self-service version of adminGiveBuyerLeadsBulk -- a rep can
// give THEMSELVES a batch of buyer leads for a deal they already have
// access to, auto-matched the exact same way (same State, City equal to
// the deal's City or one of its MatchCities, AssetCategory compatible).
// Scoped to leads this rep can actually see -- their own private uploads
// plus anything shared/admin-uploaded (leadVisibleToUsername) -- so this
// can never leak someone else's private list to them. A rep can only give
// to themselves here; giving to anyone else stays admin-only
// (adminGiveBuyerLeadsBulk/adminGiveBuyerLeadToRep/adminGiveSelectedBuyerLeads).
// Distinct City/State pairs across every buyer lead this rep can actually
// see (their own uploads plus the shared pool -- same visibility rule as
// leadVisibleToUsername), for the city-override picker on "Match My Buyer
// Leads To This Deal". DNC'd buyers are excluded since there's nothing to
// cold call there anyway.
function getVisibleBuyerCities(body, session) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const seen = {};
  const cities = [];
  sheetToObjects(sheet).forEach(function (l) {
    if (l['DoNotContact'] === true || l['DoNotContact'] === 'TRUE') return;
    if (!leadVisibleToUsername(l, session.u)) return;
    const city = String(l['City'] || '').trim();
    if (!city) return;
    const state = String(l['State'] || '').trim();
    const key = normalizeText(city) + '|' + normalizeText(state);
    if (seen[key]) return;
    seen[key] = true;
    cities.push({ city: city, state: state });
  });
  cities.sort(function (a, b) { return a.state.localeCompare(b.state) || a.city.localeCompare(b.city); });
  return { ok: true, cities: cities };
}

function giveMyBuyerLeads(body, session) {
  if (!body.dealId || !body.count) return { ok: false, error: 'Missing dealId or count.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const username = session.u;

  return withLock(function () {
    const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
    const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
    if (!deal) return { ok: false, error: 'Deal not found.' };
    if (!dealIsActive(deal)) return { ok: false, error: 'This deal is no longer active.' };

    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const existingPitches = sheetToObjects(pitchesSheet);
    const alreadyPitchedByMeForThisDeal = {};
    existingPitches.forEach(function (p) {
      if (p['DealID'] === body.dealId && String(p['Username'] || '').toLowerCase() === username) alreadyPitchedByMeForThisDeal[p['BuyerLeadID']] = true;
    });

    // A rep can override the deal's own City/Match Cities/Asset Category
    // matching by hand-picking one or more (city, state) pairs from their
    // own visible buyer pool (see getVisibleBuyerCities) -- useful to
    // build a cold-call list for a deal that covers a wider area than
    // what's formally set on it. Same idea as admin's city/state/zip
    // override on the bulk-give tool, just rep-facing and multi-city.
    // Matched as city+state pairs, not city alone -- two different states
    // can share a city name (a "Springfield, IL" vs a "Springfield, OH"),
    // so a bare city-name match could silently pull leads from the wrong
    // state into someone's call list. Empty/absent cities means the
    // normal buyerMatchesDeal matching applies, same as before.
    const cityOverride = (body.cities || [])
      .filter(function (c) { return c && c.city; })
      .map(function (c) { return normalizeText(c.city) + '|' + normalizeText(c.state); });

    const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    const pool = sheetToObjects(leadsSheet).filter(function (l) {
      if (alreadyPitchedByMeForThisDeal[l['BuyerLeadID']] || l['DoNotContact'] === true || l['DoNotContact'] === 'TRUE' || !leadVisibleToUsername(l, username)) return false;
      if (cityOverride.length > 0) return cityOverride.indexOf(normalizeText(l['City']) + '|' + normalizeText(l['State'])) !== -1;
      return buyerMatchesDeal(l, deal);
    });

    const batch = pool.slice(0, Number(body.count));
    const now = new Date().toISOString();
    appendRowsByHeaders(pitchesSheet, batch.map(function (l) {
      return { 'PitchID': Utilities.getUuid(), 'BuyerLeadID': l['BuyerLeadID'], 'DealID': body.dealId, 'Username': username, 'GivenAt': now };
    }));
    return { ok: true, givenCount: batch.length, remainingInPool: pool.length - batch.length };
  });
}

// Lets a rep hand-pick specific buyers from their own list (see My Buyer
// List / getMyBuyerLeads) and attach them to any deal they can see --
// including a deal added well after those buyers were first uploaded.
// Previously the only way to connect an old buyer to a deal was the
// auto-matcher (giveMyBuyerLeads), which only runs at the moment it's
// clicked and only matches on state/city/category -- there was no way to
// go back later and deliberately point a specific buyer at a specific new
// deal. No auto-matching filter here at all, since picking exact buyers
// by hand is already the deliberate choice; still blocked on DoNotContact,
// an existing pitch for this same deal, visibility (never someone else's
// private list), and the deal being active.
function giveMySelectedBuyerLeads(body, session) {
  if (!body.dealId || !body.buyerLeadIds || body.buyerLeadIds.length === 0) {
    return { ok: false, error: 'Missing dealId or buyerLeadIds.' };
  }
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const username = session.u;

  return withLock(function () {
    const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
    const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
    if (!deal) return { ok: false, error: 'Deal not found.' };
    if (!dealIsActive(deal)) return { ok: false, error: 'This deal is no longer active.' };

    const wanted = {};
    body.buyerLeadIds.forEach(function (id) { wanted[id] = true; });

    const pitchesSheet = getSheet(PITCHES_SHEET, PITCH_COLUMNS);
    const alreadyPitchedByMeForThisDeal = {};
    sheetToObjects(pitchesSheet).forEach(function (p) {
      if (p['DealID'] === body.dealId && String(p['Username'] || '').toLowerCase() === username) alreadyPitchedByMeForThisDeal[p['BuyerLeadID']] = true;
    });

    const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
    const candidates = sheetToObjects(leadsSheet).filter(function (l) {
      return wanted[l['BuyerLeadID']] && !alreadyPitchedByMeForThisDeal[l['BuyerLeadID']] &&
        l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE' && leadVisibleToUsername(l, username);
    });

    const now = new Date().toISOString();
    appendRowsByHeaders(pitchesSheet, candidates.map(function (l) {
      return { 'PitchID': Utilities.getUuid(), 'BuyerLeadID': l['BuyerLeadID'], 'DealID': body.dealId, 'Username': username, 'GivenAt': now };
    }));
    return { ok: true, givenCount: candidates.length, skipped: body.buyerLeadIds.length - candidates.length };
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
        l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE' && leadVisibleToUsername(l, username);
    });

    const now = new Date().toISOString();
    appendRowsByHeaders(pitchesSheet, candidates.map(function (l) {
      return { 'PitchID': Utilities.getUuid(), 'BuyerLeadID': l['BuyerLeadID'], 'DealID': body.dealId, 'Username': username, 'GivenAt': now };
    }));

    // A lead tagged "pending" for this deal just became a real pitch for
    // it, so drop just this deal out of its (possibly multi-deal, see
    // importBuyerLeads) pending list -- one batched read+write, not a
    // per-row call. Leaves alone any *other* deal still on the list, in
    // case it's deliberately being tracked for more than one.
    const toUpdate = {};
    candidates.forEach(function (l) {
      const remaining = splitCommaList(l['PendingDealID']).filter(function (id) { return id !== body.dealId; });
      if (remaining.length !== splitCommaList(l['PendingDealID']).length) toUpdate[l['BuyerLeadID']] = remaining.join(', ');
    });
    if (Object.keys(toUpdate).length > 0) {
      const values = leadsSheet.getDataRange().getValues();
      const headers = values[0];
      const idCol = headers.indexOf('BuyerLeadID');
      const pendingCol = headers.indexOf('PendingDealID');
      for (let i = 1; i < values.length; i++) {
        if (toUpdate.hasOwnProperty(values[i][idCol])) values[i][pendingCol] = toUpdate[values[i][idCol]];
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
  if (body.targetMarket !== undefined) {
    // Purely informational/matching metadata -- distinct from
    // PreferredCity/State/Zip (which is about where a rep wants BUYER
    // LEADS from). Target Market is which state(s) a rep focuses on for
    // DEALS, used by adminFindRepsByTargetMarket to suggest who to
    // hand-assign+lock a deal to; setting it never grants or restricts
    // deal access on its own.
    sheet.getRange(match._row, getColumnIndex(sheet, 'TargetMarket')).setValue(body.targetMarket || '');
  }
  if (body.personType !== undefined) {
    // Blank is allowed here (admin clearing/not setting it for an
    // internally-added rep) even though public signup itself requires a
    // real PERSON_TYPES value -- this is just correcting/backfilling it.
    if (body.personType && PERSON_TYPES.indexOf(body.personType) === -1) return { ok: false, error: 'Invalid type.' };
    sheet.getRange(match._row, getColumnIndex(sheet, 'PersonType')).setValue(body.personType || '');
  }
  if (body.categoryAccess !== undefined) {
    // Standing access to every deal in these categories, present and
    // future -- see canAccessDeal/accessibleDealIds/getDeals/
    // autoFeedCheckLocked, all of which check this the same way they
    // check a specific-deal Assignments row. body.categoryAccess is an
    // array of category names from the checkbox list; stored the same
    // comma-separated way PreferredState already is.
    const categories = Array.isArray(body.categoryAccess) ? body.categoryAccess : splitCommaList(body.categoryAccess);
    sheet.getRange(match._row, getColumnIndex(sheet, 'CategoryAccess')).setValue(categories.join(', '));
  }
  // A Buyer's purchase criteria, editable by admin the same way it's set
  // at signup -- e.g. a buyer calls in and asks to widen their area, or
  // admin wants to correct something. Only touched when the caller
  // explicitly sends buyBox, so this same function still works for
  // saving just the fields above without wiping buy box data.
  if (body.buyBox !== undefined) applyBuyBoxUpdate(sheet, match._row, body.buyBox);
  return { ok: true };
}

// Shared by adminSetRepPreferredArea (admin editing on someone's behalf)
// and repUpdateMyBuyBox (a Buyer editing their own) -- same fields, same
// normalization, one place to keep them in sync.
function applyBuyBoxUpdate(sheet, row, buyBoxBody) {
  const bb = buyBoxBody || {};
  sheet.getRange(row, getColumnIndex(sheet, 'BuyBoxNationwide')).setValue(!!bb.nationwide);
  sheet.getRange(row, getColumnIndex(sheet, 'BuyBoxStates')).setValue(splitCommaList(bb.states).join(', '));
  sheet.getRange(row, getColumnIndex(sheet, 'BuyBoxCities')).setValue(splitCommaList(bb.cities).join(', '));
  const dealTypes = (Array.isArray(bb.dealTypes) ? bb.dealTypes : splitCommaList(bb.dealTypes)).filter(function (t) { return BUY_BOX_DEAL_TYPES.indexOf(t) !== -1; });
  sheet.getRange(row, getColumnIndex(sheet, 'BuyBoxDealTypes')).setValue(dealTypes.join(', '));
  const assetCategories = Array.isArray(bb.assetCategories) ? bb.assetCategories : splitCommaList(bb.assetCategories);
  sheet.getRange(row, getColumnIndex(sheet, 'BuyBoxAssetCategories')).setValue(assetCategories.join(', '));
  sheet.getRange(row, getColumnIndex(sheet, 'BuyBoxOtherAssetClass')).setValue(String(bb.otherAssetClass || '').trim());
  sheet.getRange(row, getColumnIndex(sheet, 'BuyBoxNotes')).setValue(String(bb.notes || '').trim());
}

// Lets a Buyer update their own purchase criteria any time, not just at
// signup -- their Deals tab re-filters against it immediately (the
// updated buyBox comes back in the response so the frontend can refresh
// its session copy without a full re-login).
function repUpdateMyBuyBox(body, session) {
  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const match = sheetToObjects(sheet).find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === session.u; });
  if (!match) return { ok: false, error: 'Account not found.' };
  applyBuyBoxUpdate(sheet, match._row, body.buyBox);
  const updated = sheetToObjects(sheet).find(function (r) { return r._row === match._row; });
  return {
    ok: true,
    buyBox: {
      nationwide: updated['BuyBoxNationwide'] === true || updated['BuyBoxNationwide'] === 'TRUE',
      states: splitCommaList(updated['BuyBoxStates']),
      cities: splitCommaList(updated['BuyBoxCities']),
      dealTypes: splitCommaList(updated['BuyBoxDealTypes']),
      assetCategories: splitCommaList(updated['BuyBoxAssetCategories']),
      otherAssetClass: updated['BuyBoxOtherAssetClass'] || '',
      notes: updated['BuyBoxNotes'] || ''
    }
  };
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

// When on, publicSignup automatically sweeps every fresh signup (and any
// other still-unassigned rep) into the open pool the moment they create
// their account -- see the Auto-Approve block inside publicSignup. Off by
// default, same convention as Auto-Feed.
function adminGetAutoApproveSettings(body) {
  const props = PropertiesService.getScriptProperties();
  return { ok: true, enabled: props.getProperty('AUTO_APPROVE_NEW_SIGNUPS') === 'TRUE' };
}

function adminSetAutoApprove(body) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('AUTO_APPROVE_NEW_SIGNUPS', body.enabled ? 'TRUE' : 'FALSE');
  return { ok: true };
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
    const dealCategory = normalizeText(deal['AssetCategory']);
    const eligibleReps = reps.filter(function (rep) {
      const hasAccess = rep['AllAccess'] === true || rep['AllAccess'] === 'TRUE' ||
        (assignedUsernamesByDeal[deal['DealID']] || []).indexOf(rep['Username']) !== -1 ||
        (dealCategory && repCategoryList(rep).indexOf(dealCategory) !== -1);
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
        return !alreadyPitchedForThisDeal[l['BuyerLeadID']] && l['DoNotContact'] !== true && l['DoNotContact'] !== 'TRUE' &&
          leadVisibleToUsername(l, username) && buyerMatchesDeal(l, deal);
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
    // Buyer-level status tags -- visible to every rep (unlike UploadedBy,
    // which is deliberately never copied onto this whitelist at all, see
    // file header comment on rep-facing secrecy).
    p.isResponsive = !!(lead && (lead['IsResponsive'] === true || lead['IsResponsive'] === 'TRUE'));
    p.isVip = !!(lead && (lead['IsVip'] === true || lead['IsVip'] === 'TRUE'));
    p.hasClosedDeal = !!(lead && (lead['HasClosedDeal'] === true || lead['HasClosedDeal'] === 'TRUE'));
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
  // "Skipped" is a rep's own quick "moving on for now" note -- mainly meant
  // for landline-only buyers with no mobile to text, but left flexible for
  // whatever a rep finds it useful for. Logged the same way as a Call/Text
  // so it's on record, but computeLeadStatus filters Method === 'Skipped'
  // out of its follow-up math entirely, so it never counts as a real touch.
  if (['Call', 'Text', 'Skipped'].indexOf(body.method) === -1) return { ok: false, error: 'Method must be Call, Text, or Skipped.' };

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
    'Responded': body.method === 'Skipped' ? false : !!body.responded,
    'VoicemailLeft': body.method === 'Skipped' ? false : !!body.voicemailLeft,
    'ARVPercent': body.arvPercent || '', 'AsIsPercent': body.asIsPercent || '', 'Notes': body.notes || ''
  });
  // A real response to any outreach -- from any rep, on any deal -- earns
  // this buyer the "Responsive" tag for good (see BUYER_LEAD_COLUMNS'
  // IsResponsive); never auto-cleared, since a later non-response on a
  // different pitch doesn't make them less worth prioritizing.
  if (body.method !== 'Skipped' && body.responded && lead) {
    leadsSheet.getRange(lead._row, getColumnIndex(leadsSheet, 'IsResponsive')).setValue(true);
  }
  return { ok: true, contactId: contactId };
}
