/**
 * Merge-sync tests for MitoForge two-way Drive sync.
 *
 * Run:  node drive-sync/merge-sync.test.js [--phone <path> --drive <path>]
 *
 * With no fixture paths, the unit tests run on small synthetic data.
 * With --phone/--drive, the same assertions run against real sync files:
 *   --phone = the phone's localStorage export ("MitoForge sync (latest).json"
 *              as uploaded by the phone)
 *   --drive = the Drive-side file with Sam's edits
 * The real files are never modified and must NOT be committed.
 *
 * Covers:
 *  (a) a Drive-added lunch survives a phone sync
 *  (b) a phone-added entry survives a merge cycle (and the upload)
 *  (c) no duplicates after repeated syncs in both directions
 *  (d) workouts / check-ins / body entries untouched
 *  (e) a Drive time edit (11:07 -> 09:30) is preserved
 *  (f) conflict rule: more complete wins, tie goes to Drive
 *  (g) legacy wholesale-replace Restore is still present and unchanged
 *  (h) server download helper accepts a valid backup and rejects junk
 *  (i) non-array keys (settings, scalars) are left alone
 *  (j) degraded mode: if the download fails, upload-only still runs
 */
"use strict";

const fs = require("fs");
const path = require("path");

const client = require("./sync-client.js");

// ---- load the Apps Script pure section (between PURE_START / PURE_END) ----
function loadServerPure(codeGsPath) {
  const text = fs.readFileSync(codeGsPath, "utf8");
  const start = text.indexOf("// PURE_START");
  const end = text.indexOf("// PURE_END");
  if (start === -1 || end === -1 || end <= start) throw new Error("PURE section not found in " + codeGsPath);
  const pure = text.slice(start, end);
  const factory = new Function(
    pure + "\n;return { syncLatestName, syncBackupDownload_, syncParseBody, syncFileContents };"
  );
  return factory();
}

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log("PASS  " + name);
  } else {
    failures++;
    console.log("FAIL  " + name + (detail ? " — " + detail : ""));
  }
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- fixtures: real files when given, synthetic otherwise ----
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--phone") out.phone = argv[++i];
    else if (argv[i] === "--drive") out.drive = argv[++i];
    else if (argv[i] === "--index-main") out.indexMain = argv[++i];
    else if (argv[i] === "--index-new") out.indexNew = argv[++i];
    else if (argv[i] === "--code-gs") out.codeGs = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const HERE = __dirname;
const serverPath = args.codeGs || path.join(HERE, "Code.gs");
const server = loadServerPure(serverPath);

