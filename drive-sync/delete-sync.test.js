const test = require("node:test");
const assert = require("node:assert/strict");
const client = require("./sync-client.js");

const P = "mf_p1_";
const LOG = P + "log";

function entries(ids) { return ids.map(function (i) { return { id: i, exercise: "e" + i }; }); }
function idsIn(storage, key) { return JSON.parse(storage.getItem(key) || "[]").map(function (e) { return e.id; }); }

// A fake Drive: stores the last uploaded keys and serves them back.
function makeDrive() {
  const drive = { latest: null, down: false };
  drive.fetch = async function (url, opts) {
    const text = function (obj) { return { type: "basic", text: async function () { return JSON.stringify(obj); } }; };
    if (opts && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      drive.latest = { app: "MitoForge", schema: 1, exportedAt: "x", keys: body.keys };
      return text({ ok: true, savedAt: "2026-11-06T12:00:00Z" });
    }
    if (String(url).indexOf("download=latest") >= 0) {
      if (drive.down || !drive.latest) return text({ ok: false, error: "No sync file yet" });
      return text({ ok: true, backup: JSON.parse(JSON.stringify(drive.latest)) });
    }
    return text({ ok: true });
  };
  return drive;
}

// A phone: its own storage, wired to the shared fake Drive.
function makePhone(drive, initialKeys, clock) {
  const data = {};
  Object.keys(initialKeys).forEach(function (k) { data[k] = initialKeys[k]; });
  const storage = {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
  const merged = [];
  const sync = client.create({
    backupText: function () {
      const keys = {};
      Object.keys(data).forEach(function (k) { if (k.indexOf("mf_") === 0) keys[k] = data[k]; });
      return JSON.stringify({ app: "MitoForge", schema: 1, exportedAt: "x", keys: keys });
    },
    storage: storage,
    fetch: drive.fetch,
    now: function () { return new Date(clock.t); },
    setTimer: function () { return 1; },
    clearTimer: function () {},
    onMerged: function (stats) { merged.push(stats); }
  });
  storage.setItem(client.CFG_KEY, JSON.stringify({ url: "https://example.com/exec", token: "t", enabled: true, lastOkAt: "", lastError: "", lastSavedAt: "" }));
  return { storage: storage, sync: sync, merged: merged };
}

test("a delete on the phone stays deleted after the next syncs", async function () {
  const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
  const drive = makeDrive();
  const phone = makePhone(drive, { [LOG]: JSON.stringify(entries([1, 2, 3])) }, clock);
  await phone.sync.syncNow();                       // first sync establishes the snapshot
  phone.storage.setItem(LOG, JSON.stringify(entries([1, 3])));   // user deletes entry 2
  await phone.sync.syncNow();
  assert.deepEqual(idsIn(phone.storage, LOG), [1, 3]);
  assert.deepEqual(JSON.parse(drive.latest.keys[LOG]).map(function (e) { return e.id; }), [1, 3]);
  assert.ok(JSON.parse(drive.latest.keys[client.TOMB_KEY])[LOG]["id:2"]);
  await phone.sync.syncNow();
  await phone.sync.syncNow();
  assert.deepEqual(idsIn(phone.storage, LOG), [1, 3]);
});

test("without the fix this is the bug: a plain merge brings the deleted entry back", function () {
  const local = { [LOG]: JSON.stringify(entries([1, 3])) };
  const drive = { [LOG]: JSON.stringify(entries([1, 2, 3])) };
  assert.equal(JSON.parse(client.mergeKeyMaps(local, drive).keys[LOG]).length, 3);
  const withFix = client.mergeWithDeletions(local, drive, client.takeSnapshot({ [LOG]: JSON.stringify(entries([1, 2, 3])) }), "2026-11-06T12:00:00.000Z");
  assert.deepEqual(JSON.parse(withFix.keys[LOG]).map(function (e) { return e.id; }), [1, 3]);
});

test("a delete on one phone reaches a second phone", async function () {
  const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
  const drive = makeDrive();
  const a = makePhone(drive, { [LOG]: JSON.stringify(entries([1, 2, 3])) }, clock);
  await a.sync.syncNow();
  const b = makePhone(drive, { [LOG]: JSON.stringify(entries([1, 2, 3])) }, clock);
  await b.sync.syncNow();                            // b now has a snapshot too
  a.storage.setItem(LOG, JSON.stringify(entries([1, 3])));
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.deepEqual(idsIn(b.storage, LOG), [1, 3]);
  assert.equal(b.merged.length > 0, true, "the app is told something changed");
});

test("first sync with no snapshot never deletes anything", async function () {
  const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
  const drive = makeDrive();
  drive.latest = { app: "MitoForge", keys: { [LOG]: JSON.stringify(entries([1, 2, 3])) } };
  const phone = makePhone(drive, { [LOG]: JSON.stringify(entries([1])) }, clock);
  await phone.sync.syncNow();
  assert.deepEqual(idsIn(phone.storage, LOG), [1, 2, 3]);
});

test("a restore or reset that removes many entries at once is not turned into deletions", async function () {
  const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
  const drive = makeDrive();
  const many = []; for (let i = 1; i <= 40; i++) many.push(i);
  const phone = makePhone(drive, { [LOG]: JSON.stringify(entries(many)) }, clock);
  await phone.sync.syncNow();
  phone.storage.setItem(LOG, JSON.stringify(entries([1, 2])));   // 38 vanish at once
  await phone.sync.syncNow();
  assert.equal(idsIn(phone.storage, LOG).length, 40, "entries come back from Drive instead of being wiped everywhere");
  assert.equal(drive.latest.keys[client.TOMB_KEY], undefined);
});

test("entries without an id are never tombstoned", function () {
  const snap = client.takeSnapshot({ [LOG]: JSON.stringify([{ name: "no id" }, { id: 5 }]) });
  assert.deepEqual(snap[LOG], ["id:5"]);
  const det = client.detectDeletions({ [LOG]: JSON.stringify([]) }, snap, "2026-11-06T12:00:00.000Z");
  assert.deepEqual(Object.keys(det.tombs[LOG]), ["id:5"]);
});

test("if the download fails the snapshot is kept, so the delete is still caught later", async function () {
  const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
  const drive = makeDrive();
  const phone = makePhone(drive, { [LOG]: JSON.stringify(entries([1, 2, 3])) }, clock);
  await phone.sync.syncNow();
  phone.storage.setItem(LOG, JSON.stringify(entries([1, 3])));
  drive.down = true;
  await phone.sync.syncNow();                        // upload-only fallback
  drive.down = false;
  await phone.sync.syncNow();
  assert.deepEqual(idsIn(phone.storage, LOG), [1, 3]);
  assert.deepEqual(JSON.parse(drive.latest.keys[LOG]).map(function (e) { return e.id; }), [1, 3]);
});

test("tombstones older than 180 days are dropped; newer ones stay", function () {
  const old = "2026-04-01T00:00:00.000Z", fresh = "2026-11-01T00:00:00.000Z";
  const r = client.mergeWithDeletions(
    { [LOG]: JSON.stringify(entries([1])), [client.TOMB_KEY]: JSON.stringify({ [LOG]: { "id:8": old, "id:9": fresh } }) },
    { [LOG]: JSON.stringify(entries([1])) }, {}, "2026-11-06T12:00:00.000Z");
  assert.deepEqual(Object.keys(JSON.parse(r.keys[client.TOMB_KEY])[LOG]), ["id:9"]);
});

test("a new entry added after a delete is kept", async function () {
  const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
  const drive = makeDrive();
  const phone = makePhone(drive, { [LOG]: JSON.stringify(entries([1, 2])) }, clock);
  await phone.sync.syncNow();
  phone.storage.setItem(LOG, JSON.stringify(entries([1])));
  await phone.sync.syncNow();
  phone.storage.setItem(LOG, JSON.stringify(entries([1, 7])));
  await phone.sync.syncNow();
  await phone.sync.syncNow();
  assert.deepEqual(idsIn(phone.storage, LOG), [1, 7]);
});
