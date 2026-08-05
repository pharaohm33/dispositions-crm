/**
 * Dispositions CRM — Apps Script backend.
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
 * Address secrecy model: a deal's exact street Address is never sent to a
 * non-admin session until that specific rep has at least one Approved
 * interested buyer logged against that deal (see repApprovedBuyerNames).
 * Until then getDeals/getDeal strip the Address field entirely rather than
 * relying on the front-end to hide it, since the value would otherwise sit
 * in the browser's network tab regardless of what's rendered.
 */

const REPS_SHEET = 'Reps';
const DEALS_SHEET = 'Deals';
const ASSIGNMENTS_SHEET = 'Assignments';
const BUYERS_SHEET = 'InterestedBuyers';
const FB_SHEET = 'FBPostRequests';
const STATUS_SHEET = 'StatusOptions';
const BUYER_LEADS_SHEET = 'BuyerLeads';
const BUYER_LEAD_CONTACTS_SHEET = 'BuyerLeadContacts';
const SESSION_HOURS = 12;
const DEFAULT_STATUSES = ['Active', 'Under Contract', 'Sold', 'Dead', 'On Hold'];
const FOLLOWUP_HOURS = 24;

const REP_COLUMNS = ['Username', 'Name', 'PasswordHash', 'Salt', 'AllAccess', 'IsAdmin', 'Active', 'CreatedAt', 'PreferredCity', 'PreferredState', 'PreferredZip'];
const DEAL_COLUMNS = ['DealID', 'Address', 'City', 'State', 'Zip', 'AssetType', 'Price', 'Status', 'Description', 'CreatedAt', 'UpdatedAt'];
const ASSIGNMENT_COLUMNS = ['DealID', 'Username', 'AssignedAt'];
const BUYER_COLUMNS = ['BuyerID', 'DealID', 'Username', 'BuyerName', 'BuyerContact', 'Notes', 'Status', 'AdminNote', 'CreatedAt', 'DecidedAt'];
const FB_COLUMNS = ['RequestID', 'DealID', 'Username', 'PostText', 'TargetGroups', 'Status', 'AdminNote', 'CreatedAt', 'DecidedAt'];

// One row per buyer/LLC on the master calling list. AssignedTo is blank
// until an admin (or auto-feed) hands it to a specific rep -- there's no
// concept of shared/pooled leads, by design, so two reps never call the
// same buyer unless an admin deliberately reassigns it.
const BUYER_LEAD_COLUMNS = ['BuyerLeadID', 'BuyerName', 'Phone', 'PhoneType', 'City', 'State', 'Zip', 'AssignedTo', 'AssignedAt', 'CreatedAt'];