function loadFixture(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

let phoneKeys, driveKeys, label;
if (args.phone && args.drive) {
  phoneKeys = loadFixture(args.phone).keys;
  driveKeys = loadFixture(args.drive).keys;
  label = "real fixtures";
} else {
  label = "synthetic fixtures";
  const eggs = { id: 1, date: "2026-11-05", time: "11:07", name: "Eggs (2 large)", protein: 30, fat: 25, carbs: 2.5, fiber: 0, netCarbs: 2.5, calories: 358 };
  const bacon = { id: 2, date: "2026-11-05", time: "11:07", name: "Bacon (2 strips)", protein: 6, fat: 8, carbs: 0, fiber: 0, netCarbs: 0, calories: 87 };
  const lunch = [
    { id: 3, date: "2026-11-05", time: "12:30", name: "Grilled chicken breast (2 oz)", protein: 14, fat: 3, carbs: 0, fiber: 0, netCarbs: 0, calories: 95 },
    { id: 4, date: "2026-11-05", time: "12:30", name: "Newman's Own Caesar Dressing (2 packets)", protein: 0, fat: 47, carbs: 2, fiber: 0, netCarbs: 2, calories: 425 },
    { id: 5, date: "2026-11-05", time: "12:30", name: "Shredded cheese sprinkle (2 tbsp)", protein: 2, fat: 3, carbs: 0, fiber: 0, netCarbs: 0, calories: 40 },
    { id: 6, date: "2026-11-05", time: "12:30", name: "Cherry tomatoes (3)", protein: 0, fat: 0, carbs: 2, fiber: 1, netCarbs: 1, calories: 8 },
    { id: 7, date: "2026-11-05", time: "12:30", name: "Mixed salad veggies (large salad)", protein: 2, fat: 0, carbs: 6, fiber: 3, netCarbs: 3, calories: 38 }
  ];
  const eggs930 = Object.assign({}, eggs, { time: "09:30" });
  const bacon930 = Object.assign({}, bacon, { time: "09:30" });
  const workout = { id: 101, type: "cardio", date: "2026-11-05", exercise: "Incline Treadmill", duration: 30 };
  const checkin = { date: "2026-11-05", sleep: "Good", soreness: "Mild", readiness: "Ready" };
  phoneKeys = {
    "mf_x_nutri_log": JSON.stringify([eggs, bacon]),
    "mf_x_log": JSON.stringify([workout]),
    "mf_x_checkin_log": JSON.stringify([checkin]),
    "mf_x_nutri_settings": JSON.stringify({ goalWeight: 200, proteinMultiplier: 1 }),
    "mf_x_train_mode": JSON.stringify("strength")
  };
  driveKeys = {
    "mf_x_nutri_log": JSON.stringify([eggs930, bacon930].concat(lunch)),
    "mf_x_log": JSON.stringify([workout]),
    "mf_x_checkin_log": JSON.stringify([checkin]),
    "mf_x_nutri_settings": JSON.stringify({ goalWeight: 200, proteinMultiplier: 1 }),
    "mf_x_train_mode": JSON.stringify("strength")
  };
}

console.log("== merge-sync tests (" + label + ") ==");

const NUTRI = Object.keys(phoneKeys).find((k) => k.indexOf("nutri_log") !== -1) || "mf_x_nutri_log";
const WORK = Object.keys(phoneKeys).find((k) => k === "mf_1779122045858_log" || k.indexOf("_log") !== -1 && k.indexOf("nutri") === -1 && k.indexOf("checkin") === -1) || "mf_x_log";
const CHECKIN = Object.keys(phoneKeys).find((k) => k.indexOf("checkin_log") !== -1) || "mf_x_checkin_log";

function todayEntries(keys, key) {
  return JSON.parse(keys[key] || "[]").filter((e) => e && e.date === "2026-11-05");
}

// ---- (a) Drive-added lunch survives a phone sync ----
(function () {
  const r = client.mergeKeyMaps(phoneKeys, driveKeys);
  const today = todayEntries(r.keys, NUTRI);
  const lunchNames = ["Grilled chicken breast", "Caesar Dressing", "Shredded cheese", "Cherry tomatoes", "Mixed salad veggies"];
  const found = lunchNames.filter((n) => today.some((e) => String(e.name).indexOf(n) !== -1));
  check("(a) Drive lunch survives phone sync", found.length === 5, "found " + found.length + "/5 lunch items");
  check("(a) merged today count is 7", today.length === 7, "got " + today.length);
})();

// ---- (e) Drive time edit preserved ----
(function () {
  const r = client.mergeKeyMaps(phoneKeys, driveKeys);
  const today = todayEntries(r.keys, NUTRI);
  const eggs = today.find((e) => String(e.name).indexOf("Eggs") !== -1);
  check("(e) breakfast time edit 11:07 -> 09:30 preserved", eggs && eggs.time === "09:30", "got " + (eggs && eggs.time));
})();

// ---- (f) conflict rule ----
(function () {
  const thin = { id: 9, name: "Soup", calories: 100 };
  const fat = { id: 9, name: "Soup", protein: 5, fat: 3, carbs: 10, fiber: 1, netCarbs: 9, calories: 100, serving: 1 };
  const r1 = client.resolveConflict(thin, fat);
  check("(f) more-complete remote wins", r1.winner === "remote" && r1.entry === fat, "winner=" + r1.winner);
  const r2 = client.resolveConflict(fat, thin);
  check("(f) more-complete local wins", r2.winner === "local" && r2.entry === fat, "winner=" + r2.winner);
  const tieA = { id: 10, time: "11:07", name: "Eggs", calories: 358 };
  const tieB = { id: 10, time: "09:30", name: "Eggs", calories: 358 };
  const r3 = client.resolveConflict(tieA, tieB);
  check("(f) tie goes to Drive", r3.winner === "remote-tie" && r3.entry.time === "09:30", "winner=" + r3.winner);
})();

// ---- (d) workouts / check-ins untouched ----
(function () {
  const r = client.mergeKeyMaps(phoneKeys, driveKeys);
  check("(d) workouts untouched", eq(JSON.parse(r.keys[WORK]), JSON.parse(phoneKeys[WORK])), "workout log changed");
  check("(d) check-ins untouched", eq(JSON.parse(r.keys[CHECKIN]), JSON.parse(phoneKeys[CHECKIN])), "checkin log changed");
  const phoneWork = JSON.parse(phoneKeys[WORK]);
  const mergedWork = JSON.parse(r.keys[WORK]);
  check("(d) workout count unchanged", mergedWork.length === phoneWork.length, mergedWork.length + " vs " + phoneWork.length);
})();

// ---- (i) non-array keys left alone ----
(function () {
  const r = client.mergeKeyMaps(phoneKeys, driveKeys);
  const settingsKey = Object.keys(phoneKeys).find((k) => k.indexOf("nutri_settings") !== -1);
  const modeKey = Object.keys(phoneKeys).find((k) => k.indexOf("train_mode") !== -1);
  if (settingsKey) check("(i) settings object unchanged", r.keys[settingsKey] === phoneKeys[settingsKey]);
  if (modeKey) check("(i) scalar value unchanged", r.keys[modeKey] === phoneKeys[modeKey]);
})();

// ---- (c) idempotency, both directions ----
(function () {
  const once = client.mergeKeyMaps(phoneKeys, driveKeys);
  const twicePhone = client.mergeKeyMaps(once.keys, driveKeys);
  const twiceDrive = client.mergeKeyMaps(phoneKeys, once.keys);
  const bothWays = client.mergeKeyMaps(once.keys, once.keys);
  check("(c) merge is idempotent (phone side)", eq(twicePhone.keys, once.keys));
  check("(c) merge is idempotent (drive side)", eq(twiceDrive.keys, once.keys));
  check("(c) merge with itself is a no-op", eq(bothWays.keys, once.keys));
  const nutri = JSON.parse(once.keys[NUTRI]);
  const ids = nutri.map((e) => e.id);
  check("(c) no duplicate ids after merge", new Set(ids).size === ids.length, ids.length + " entries, " + new Set(ids).size + " unique");
})();

// ---- (h) server download helper ----
(function () {
  const good = server.syncBackupDownload_(JSON.stringify({ app: "MitoForge", keys: driveKeys }));
  check("(h) server accepts a valid backup", good.ok === true && good.backup && good.backup.app === "MitoForge");
  check("(h) server rejects empty text", server.syncBackupDownload_("").ok === false);
  check("(h) server rejects junk JSON", server.syncBackupDownload_("not json").ok === false);
  check("(h) server rejects non-MitoForge", server.syncBackupDownload_(JSON.stringify({ app: "Other", keys: {} })).ok === false);
})();

// ---- (g) legacy Restore still present and unchanged ----
(function () {
  if (!args.indexMain || !args.indexNew) {
    console.log("SKIP  (g) legacy Restore check (needs --index-main and --index-new)");
    return;
  }
  const a = fs.readFileSync(args.indexMain, "utf8");
  const b = fs.readFileSync(args.indexNew, "utf8");
  const startMark = "/* ---------- restore from a backup ---------- */";
  const endMark = "/* ---------- saving a file, asking Claude ---------- */";
  const slice = (t) => {
    const i = t.indexOf(startMark), j = t.indexOf(endMark);
    return i === -1 || j === -1 ? null : t.slice(i, j);
  };
  const sa = slice(a), sb = slice(b);
  check("(g) legacy mfRestore block byte-identical", sa !== null && sa === sb, sa === null ? "markers not found" : "block changed");
  check("(g) menu Restore entry still exists", b.indexOf("Restore from a backup") !== -1);
})();

// ---- (b) + full syncNow integration with fake storage/fetch ----
(async function () {
  // Fake mfStore (the app store) seeded with the PHONE keys.
  function makeStore(seed) {
    const map = new Map(Object.entries(seed || {}));
    const store = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
      key: (i) => Array.from(map.keys())[i] || null,
      get length() { return map.size; },
      _map: map
    };
    return store;
  }
  const cfgStore = makeStore({});
  const appStore = makeStore(phoneKeys);
  const cfg = { url: "https://script.google.com/macros/s/abc/exec", token: "test-token-1234567890", enabled: true, lastOkAt: "", lastError: "", lastSavedAt: "" };
  cfgStore.setItem("mitoforge_sync_cfg", JSON.stringify(cfg));

  const posts = [];
  let getCalls = 0;
  async function fakeFetch(url, opts) {
    if (opts && opts.method === "POST") {
      posts.push(JSON.parse(opts.body));
      return { text: async () => JSON.stringify({ ok: true, savedAt: "2026-11-05T16:00:00.000Z" }) };
    }
    getCalls++;
    if (url.indexOf("download=latest") !== -1) {
      return { text: async () => JSON.stringify({ ok: true, backup: { app: "MitoForge", exportedAt: "2026-11-05T15:38:40.000Z", keys: driveKeys } }) };
    }
    return { text: async () => JSON.stringify({ ok: true }) };
  }
  function backupText() {
    const keys = {};
    for (let i = 0; i < appStore.length; i++) {
      const k = appStore.key(i);
      if (k && k.indexOf("mf_") === 0) keys[k] = appStore.getItem(k);
    }
    return JSON.stringify({ app: "MitoForge", schema: 1, exportedAt: new Date().toISOString(), keys });
  }

  const sync = client.create({
    backupText,
    storage: cfgStore,
    store: appStore,
    fetch: fakeFetch,
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => new Date("2026-11-05T16:00:00Z"),
    onChange: () => {}
  });
  sync.installStore(appStore);

  const r1 = await sync.syncNow();
  check("(b) syncNow succeeds with merge", r1.ok === true, JSON.stringify(r1).slice(0, 200));
  check("(b) merge stats present", !!r1.merged && r1.merged.addedFromRemote === 5, "merged=" + JSON.stringify(r1.merged));
  const uploaded = posts[posts.length - 1];
  const upToday = JSON.parse(uploaded.keys[NUTRI]).filter((e) => e.date === "2026-11-05");
  check("(a) uploaded payload has the Drive lunch", upToday.length === 7, "got " + upToday.length);
  const upEggs = upToday.find((e) => String(e.name).indexOf("Eggs") !== -1);
  check("(e) uploaded breakfast is 09:30", upEggs && upEggs.time === "09:30", "got " + (upEggs && upEggs.time));

  // (b) phone adds a dinner entry, then syncs again: it must survive.
  const nutriNow = JSON.parse(appStore.getItem(NUTRI));
  nutriNow.push({ id: 4242, date: "2026-11-05", time: "18:45", name: "Salmon and greens", protein: 35, fat: 18, carbs: 4, fiber: 2, netCarbs: 2, calories: 320 });
  appStore.setItem(NUTRI, JSON.stringify(nutriNow));
  const postsBefore = posts.length;
  const r2 = await sync.syncNow();
  const up2 = posts[posts.length - 1];
  const up2Today = JSON.parse(up2.keys[NUTRI]).filter((e) => e.date === "2026-11-05");
  check("(b) phone-added dinner survives the next sync", up2Today.some((e) => e.id === 4242), "today=" + up2Today.length);
  check("(b) lunch still present after phone add", up2Today.length === 8, "today=" + up2Today.length);
  check("(b) second sync posted once", posts.length === postsBefore + 1, "posts=" + posts.length);

  // (c) third sync with nothing new: payload identical, no dupes.
  const r3 = await sync.syncNow();
  const up3 = posts[posts.length - 1];
  check("(c) repeated sync is stable", eq(up3.keys[NUTRI], up2.keys[NUTRI]));
  check("(c) merge stats show nothing new on repeat", r3.merged && r3.merged.addedFromRemote === 0 && r3.merged.conflicts === 0, "merged=" + JSON.stringify(r3.merged));

  // (j) degraded mode: download fails -> upload-only still runs.
  async function failingFetch(url, opts) {
    if (opts && opts.method === "POST") {
      posts.push(JSON.parse(opts.body));
      return { text: async () => JSON.stringify({ ok: true, savedAt: "2026-11-05T16:05:00.000Z" }) };
    }
    throw new Error("network down");
  }
  const sync2 = client.create({
    backupText,
    storage: cfgStore,
    store: appStore,
    fetch: failingFetch,
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => new Date("2026-11-05T16:05:00Z"),
    onChange: () => {}
  });
  const postsBefore2 = posts.length;
  const r4 = await sync2.syncNow();
  check("(j) download failure still uploads (fallback)", r4.ok === true && posts.length === postsBefore2 + 1, "ok=" + r4.ok + " posts=" + posts.length);

  console.log("\n== " + passes + " passed, " + failures + " failed ==");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error("HARNESS ERROR", err);
  process.exit(2);
});
