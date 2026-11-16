const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const client = require("./sync-client.js");

const SOURCE = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");

function loadRules() {
  const start = SOURCE.indexOf("// PURE_START");
  const end = SOURCE.indexOf("// PURE_END");
  assert.ok(start > 0 && end > start);
  const context = {};
  vm.runInNewContext(SOURCE.slice(start, end), context);
  return context;
}

// Fake Drive, enough for doGet / doPost.
function fakeFile(name, text) {
  const f = { name: name, text: text, trashed: false };
  f.getName = function () { return f.name; };
  f.setName = function (n) { f.name = n; };
  f.setContent = function (t) { f.text = t; };
  f.setTrashed = function (t) { f.trashed = t; };
  f.getBlob = function () { return { getDataAsString: function () { return f.text; } }; };
  return f;
}

function loadScript(initialFiles) {
  const files = initialFiles.map(function (x) { return fakeFile(x[0], x[1]); });
  const folder = {
    getFilesByName: function (n) {
      const m = files.filter(function (f) { return f.name === n; });
      let i = 0;
      return { hasNext: function () { return i < m.length; }, next: function () { return m[i++]; } };
    },
    getFiles: function () {
      let i = 0;
      return { hasNext: function () { return i < files.length; }, next: function () { return files[i++]; } };
    },
    createFile: function (n, text) { const f = fakeFile(n, text); files.push(f); return f; }
  };
  const context = {
    DriveApp: { getRootFolder: function () { return { getFoldersByName: function () { let d = false; return { hasNext: function () { return !d; }, next: function () { d = true; return folder; } }; }, createFolder: function () { return folder; } }; } },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: function (t) { return { text: t, setMimeType: function () { return this; } }; } },
    LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return "tok"; } }; } },
    Utilities: {}, Logger: { log: function () {} }
  };
  vm.runInNewContext(SOURCE, context);
  return { ctx: context, files: files };
}

const P = "mf_p1_";
const phoneLog = [{ id: 1, type: "strength", exercise: "squat" }];
function latestText(keys) { return JSON.stringify({ app: "MitoForge", schema: 1, exportedAt: "2026-11-06T00:00:00Z", keys: keys }); }
function inboxText(keys) { return JSON.stringify({ app: "MitoForge", keys: keys }); }
const newEntry = { id: 2, type: "cardio", exercise: "Incline Treadmill", distance: "2.25", verticalFt: "1359" };

test("inbox: new entries are added, existing ones are not duplicated", function () {
  const r = loadRules();
  const backup = { app: "MitoForge", schema: 1, exportedAt: "x", keys: { [P + "log"]: JSON.stringify(phoneLog) } };
  const a = r.syncApplyInbox(backup, { [P + "log"]: [phoneLog[0], newEntry] });
  assert.equal(a.added, 1);
  assert.deepEqual(JSON.parse(a.backup.keys[P + "log"]).map(function (e) { return e.id; }), [1, 2]);
  assert.equal(backup.keys[P + "log"], JSON.stringify(phoneLog), "input untouched");
  const again = r.syncApplyInbox(a.backup, { [P + "log"]: [phoneLog[0], newEntry] });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
});

test("inbox: a key the backup lacks is created; non-list values are skipped", function () {
  const r = loadRules();
  const backup = { app: "MitoForge", keys: { [P + "settings"]: "{\"a\":1}" } };
  const a = r.syncApplyInbox(backup, { [P + "watch_acts"]: [{ labelId: "L1" }], [P + "settings"]: [{ id: 9 }] });
  assert.equal(a.added, 1);
  assert.equal(a.backup.keys[P + "settings"], "{\"a\":1}");
  assert.deepEqual(JSON.parse(a.backup.keys[P + "watch_acts"]), [{ labelId: "L1" }]);
});

test("inbox: same id with different content replaces the download copy", function () {
  const r = loadRules();
  const backup = { app: "MitoForge", keys: { [P + "log"]: JSON.stringify([{ id: 5, avgHR: "" }]) } };
  const a = r.syncApplyInbox(backup, { [P + "log"]: [{ id: 5, avgHR: "107" }] });
  assert.equal(a.updated, 1);
  assert.equal(JSON.parse(a.backup.keys[P + "log"])[0].avgHR, "107");
});

test("inbox: parse accepts lists or JSON strings, ignores non-mf and non-list keys", function () {
  const r = loadRules();
  const p = r.syncParseInbox(inboxText({ [P + "log"]: [newEntry], [P + "str"]: "[{\"id\":7}]", other: [1], [P + "obj"]: { a: 1 } }));
  assert.equal(p.ok, true);
  assert.deepEqual(Object.keys(p.keys).sort(), [P + "log", P + "str"]);
  assert.equal(p.ignored, 2);
  assert.equal(r.syncParseInbox("nope").ok, false);
  assert.equal(r.syncParseInbox(JSON.stringify({ app: "Other", keys: {} })).ok, false);
});

