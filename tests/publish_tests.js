// Fake GitHub (Git Data + Contents API), Drive and Apps Script services for the publishing functions.
var results = [];
function check(name, ok, extra) { results.push((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); }

var G;                                    // the fake GitHub's state for one scenario
function resetGithub(opts) {
  G = { opts: opts || {}, calls: [], commits: [], head: 'h0', n: 0, contents: {}, patchFails: (opts && opts.patchFails) || 0 };
}
var Utilities = {
  Charset: { UTF_8: 'utf8' },
  base64Encode: function (x) { return 'b64:' + (typeof x === 'string' ? x : 'bytes' + x.length); },
  sleep: function () {}
};
var PropertiesService = { getScriptProperties: function () { return { getProperty: function (k) { return { GITHUB_TOKEN: 't' }[k] || null; } }; } };
function resp(code, obj) { return { getResponseCode: function () { return code; }, getContentText: function () { return JSON.stringify(obj || {}); } }; }
var UrlFetchApp = {
  fetch: function (url, o) {
    o = o || {}; var method = (o.method || 'get').toLowerCase(), path = url.replace('https://api.github.com/repos/pharaohm33/dispositions-crm', '');
    var body = o.payload ? JSON.parse(o.payload) : null; G.calls.push(method.toUpperCase() + ' ' + path.split('?')[0]);
    if (path.indexOf('/git/blobs') === 0) { if (G.opts.blobsFail) return resp(403, { message: 'Resource not accessible' }); return resp(201, { sha: 'blob' + (++G.n) }); }
    if (path.indexOf('/git/ref/heads/') === 0) return resp(200, { object: { sha: G.head } });
    if (path.indexOf('/git/commits/') === 0) return resp(200, { tree: { sha: 'tree-of-' + G.head } });
    if (path === '/git/trees') return resp(201, { sha: 'tree' + (++G.n) });
    if (path === '/git/commits') { var c = { sha: 'c' + (++G.n), message: body.message, parents: body.parents, tree: body.tree }; G.pending = c; return resp(201, c); }
    if (path.indexOf('/git/refs/heads/') === 0) {
      if (G.patchFails > 0) { G.patchFails--; G.head = 'h-other-' + G.n; return resp(422, { message: 'Update is not a fast forward' }); }
      G.commits.push(G.pending); G.head = G.pending.sha; return resp(200, {});
    }
    if (path.indexOf('/contents/') === 0) {
      var p = path.slice('/contents/'.length).split('?')[0];
      if (method === 'get') return G.contents[p] ? resp(200, { sha: 's' }) : resp(404, {});
      G.contents[p] = 1; G.commits.push({ legacy: true, message: body.message }); return resp(201, {});
    }
    return resp(404, {});
  }
};
function bytes(n) { var a = []; a.length = n; return a; }
function driveWith(sizes) {
  var files = sizes.map(function (sz, i) { return { getMimeType: function () { return 'image/jpeg'; }, getBlob: function () { return { getBytes: function () { return bytes(sz); }, getContentType: function () { return 'image/jpeg'; } }; } }; });
  return { getFolderById: function () { var i = 0; return { getFiles: function () { return { hasNext: function () { return i < files.length; }, next: function () { return files[i++]; } }; } }; } };
}
var DriveApp = driveWith(Array(30).fill(100000));
var LINK = 'https://drive.google.com/drive/folders/abcDEF12345_xyz';
function count(prefix) { return G.calls.filter(function (c) { return c.indexOf(prefix) === 0; }).length; }

// 1. 30 pictures in Drive -> capped at 24 -> ONE commit, no per-file PUTs
resetGithub();
var r = publishDealPhotosFromDrive('deal1', LINK);
check('24 photos are published as ONE commit', G.commits.length === 1 && count('PATCH /git/refs') === 1 && count('PUT /contents') === 0, { commits: G.commits.length, calls: G.calls.length });
check('the paths come back in order and the total found is kept', r.paths.length === 24 && r.paths[0] === 'deals/deal1/photos/1.jpg' && r.paths[23] === 'deals/deal1/photos/24.jpg' && r.totalFound === 30, r);

// 2. a new deal: the page and its photos go up in ONE commit
resetGithub();
var got = collectDealPhotosFromDrive('deal2', LINK);
check('collecting reads Drive but commits nothing', G.calls.length === 0 && got.files.length === 24, G.calls);
var url = publishDealPageToGithub('deal2', '<html>page</html>', got.files);
check('page + 24 photos = one commit (one GitHub Pages build)', G.commits.length === 1 && G.commits[0].message.indexOf('deal page deal2') !== -1 && count('POST /git/blobs') === 25 && count('PUT /contents') === 0, { commits: G.commits, blobs: count('POST /git/blobs') });
check('the public link is returned', url === 'https://sendmybuyer.com/deals/deal2.html', url);

// 3. page alone (price sync): the normal single Contents call
resetGithub();
publishDealPageToGithub('deal3', '<html></html>');
check('a page on its own is a single normal commit', G.commits.length === 1 && count('PUT /contents') === 1 && count('POST /git/blobs') === 0, G.calls);

// 4. the single-commit way is refused (token scope): falls back to one file at a time, nothing is lost
resetGithub({ blobsFail: true });
var r4 = publishDealPhotosFromDrive('deal4', LINK);
check('fallback: still publishes every photo (one by one)', r4.paths.length === 24 && count('PUT /contents') === 24, { paths: r4.paths.length, puts: count('PUT /contents') });
resetGithub({ blobsFail: true });
var got5 = collectDealPhotosFromDrive('deal5', LINK);
var url5 = publishDealPageToGithub('deal5', '<html></html>', got5.files);
check('fallback for a new deal: photos one by one, then the page', count('PUT /contents') === 25 && url5.indexOf('deal5.html') !== -1, count('PUT /contents'));

// 5. somebody pushed in between: the branch move is retried on the newest commit
resetGithub({ patchFails: 1 });
publishDealPhotosFromDrive('deal6', LINK);
check('a race on the branch is retried, still one landed commit', G.commits.length === 1 && count('PATCH /git/refs') === 2 && count('POST /git/commits') === 2, G.calls.filter(function (c) { return c.indexOf('git/commits') !== -1 || c.indexOf('refs') !== -1; }));
resetGithub({ patchFails: 9 });
var threw = false; try { githubCommitFiles([{ path: 'a.txt', text: 'x' }], 'm'); } catch (e) { threw = /HTTP 422/.test(String(e)); }
check('it gives up after 4 tries with a clear error', threw && count('PATCH /git/refs') === 4, G.calls.length);

// 6. oversize pictures are skipped, the rest still go
DriveApp = driveWith([100000, 950000, 100000]);
resetGithub();
var r6 = publishDealPhotosFromDrive('deal7', LINK);
check('a picture over ~900 KB is skipped, the others keep their numbers', r6.paths.length === 2 && r6.paths[0] === 'deals/deal7/photos/1.jpg' && r6.paths[1] === 'deals/deal7/photos/3.jpg' && r6.totalFound === 3, r6);

// 7. no Drive link -> nothing happens
resetGithub();
var r7 = publishDealPhotosFromDrive('deal8', 'not a drive link');
check('a non-Drive link publishes nothing', r7.paths.length === 0 && G.calls.length === 0, r7);

results.join('\n') + '\n' + results.filter(function (x) { return x.indexOf('FAIL') === 0; }).length + ' failed of ' + results.length;
