const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const client = require("./sync-client.js");

function memoryStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    dump: data
  };
}

function backupText(keys) {
  return JSON.stringify({
    app: "MitoForge",
    schema: 1,
    exportedAt: "2026-11-04T12:00:00.000Z",
    keys: keys
  });
}

function harness(options) {
  options = options || {};
  const calls = [];
  const timers = [];
  const storage = options.storage || memoryStorage();
  const fetchImpl = options.fetch || (async function (url, opts) {
    calls.push({ url: url, opts: opts });
    return {
      type: "basic",
      text: async function () { return JSON.stringify({ ok: true, savedAt: "2026-11-04T12:00:01.000Z" }); }
    };
  });
  const sync = client.create({
    backupText: options.backupText || function () {
      return backupText({
        mf_p1_log: "[{\"exercise\":\"squat\"}]",
        mf_p1_nutri_log: "[]",
        mf_p1_checkin_log: "[]",
        mf_p1_body_entries: "[]"
      });
    },
    storage: storage,
    fetch: fetchImpl,
    now: function () { return new Date("2026-11-04T12:00:02.000Z"); },
    setTimer: function (fn, ms) {
      const entry = { fn: fn, ms: ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: function (entry) { if (entry) entry.cleared = true; },
    onChange: options.onChange
  });
  return { sync: sync, calls: calls, timers: timers, storage: storage };
}

function activeTimers(timers) {
  return timers.filter(function (entry) { return !entry.cleared; });
}

test("payload matches the backup shape and adds only the token", function () {
  const { sync } = harness();
  sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "secret-token" });
  const payload = sync.buildPayload();
  assert.equal(payload.app, "MitoForge");
  assert.equal(payload.schema, 1);
  assert.equal(payload.exportedAt, "2026-11-04T12:00:00.000Z");
  assert.equal(payload.token, "secret-token");
  assert.equal(payload.keys.mf_p1_log, "[{\"exercise\":\"squat\"}]");
  assert.equal(typeof payload.keys.mf_p1_nutri_log, "string");
  assert.equal(payload.keys.mitoforge_ai_cfg, undefined);
  assert.equal(payload.keys.mitoforge_sync_cfg, undefined);
});

test("backup collector keeps raw mf_ strings and drops other keys", function () {
  const store = {
    length: 4,
    key: function (i) { return ["mf_p1_log", "mitoforge_ai_cfg", "mitoforge_sync_cfg", "mf_p1_checkin_log"][i]; },
    getItem: function (key) {
      return {
        mf_p1_log: "{\"sets\":3}",
        mitoforge_ai_cfg: "{\"key\":\"sk-secret\"}",
        mitoforge_sync_cfg: "{\"token\":\"nope\"}",
        mf_p1_checkin_log: "[]"
      }[key];
    }
  };
  // Same loop the app's mfBackupText uses.
  const collected = { app: "MitoForge", schema: 1, exportedAt: "2026-11-04T00:00:00.000Z", keys: {} };
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || key.indexOf("mf_") !== 0) continue;
    collected.keys[key] = store.getItem(key);
  }
  const { sync } = harness({
    backupText: function () { return JSON.stringify(collected); }
  });
  sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "t" });
  const payload = sync.buildPayload();
  assert.deepEqual(Object.keys(payload.keys).sort(), ["mf_p1_checkin_log", "mf_p1_log"]);
  assert.equal(payload.keys.mf_p1_log, "{\"sets\":3}");
  assert.equal(JSON.stringify(payload).includes("sk-secret"), false);
  assert.equal(JSON.stringify(payload).includes("nope"), false);
});

test("writes are debounced into one sync", async function () {
  const { sync, calls, timers } = harness();
  sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "t" });
  sync.noteDataWrite("mf_p1_log");
  sync.noteDataWrite("mf_p1_nutri_log");
  sync.noteDataWrite("other_key");
  const pending = activeTimers(timers);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ms, client.DEBOUNCE_MS);
  assert.equal(calls.length, 0);
  pending[0].fn();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["Content-Type"], "text/plain;charset=utf-8");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.app, "MitoForge");
  assert.equal(body.token, "t");
  assert.equal(sync.get().lastError, "");
  assert.equal(sync.get().lastSavedAt, "2026-11-04T12:00:01.000Z");
  assert.ok(sync.get().lastOkAt);
});