test("inbox: remaining keeps only entries the phone upload does not hold", function () {
  const r = loadRules();
  const left = r.syncInboxRemaining({ [P + "log"]: [phoneLog[0], newEntry] }, { [P + "log"]: JSON.stringify(phoneLog) });
  assert.equal(left.count, 1);
  assert.equal(left.keys[P + "log"][0].id, 2);
  const none = r.syncInboxRemaining({ [P + "log"]: [newEntry] }, { [P + "log"]: JSON.stringify(phoneLog.concat([newEntry])) });
  assert.equal(none.count, 0);
});

test("doGet download adds inbox entries but never changes the stored latest file", function () {
  const s = loadScript([
    ["MitoForge sync (latest).json", latestText({ [P + "log"]: JSON.stringify(phoneLog) })],
    ["MitoForge inbox.json", inboxText({ [P + "log"]: [newEntry] })]
  ]);
  const before = s.files[0].text;
  const out = JSON.parse(s.ctx.doGet({ parameter: { token: "tok", download: "latest" } }).text);
  assert.equal(out.ok, true);
  assert.equal(out.inboxAdded, 1);
  assert.equal(JSON.parse(out.backup.keys[P + "log"]).length, 2);
  assert.equal(s.files[0].text, before);
});

test("doGet without an inbox, with a bad token, or without download behaves as before", function () {
  const s = loadScript([["MitoForge sync (latest).json", latestText({ [P + "log"]: "[]" })]]);
  const out = JSON.parse(s.ctx.doGet({ parameter: { token: "tok", download: "latest" } }).text);
  assert.equal(out.ok, true);
  assert.equal(out.inboxAdded, undefined);
  assert.equal(JSON.parse(s.ctx.doGet({ parameter: { token: "bad", download: "latest" } }).text).ok, false);
  assert.equal(JSON.parse(s.ctx.doGet({ parameter: { token: "tok" } }).text).ok, true);
});

test("a corrupt inbox never breaks the download or the upload", function () {
  const s = loadScript([
    ["MitoForge sync (latest).json", latestText({ [P + "log"]: "[]" })],
    ["MitoForge inbox.json", "{ not json"]
  ]);
  assert.equal(JSON.parse(s.ctx.doGet({ parameter: { token: "tok", download: "latest" } }).text).ok, true);
  const body = JSON.stringify({ app: "MitoForge", token: "tok", keys: { [P + "log"]: "[]" } });
  assert.equal(JSON.parse(s.ctx.doPost({ postData: { contents: body } }).text).ok, true);
  assert.equal(s.files.filter(function (f) { return f.name === "MitoForge inbox.json"; }).length, 1);
});

test("doPost removes inbox entries the phone now holds, keeps the rest, renames an emptied inbox", function () {
  const s = loadScript([["MitoForge inbox.json", inboxText({ [P + "log"]: [newEntry, { id: 3, type: "cardio" }] })]]);
  let body = JSON.stringify({ app: "MitoForge", token: "tok", keys: { [P + "log"]: JSON.stringify(phoneLog.concat([newEntry])) } });
  assert.equal(JSON.parse(s.ctx.doPost({ postData: { contents: body } }).text).ok, true);
  const inbox = s.files.find(function (f) { return f.name === "MitoForge inbox.json"; });
  assert.deepEqual(JSON.parse(inbox.text).keys[P + "log"].map(function (e) { return e.id; }), [3]);
  body = JSON.stringify({ app: "MitoForge", token: "tok", keys: { [P + "log"]: JSON.stringify([{ id: 2 }, { id: 3 }]) } });
  assert.equal(JSON.parse(s.ctx.doPost({ postData: { contents: body } }).text).ok, true);
  assert.equal(s.files.some(function (f) { return f.name === "MitoForge inbox.json"; }), false);
  assert.equal(s.files.some(function (f) { return /^MitoForge inbox done .*\.json$/.test(f.name); }), true);
});

test("end to end with the phone's real merge: inbox entry reaches the phone once and the inbox is used up", function () {
  const phone = { [P + "log"]: JSON.stringify(phoneLog) };
  const s = loadScript([
    ["MitoForge sync (latest).json", latestText(phone)],
    ["MitoForge inbox.json", inboxText({ [P + "log"]: [newEntry] })]
  ]);
  function syncOnce(localKeys) {
    const down = JSON.parse(s.ctx.doGet({ parameter: { token: "tok", download: "latest" } }).text);
    const merged = client.mergeKeyMaps(localKeys, down.backup.keys).keys;
    const body = JSON.stringify({ app: "MitoForge", token: "tok", keys: merged });
    assert.equal(JSON.parse(s.ctx.doPost({ postData: { contents: body } }).text).ok, true);
    return merged;
  }
  let local = syncOnce(phone);
  assert.deepEqual(JSON.parse(local[P + "log"]).map(function (e) { return e.id; }), [1, 2]);
  local = syncOnce(local);
  assert.equal(JSON.parse(local[P + "log"]).length, 2);
  // the inbox was used up by the first upload, so nothing is re-added later
  assert.equal(s.files.some(function (f) { return f.name === "MitoForge inbox.json"; }), false);
});

