/**
 * Dispositions CRM — Apps Script backend.
 *
 * Deploy this bound to a Google Sheet (see SETUP.md). It is the entire
 * "server": rep + admin login, deal management, per-deal access control,
 * interested-buyer logging, and Facebook post approvals all live here.
 *
 * Required Script Properties (Project Settings -> Script Properties):
 *   SESSION_SECRET      - random long string, used to sign session tokens
 *   ADMIN_NOTIFY_EMAIL  - where "new Facebook post request" emails are sent
 */

const REPS_SHEET = 'Reps';
const DEALS_SHEET = 'Deals';
const ASSIGNMENTS_SHEET = 'Assignments';
const BUYERS_SHEET = 'InterestedBuyers';
const FB_SHEET = 'FBPostRequests';
const STATUS_SHEET = 'StatusOptions';
const SESSION_HOURS = 12;
const DEFAULT_STATUSES = ['Active', 'Under Contract', 'Sold', 'Dead', 'On Hold'];

const REP_COLUMNS = ['Username', 'Name', 'PasswordHash', 'Salt', 'AllAccess', 'IsAdmin', 'Active', 'CreatedAt'];
const DEAL_COLUMNS = ['DealID', 'Address', 'City', 'State', 'Zip', 'AssetType', 'Price', 'Status', 'Description', 'CreatedAt', 'UpdatedAt'];
const ASSIGNMENT_COLUMNS = ['DealID', 'Username', 'AssignedAt'];
const BUYER_COLUMNS = ['BuyerID', 'DealID', 'Username', 'BuyerName', 'BuyerContact', 'Notes', 'CreatedAt'];
const FB_COLUMNS = ['RequestID', 'DealID', 'Username', 'PostText', 'TargetGroups', 'Status', 'AdminNote', 'CreatedAt', 'DecidedAt'];

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
  return { ok: true, deals: deals };
}

function getDeal(body, session) {
  if (!body.dealId) return { ok: false, error: 'Missing dealId.' };
  if (!canAccessDeal(session, body.dealId)) return { ok: false, error: 'You do not have access to this deal.' };
  const sheet = getSheet(DEALS_SHEET, DEAL_COLUMNS);
  const deal = sheetToObjects(sheet).find(function (d) { return d['DealID'] === body.dealId; });
  if (!deal) return { ok: false, error: 'Deal not found.' };
  return { ok: true, deal: deal };
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
      createdAt: r['CreatedAt']
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
    'CreatedAt': new Date().toISOString()
  });
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