// One row per contact attempt against a BuyerLeadID -- this is both the
// call/text touchpoint log that drives computeLeadStatus's 24/48-hour SOP,
// and the running feedback history ("buyer said X about deal Y") that's the
// whole point of building a most-active-buyers picture over time.
const BUYER_LEAD_CONTACT_COLUMNS = ['ContactID', 'BuyerLeadID', 'Username', 'Method', 'ContactedAt', 'Responded', 'DealID', 'Notes'];

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'ping') {
    return jsonOut({ ok: true, message: 'Dispositions CRM backend is alive.' });
  }
  return jsonOut({ ok: false, error: 'Use POST for this API.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'Bad request body.' });
  }

  const action = body.action;
  try {
    switch (action) {
      case 'login':
        return jsonOut(login(body));

      // ---- authenticated, any rep ----
      case 'getDeals':
        return jsonOut(withSession(body, getDeals));
      case 'getDeal':
        return jsonOut(withSession(body, getDeal));
      case 'getStatusOptions':
        return jsonOut(withSession(body, getStatusOptions));
      case 'addInterestedBuyer':
        return jsonOut(withSession(body, addInterestedBuyer));
      case 'getInterestedBuyers':
        return jsonOut(withSession(body, getInterestedBuyers));
      case 'submitFbPostRequest':
        return jsonOut(withSession(body, submitFbPostRequest));
      case 'getMyFbRequests':
        return jsonOut(withSession(body, getMyFbRequests));
      case 'getMyBuyerLeads':
        return jsonOut(withSession(body, getMyBuyerLeads));
      case 'getBuyerLeadContacts':
        return jsonOut(withSession(body, getBuyerLeadContacts));
      case 'addBuyerLeadContact':
        return jsonOut(withSession(body, addBuyerLeadContact));

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
      case 'adminGetFbRequests':
        return jsonOut(withAdminSession(body, adminGetFbRequests));
      case 'adminDecideFbRequest':
        return jsonOut(withAdminSession(body, adminDecideFbRequest));
      case 'adminGetBuyerRequests':
        return jsonOut(withAdminSession(body, adminGetBuyerRequests));
      case 'adminDecideBuyer':
        return jsonOut(withAdminSession(body, adminDecideBuyer));
      case 'adminImportBuyerLeads':
        return jsonOut(withAdminSession(body, adminImportBuyerLeads));
      case 'adminGetBuyerLeads':
        return jsonOut(withAdminSession(body, adminGetBuyerLeads));
      case 'adminAssignBuyerLead':
        return jsonOut(withAdminSession(body, adminAssignBuyerLead));
      case 'adminUnassignBuyerLead':
        return jsonOut(withAdminSession(body, adminUnassignBuyerLead));
      case 'adminAssignBuyerLeadsBulk':
        return jsonOut(withAdminSession(body, adminAssignBuyerLeadsBulk));
      case 'adminGetBuyerLeadContacts':
        return jsonOut(withAdminSession(body, adminGetBuyerLeadContacts));
      case 'adminSetRepPreferredArea':
        return jsonOut(withAdminSession(body, adminSetRepPreferredArea));
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
  if (!session.a) deals = deals.map(function (d) { return applyAddressSecrecy(d, session); });
  return { ok: true, deals: deals };
}

function getDeal(body, session) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deal = sheetToObjects(sheet).find(function (d) { return d['DealID'] === body.dealId; });
  if (!deal) return { ok: false, error: 'Deal not found.' };
  return { ok: true, deal: session.a ? deal : applyAddressSecrecy(deal, session) };
}

// Strips the exact street Address from a deal object for a non-admin
// session unless that specific rep has at least one Approved buyer logged
// against it -- see the file header comment for why this happens here
// rather than just being hidden client-side.
function applyAddressSecrecy(deal, session) {
  const approvedNames = repApprovedBuyerNames(session.u, deal['DealID']);
  const copy = Object.assign({}, deal);
  if (approvedNames.length > 0) {
    copy.AddressLocked = false;
    copy.ApprovedBuyerNames = approvedNames;
  } else {
    copy.AddressLocked = true;
    copy.Address = '';
  }
  return copy;
}

function repApprovedBuyerNames(username, dealId) {
  const sheet = getSheet(BUYERS_SHEET, BUYER_COLUMNS);
  return sheetToObjects(sheet)
    .filter(function (r) {
      return r['DealID'] === dealId &&
        String(r['Username'] || '').trim().toLowerCase() === username &&
        r['Status'] === 'Approved';
    })
    .map(function (r) { return r['BuyerName']; });
}

function adminAddDeal(body) {
  const d = body.data || {};
  if (!d.address) return { ok: false, error: 'Address is required.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const dealId = Utilities.getUuid();
  const now = new Date().toISOString();
  appendRowByHeaders(sheet, {
    'DealID': dealId, 'Address': d.address, 'City': d.city || '', 'State': d.state || '', 'Zip': d.zip || '',
    'AssetType': d.assetType || '', 'Price': d.price || '', 'Status': d.status || DEFAULT_STATUSES[0],
    'Description': d.description || '', 'CreatedAt': now, 'UpdatedAt': now
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
  const editable = ['Address', 'City', 'State', 'Zip', 'AssetType', 'Price', 'Description'];
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

function adminGetReps(body) {
  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet).map(function (r) {
    return {
      username: r['Username'], name: r['Name'],
      allAccess: r['AllAccess'] === true || r['AllAccess'] === 'TRUE',
      isAdmin: r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE',
      active: !(r['Active'] === false || r['Active'] === 'FALSE'),
      createdAt: r['CreatedAt'],
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
    'Username': username, 'Name': d.name, 'PasswordHash': hashPassword(d.password, salt), 'Salt': salt,
    'AllAccess': !!d.allAccess, 'IsAdmin': !!d.isAdmin, 'Active': true, 'CreatedAt': new Date().toISOString()
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

// ---------- Interested buyers ----------

function addInterestedBuyer(body, session) {
  if (!body.dealId || !body.buyerName) return { ok: false, error: 'Missing dealId or buyerName.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(BUYERS_SHEET, BUYER_COLUMNS);
  const buyerId = Utilities.getUuid();
  appendRowByHeaders(sheet, {
    'BuyerID': buyerId, 'DealID': body.dealId, 'Username': session.u,
    'BuyerName': body.buyerName, 'BuyerContact': body.buyerContact || '', 'Notes': body.notes || '',
    'Status': 'Pending', 'AdminNote': '', 'CreatedAt': new Date().toISOString(), 'DecidedAt': ''
  });

  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_NOTIFY_EMAIL');
  if (adminEmail) {
    const dealsSheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
    const deal = sheetToObjects(dealsSheet).find(function (d) { return d['DealID'] === body.dealId; });
    const address = deal ? deal['Address'] : body.dealId;
    MailApp.sendEmail({
      to: adminEmail,
      subject: 'Dispositions CRM — new interested buyer pending approval',
      body: session.n + ' (' + session.u + ') logged an interested buyer on:\n\n' + address +
        '\n\nBuyer name: ' + body.buyerName +
        (body.buyerContact ? '\nBuyer contact: ' + body.buyerContact : '') +
        (body.notes ? '\nNotes: ' + body.notes : '') +
        '\n\nApprove this buyer in the admin panel before the rep can see the property address.'
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
      subject: 'Dispositions CRM — new Facebook post pending approval',
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

// ---------- Admin: interested-buyer approvals ----------
// Approving a buyer here is the only thing that unlocks that specific rep's
// view of the deal's exact Address (see applyAddressSecrecy) -- rejecting
// just leaves it hidden and records why, via AdminNote.

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
  });
  return { ok: true, requests: rows };
}

function adminDecideBuyer(body) {
  if (!body.buyerId || !body.decision) return { ok: false, error: 'Missing buyerId or decision.' };
  if (body.decision !== 'Approved' && body.decision !== 'Rejected') return { ok: false, error: 'Invalid decision.' };
  const sheet = getSheet(BUYERS_SHEET, BUYER_COLUMNS);
  const rows = sheetToObjects(sheet);
  const match = rows.find(function (r) { return r['BuyerID'] === body.buyerId; });
  if (!match) return { ok: false, error: 'Buyer not found.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'Status')).setValue(body.decision);
  sheet.getRange(match._row, getColumnIndex(sheet, 'AdminNote')).setValue(body.note || '');
  sheet.getRange(match._row, getColumnIndex(sheet, 'DecidedAt')).setValue(new Date().toISOString());
  return { ok: true };
}

// ---------- Buyer leads (master calling list) ----------
//
// Status SOP, derived fresh on every read rather than stored, so it can
// never drift from the actual contact log:
//   Not Contacted        - nothing logged yet
//   Awaiting Response     - one contact logged, under 24 hours ago
//   Follow-Up In Progress - past 24h, but the required second-touch method(s)
//                           for this phone type aren't all logged yet
//   Follow-Up Due         - past 24h and no follow-up attempted at all
//   Responded             - any contact was marked as getting a response
//   Fully Worked          - the phone-type-appropriate two-touch SOP is
//                           complete (two calls for a landline; a call AND
//                           a text for a mobile) with no response -- this
//                           lead no longer blocks that rep from auto-feed
//
// Landlines can only ever be called (never texted), so their SOP is two
// calls; mobiles can be called or texted, and the required follow-up
// specifically pairs a call with a text (per the dispositions SOP: if no
// response in 24h, call again and follow up with a text).
function computeLeadStatus(phoneType, contacts) {
  if (!contacts || contacts.length === 0) return 'Not Contacted';
  const responded = contacts.some(function (c) { return c['Responded'] === true || c['Responded'] === 'TRUE'; });
  if (responded) return 'Responded';

  const sorted = contacts.slice().sort(function (a, b) { return new Date(a['ContactedAt']) - new Date(b['ContactedAt']); });
  const hoursSinceFirst = (Date.now() - new Date(sorted[0]['ContactedAt']).getTime()) / (60 * 60 * 1000);
  const methodsUsed = {};
  contacts.forEach(function (c) { methodsUsed[c['Method']] = true; });
  const isLandline = String(phoneType || '').trim().toLowerCase() === 'landline';
  const followUpSatisfied = isLandline ? contacts.length >= 2 : (methodsUsed['Call'] && methodsUsed['Text']);

  if (followUpSatisfied) return 'Fully Worked';
  if (hoursSinceFirst < FOLLOWUP_HOURS) return contacts.length === 1 ? 'Awaiting Response' : 'Follow-Up In Progress';
  return 'Follow-Up Due';
}

function leadNeedsAction(status) {
  return status === 'Not Contacted' || status === 'Awaiting Response' || status === 'Follow-Up Due' || status === 'Follow-Up In Progress';
}

// Parses pasted CSV/TSV/spreadsheet text: BuyerName, Phone, PhoneType,
// City, State, Zip -- comma or tab separated, one buyer per line. Skips a
// header row if the first cell of the first line isn't a phone-looking
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
      city: cells[3] || '', state: cells[4] || '', zip: cells[5] || ''
    });
  }
  return rows;
}

function adminImportBuyerLeads(body) {
  const rows = body.pasteText ? parseBuyerLeadRows(body.pasteText) : (body.rows || []);
  if (rows.length === 0) return { ok: false, error: 'No rows found to import.' };

  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const existing = sheetToObjects(sheet);
  const existingPhones = {};
  existing.forEach(function (l) { existingPhones[String(l['Phone'] || '').replace(/\D/g, '')] = true; });

  let imported = 0;
  let skippedDuplicates = 0;
  const now = new Date().toISOString();
  rows.forEach(function (r) {
    if (!r.buyerName || !r.phone) return;
    const normalizedPhone = String(r.phone).replace(/\D/g, '');
    if (existingPhones[normalizedPhone]) { skippedDuplicates++; return; }
    existingPhones[normalizedPhone] = true;
    appendRowByHeaders(sheet, {
      'BuyerLeadID': Utilities.getUuid(), 'BuyerName': r.buyerName, 'Phone': r.phone, 'PhoneType': r.phoneType || '',
      'City': r.city || '', 'State': r.state || '', 'Zip': r.zip || '', 'AssignedTo': '', 'AssignedAt': '', 'CreatedAt': now
    });
    imported++;
  });

  return { ok: true, imported: imported, skippedDuplicates: skippedDuplicates };
}

function buyerLeadsWithStatus(leadRows, allContacts) {
  const contactsByLead = {};
  allContacts.forEach(function (c) {
    if (!contactsByLead[c['BuyerLeadID']]) contactsByLead[c['BuyerLeadID']] = [];
    contactsByLead[c['BuyerLeadID']].push(c);
  });
  return leadRows.map(function (l) {
    const contacts = contactsByLead[l['BuyerLeadID']] || [];
    const copy = Object.assign({}, l);
    copy.status = computeLeadStatus(l['PhoneType'], contacts);
    copy.contactCount = contacts.length;
    return copy;
  });
}

function adminGetBuyerLeads(body) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  let leads = sheetToObjects(sheet);
  const f = body.filters || {};
  if (f.assignedTo) leads = leads.filter(function (l) { return String(l['AssignedTo'] || '').toLowerCase() === String(f.assignedTo).toLowerCase(); });
  if (f.unassignedOnly) leads = leads.filter(function (l) { return !l['AssignedTo']; });
  if (f.city) leads = leads.filter(function (l) { return String(l['City'] || '').toLowerCase() === String(f.city).toLowerCase(); });
  if (f.state) leads = leads.filter(function (l) { return String(l['State'] || '').toLowerCase() === String(f.state).toLowerCase(); });
  if (f.zip) leads = leads.filter(function (l) { return String(l['Zip'] || '') === String(f.zip); });

  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const allContacts = sheetToObjects(contactsSheet);
  return { ok: true, leads: buyerLeadsWithStatus(leads, allContacts) };
}

function adminAssignBuyerLead(body) {
  if (!body.buyerLeadId || !body.username) return { ok: false, error: 'Missing buyerLeadId or username.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'AssignedTo')).setValue(String(body.username).trim().toLowerCase());
  sheet.getRange(match._row, getColumnIndex(sheet, 'AssignedAt')).setValue(new Date().toISOString());
  return { ok: true };
}

function adminUnassignBuyerLead(body) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'AssignedTo')).setValue('');
  sheet.getRange(match._row, getColumnIndex(sheet, 'AssignedAt')).setValue('');
  return { ok: true };
}

// Hands the next N unassigned leads (optionally filtered by area) to one
// rep in one shot -- e.g. "give Jordan the next 50 unassigned leads in
// Phoenix, AZ." Oldest-imported leads go out first.
function adminAssignBuyerLeadsBulk(body) {
  if (!body.username || !body.count) return { ok: false, error: 'Missing username or count.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  let pool = sheetToObjects(sheet).filter(function (l) { return !l['AssignedTo']; });
  if (body.city) pool = pool.filter(function (l) { return String(l['City'] || '').toLowerCase() === String(body.city).toLowerCase(); });
  if (body.state) pool = pool.filter(function (l) { return String(l['State'] || '').toLowerCase() === String(body.state).toLowerCase(); });
  if (body.zip) pool = pool.filter(function (l) { return String(l['Zip'] || '') === String(body.zip); });

  const batch = pool.slice(0, Number(body.count));
  const now = new Date().toISOString();
  batch.forEach(function (l) {
    sheet.getRange(l._row, getColumnIndex(sheet, 'AssignedTo')).setValue(username);
    sheet.getRange(l._row, getColumnIndex(sheet, 'AssignedAt')).setValue(now);
  });
  return { ok: true, assignedCount: batch.length, remainingInPool: pool.length - batch.length };
}

function adminGetBuyerLeadContacts(body) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const sheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const contacts = sheetToObjects(sheet).filter(function (c) { return c['BuyerLeadID'] === body.buyerLeadId; });
  return { ok: true, contacts: contacts };
}

function adminSetRepPreferredArea(body) {
  if (!body.username) return { ok: false, error: 'Missing username.' };
  const username = String(body.username).trim().toLowerCase();
  const sheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(sheet);
  const match = reps.find(function (r) { return String(r['Username'] || '').trim().toLowerCase() === username; });
  if (!match) return { ok: false, error: 'Rep not found.' };
  sheet.getRange(match._row, getColumnIndex(sheet, 'PreferredCity')).setValue(body.city || '');
  sheet.getRange(match._row, getColumnIndex(sheet, 'PreferredState')).setValue(body.state || '');
  sheet.getRange(match._row, getColumnIndex(sheet, 'PreferredZip')).setValue(body.zip || '');
  return { ok: true };
}

// ---------- Auto-feed ----------
// When enabled, tops up any active non-admin rep who has zero buyer leads
// still needing action (see leadNeedsAction) with more unassigned leads,
// matched to that rep's PreferredCity/State/Zip when set. A rep who's never
// been assigned anything also qualifies (zero leads trivially need no
// action), so turning this on for a brand-new rep with a preferred area set
// will seed their very first batch too. Callable on demand via
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

function autoFeedCheck() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('AUTO_FEED_ENABLED') !== 'TRUE') return { ok: true, fed: [], reason: 'Auto-feed is turned off.' };
  const batchSize = Number(props.getProperty('AUTO_FEED_BATCH_SIZE') || '50');

  const repsSheet = getSheet(REPS_SHEET, REP_COLUMNS);
  const reps = sheetToObjects(repsSheet).filter(function (r) {
    const active = !(r['Active'] === false || r['Active'] === 'FALSE');
    const isAdmin = r['IsAdmin'] === true || r['IsAdmin'] === 'TRUE';
    return active && !isAdmin;
  });

  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const allLeads = sheetToObjects(leadsSheet);
  const allContacts = sheetToObjects(contactsSheet);
  const contactsByLead = {};
  allContacts.forEach(function (c) {
    if (!contactsByLead[c['BuyerLeadID']]) contactsByLead[c['BuyerLeadID']] = [];
    contactsByLead[c['BuyerLeadID']].push(c);
  });

  const fed = [];
  reps.forEach(function (rep) {
    const username = rep['Username'];
    const myLeads = allLeads.filter(function (l) { return String(l['AssignedTo'] || '').toLowerCase() === username; });
    const stillNeedsAction = myLeads.some(function (l) {
      return leadNeedsAction(computeLeadStatus(l['PhoneType'], contactsByLead[l['BuyerLeadID']] || []));
    });
    if (stillNeedsAction) return;

    let pool = allLeads.filter(function (l) { return !l['AssignedTo']; });
    if (rep['PreferredCity']) pool = pool.filter(function (l) { return String(l['City'] || '').toLowerCase() === String(rep['PreferredCity']).toLowerCase(); });
    if (rep['PreferredState']) pool = pool.filter(function (l) { return String(l['State'] || '').toLowerCase() === String(rep['PreferredState']).toLowerCase(); });
    if (rep['PreferredZip']) pool = pool.filter(function (l) { return String(l['Zip'] || '') === String(rep['PreferredZip']); });
    if (pool.length === 0) return;

    const batch = pool.slice(0, batchSize);
    const now = new Date().toISOString();
    batch.forEach(function (l) {
      leadsSheet.getRange(l._row, getColumnIndex(leadsSheet, 'AssignedTo')).setValue(username);
      leadsSheet.getRange(l._row, getColumnIndex(leadsSheet, 'AssignedAt')).setValue(now);
      l['AssignedTo'] = username; // keep in-memory allLeads consistent for subsequent reps in this same run
    });
    fed.push({ username: username, name: rep['Name'], count: batch.length });
  });

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

// ---------- Rep-facing buyer leads ----------

function getMyBuyerLeads(body, session) {
  const sheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const myLeads = sheetToObjects(sheet).filter(function (l) { return String(l['AssignedTo'] || '').toLowerCase() === session.u; });
  const contactsSheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const allContacts = sheetToObjects(contactsSheet).filter(function (c) { return String(c['Username'] || '').toLowerCase() === session.u; });
  return { ok: true, leads: buyerLeadsWithStatus(myLeads, allContacts) };
}

function ownsLeadOrAdmin(session, lead) {
  return session.a || String(lead['AssignedTo'] || '').toLowerCase() === session.u;
}

function getBuyerLeadContacts(body, session) {
  if (!body.buyerLeadId) return { ok: false, error: 'Missing buyerLeadId.' };
  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const lead = sheetToObjects(leadsSheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!lead) return { ok: false, error: 'Lead not found.' };
  if (!ownsLeadOrAdmin(session, lead)) return { ok: false, error: 'This lead is not assigned to you.' };
  const sheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const contacts = sheet ? sheetToObjects(sheet).filter(function (c) { return c['BuyerLeadID'] === body.buyerLeadId; }) : [];
  return { ok: true, contacts: contacts };
}

function addBuyerLeadContact(body, session) {
  if (!body.buyerLeadId || !body.method) return { ok: false, error: 'Missing buyerLeadId or method.' };
  if (body.method !== 'Call' && body.method !== 'Text') return { ok: false, error: 'Method must be Call or Text.' };

  const leadsSheet = getSheet(BUYER_LEADS_SHEET, BUYER_LEAD_COLUMNS);
  const lead = sheetToObjects(leadsSheet).find(function (l) { return l['BuyerLeadID'] === body.buyerLeadId; });
  if (!lead) return { ok: false, error: 'Lead not found.' };
  if (!ownsLeadOrAdmin(session, lead)) return { ok: false, error: 'This lead is not assigned to you.' };
  if (body.method === 'Text' && String(lead['PhoneType'] || '').trim().toLowerCase() === 'landline') {
    return { ok: false, error: 'This is a landline — it can only be called, not texted.' };
  }

  const sheet = getSheet(BUYER_LEAD_CONTACTS_SHEET, BUYER_LEAD_CONTACT_COLUMNS);
  const contactId = Utilities.getUuid();
  appendRowByHeaders(sheet, {
    'ContactID': contactId, 'BuyerLeadID': body.buyerLeadId, 'Username': session.u, 'Method': body.method,
    'ContactedAt': new Date().toISOString(), 'Responded': !!body.responded, 'DealID': body.dealId || '', 'Notes': body.notes || ''
  });
  return { ok: true, contactId: contactId };
}