test("Code.gs still never contains a token value", function () {
  assert.equal(SOURCE.includes("phone-token"), false);
});

test("inbox + deletion sync together: an inbox entry arrives, then deleting it on the phone sticks", async function () {
  const s = loadScript([
    ["MitoForge sync (latest).json", latestText({ [P + "log"]: JSON.stringify(phoneLog) })],
    ["MitoForge inbox.json", inboxText({ [P + "log"]: [newEntry] })]
  ]);
  const data = { [P + "log"]: JSON.stringify(phoneLog) };
  const storage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
  const sync = client.create({
    backupText: function () {
      const keys = {};
      Object.keys(data).forEach(function (k) { if (k.indexOf("mf_") === 0) keys[k] = data[k]; });
      return JSON.stringify({ app: "MitoForge", schema: 1, exportedAt: "x", keys: keys });
    },
    storage: storage,
    setTimer: function () { return 1; }, clearTimer: function () {},
    fetch: async function (url, opts) {
      const out = (opts && opts.method === "POST")
        ? s.ctx.doPost({ postData: { contents: opts.body } })
        : s.ctx.doGet({ parameter: { token: "tok", download: String(url).indexOf("download=latest") >= 0 ? "latest" : undefined } });
      return { type: "basic", text: async function () { return out.text; } };
    }
  });
  storage.setItem(client.CFG_KEY, JSON.stringify({ url: "https://example.com/exec", token: "tok", enabled: true, lastOkAt: "", lastError: "", lastSavedAt: "" }));
  await sync.syncNow();
  assert.deepEqual(JSON.parse(data[P + "log"]).map(function (e) { return e.id; }), [1, 2], "inbox entry reached the phone");
  assert.equal(s.files.some(function (f) { return f.name === "MitoForge inbox.json"; }), false, "inbox used up");
  data[P + "log"] = JSON.stringify(phoneLog);       // delete the new entry on the phone
  await sync.syncNow();
  await sync.syncNow();
  assert.deepEqual(JSON.parse(data[P + "log"]).map(function (e) { return e.id; }), [1], "stays deleted");
});

test("watch file name is the dated drop, and the same id updates instead of duplicating", function () {
  const r = loadRules();
  assert.equal(r.syncIsWatchFile("MitoForge watch 2026-11-15.json"), true);
  assert.equal(r.syncIsWatchFile("MitoForge inbox.json"), false);
  assert.equal(r.syncIsWatchFile("MitoForge watch done 2026-11-15.json"), false);
  const day = { id: "2026-11-15", date: "2026-11-15", sleepMin: 400, restHR: 54 };
  const backup = { app: "MitoForge", schema: 1, exportedAt: "x", keys: {} };
  const once = r.syncApplyInboxList(backup, [{ [P + "watch_days"]: [day] }]);
  const twice = r.syncApplyInboxList(once.backup, [{ [P + "watch_days"]: [day] }]);
  assert.equal(twice.added, 0);
  assert.equal(twice.updated, 0);
  const edited = r.syncApplyInboxList(twice.backup, [{ [P + "watch_days"]: [{ id: "2026-11-15", date: "2026-11-15", sleepMin: 430, restHR: 54, hrv: 46 }] }]);
  assert.equal(edited.updated, 1);
  assert.equal(JSON.parse(edited.backup.keys[P + "watch_days"]).length, 1);
  assert.equal(JSON.parse(edited.backup.keys[P + "watch_days"])[0].hrv, 46);
});

test("doGet merges a dated watch file and a later upload consumes it", function () {
  const day = { id: "2026-11-15", date: "2026-11-15", sleepMin: 430, restHR: 52 };
  const s = loadScript([
    ["MitoForge sync (latest).json", latestText({ [P + "log"]: JSON.stringify(phoneLog) })],
    ["MitoForge watch 2026-11-15.json", inboxText({ [P + "watch_days"]: [day] })]
  ]);
  const out = JSON.parse(s.ctx.doGet({ parameter: { token: "tok", download: "latest" } }).text);
  assert.equal(out.ok, true);
  assert.equal(out.inboxAdded, 1);
  assert.equal(JSON.parse(out.backup.keys[P + "watch_days"])[0].sleepMin, 430);
  const uploaded = { keys: { [P + "log"]: JSON.stringify(phoneLog), [P + "watch_days"]: JSON.stringify([day]) } };
  s.ctx.doPost({ postData: { contents: JSON.stringify({ app: "MitoForge", schema: 1, token: "tok", keys: uploaded.keys }) } });
  assert.equal(s.files.some(function (f) { return f.name === "MitoForge watch 2026-11-15.json"; }), false);
  assert.equal(s.files.some(function (f) { return /^MitoForge watch done 2026-11-15 /.test(f.name); }), true);
});