test("no config and turn off do not call the endpoint", async function () {
  const { sync, calls, timers } = harness();
  sync.noteDataWrite("mf_p1_log");
  assert.equal(timers.length, 0);
  const skipped = await sync.syncNow();
  assert.equal(skipped.skipped, true);
  assert.equal(calls.length, 0);
  sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "t" });
  sync.disable();
  sync.noteDataWrite("mf_p1_log");
  assert.equal(activeTimers(timers).length, 0);
  const again = await sync.syncNow();
  assert.equal(again.skipped, true);
  assert.equal(calls.length, 0);
  assert.equal(sync.get().token, "t");
  assert.equal(sync.get().enabled, false);
});

test("a rejected token is shown and not retried as fire-and-forget", async function () {
  const { sync, calls } = harness({
    fetch: async function () {
      calls.push(1);
      return { type: "basic", text: async function () { return JSON.stringify({ ok: false, error: "Bad token" }); } };
    }
  });
  sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "wrong" });
  const result = await sync.syncNow();
  assert.equal(result.ok, false);
  assert.equal(result.error, "Bad token");
  assert.equal(calls.length, 1);
  assert.equal(sync.get().lastError, "Bad token");
  assert.equal(sync.get().lastOkAt, "");
});

test("unreadable POST falls back to no-cors and confirms with GET", async function () {
  const seen = [];
  const { sync } = harness({
    fetch: async function (url, opts) {
      seen.push({ url: url, mode: opts.mode || "cors", method: opts.method });
      if ((opts.mode || "cors") === "cors" && opts.method === "POST") throw new TypeError("Failed to fetch");
      if (opts.method === "GET") {
        return { type: "basic", text: async function () { return JSON.stringify({ ok: true }); } };
      }
      return { type: "opaque", text: async function () { throw new Error("opaque"); } };
    }
  });
  sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "t" });
  const result = await sync.syncNow();
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, false);
  assert.deepEqual(seen.map(function (item) { return item.method + ":" + item.mode; }), ["POST:cors", "POST:no-cors", "GET:cors"]);
  assert.ok(seen[2].url.includes("token=t"));
});

test("a small hide uses keepalive; a large one does not post", async function () {
  const small = harness();
  small.sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "t" });
  await small.sync.onHidden();
  assert.equal(small.calls.length, 1);
  assert.equal(small.calls[0].opts.keepalive, true);

  const largeKeys = { mf_p1_log: "x".repeat(client.KEEPALIVE_MAX + 50) };
  const large = harness({
    backupText: function () { return backupText(largeKeys); }
  });
  large.sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "t" });
  large.sync.noteDataWrite("mf_p1_log");
  const before = large.calls.length;
  const hidden = await large.sync.onHidden();
  assert.equal(hidden.reason, "too-large-for-keepalive");
  assert.equal(large.calls.length, before);
  assert.equal(activeTimers(large.timers).length, 1);
});

test("config URL must be https, except localhost", function () {
  const { sync, storage } = harness();
  assert.equal(sync.save({ url: "javascript:alert(1)", token: "t" }).ok, false);
  assert.equal(sync.save({ url: "http://example.com/exec", token: "t" }).ok, false);
  assert.equal(sync.save({ url: "https://user:pass@script.google.com/exec", token: "t" }).ok, false);
  const local = sync.save({ url: "http://127.0.0.1:9/exec", token: "t" });
  assert.equal(local.ok, true);
  assert.equal(JSON.parse(storage.dump[client.CFG_KEY]).url, "http://127.0.0.1:9/exec");
  assert.equal(storage.dump[client.CFG_KEY].includes("mf_"), false);
});

test("store hook ignores non-mf keys and debounces mf_ writes", function () {
  const { sync, timers } = harness();
  sync.save({ url: "https://script.google.com/macros/s/abc/exec", token: "t" });
  const store = {
    setItem: function () {},
    removeItem: function () {}
  };
  sync.installStore(store);
  store.setItem("mitoforge_ai_cfg", "{\"key\":\"secret\"}");
  store.setItem("mf_p1_log", "[]");
  store.removeItem("mf_p1_nutri_log");
  assert.equal(activeTimers(timers).length, 1);
});

function loadRules() {
  const source = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");
  const start = source.indexOf("// PURE_START");
  const end = source.indexOf("// PURE_END");
  assert.ok(start > 0 && end > start);
  const context = {};
  vm.runInNewContext(source.slice(start, end), context);
  return context;
}

test("script rules authorize, strip the token, and prune old days", function () {
  const rules = loadRules();
  assert.equal(rules.syncAuthorize("", "").ok, false);
  assert.equal(rules.syncAuthorize("nope", "expected").error, "Bad token");
  assert.equal(rules.syncAuthorize("expected", "expected").ok, true);
  const parsed = rules.syncParseBody(JSON.stringify({
    app: "MitoForge",
    schema: 1,
    exportedAt: "2026-11-04T00:00:00.000Z",
    token: "expected",
    keys: { mf_p1_log: "[]", mitoforge_ai_cfg: "no", stray: 1 }
  }));
  assert.equal(parsed.ok, true);
  const file = JSON.parse(rules.syncFileContents(parsed.body));
  assert.equal(file.token, undefined);
  assert.deepEqual(file.keys, { mf_p1_log: "[]" });
  assert.equal(file.app, "MitoForge");
  const today = new Date(2026, 10, 4);
  assert.equal(rules.syncSnapshotName(rules.syncDayString(today)), "MitoForge sync 2026-11-04.json");
  assert.equal(rules.syncShouldPrune(rules.syncLatestName(), today, 30), false);
  assert.equal(rules.syncShouldPrune(rules.syncPlanName(), today, 30), false);
  assert.equal(rules.syncShouldPrune("MitoForge sync 2026-11-04.json", today, 30), false);
  assert.equal(rules.syncShouldPrune("MitoForge sync 2026-10-05.json", today, 30), false);
  assert.equal(rules.syncShouldPrune("MitoForge sync 2026-10-04.json", today, 30), true);
  assert.equal(JSON.stringify(rules.syncParsePlan("{\"week\":1}")), "{\"week\":1}");
  assert.equal(rules.syncParseBody("{").ok, false);
});

test("mock web app receives a text/plain backup and returns savedAt", async function () {
  const received = [];
  const server = http.createServer(function (req, res) {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://127.0.0.1");
      const ok = url.searchParams.get("token") === "phone-token";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: "Bad token" }));
      return;
    }
    const chunks = [];
    req.on("data", function (chunk) { chunks.push(chunk); });
    req.on("end", function () {
      received.push({
        type: req.headers["content-type"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, savedAt: "2026-11-04T15:00:00.000Z" }));
    });
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  try {
    const { sync } = harness({
      fetch: function (url, opts) { return fetch(url, opts); }
    });
    const saved = sync.save({ url: "http://127.0.0.1:" + port + "/exec", token: "phone-token" });
    assert.equal(saved.ok, true);
    const tested = await sync.test();
    assert.equal(tested.ok, true);
    const sent = await sync.syncNow();
    assert.equal(sent.ok, true);
    assert.equal(sent.savedAt, "2026-11-04T15:00:00.000Z");
    assert.equal(received.length, 1);
    assert.match(received[0].type, /^text\/plain/);
    assert.equal(received[0].body.token, "phone-token");
    assert.equal(received[0].body.keys.mf_p1_log, "[{\"exercise\":\"squat\"}]");
    assert.equal(received[0].body.keys.mitoforge_sync_cfg, undefined);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
});

test("the page wires the real backup function and the service worker cache bumped", function () {
  const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const sw = fs.readFileSync(path.join(__dirname, "../sw.js"), "utf8");
  assert.match(index, /backupText:\s*function\s*\(\)\s*\{\s*return window\.mfBackupText\(\);\s*\}/);
  assert.match(index, /function mfBackupText\(\)\{var o=\{app:"MitoForge",schema:1,exportedAt:new Date\(\)\.toISOString\(\),keys:\{\}\}/);
  assert.match(index, /☁ Drive Sync/);
  assert.match(index, /function MfDriveSync/);
  assert.match(sw, /mitoforge-shell-v10/);
  assert.match(sw, /script\.google\.com/);
  assert.match(sw, /drive-sync\/sync-client\.js/);
  const script = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");
  assert.equal((script.match(/MimeType\.JSON/g) || []).length, 1);
  assert.match(script, /ContentService\.MimeType\.JSON/);
  assert.match(script, /createFile\(name, contents, "application\/json"\)/);
  assert.equal(index.includes("phone-token"), false);
  assert.equal(/macros\/s\/[A-Za-z0-9_-]{8,}\/exec/.test(index), false);
  assert.equal(fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8").includes("phone-token"), false);
});
