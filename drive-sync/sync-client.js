/**
 * Browser side of MitoForge Drive sync.
 * Talks only to the web app URL the user saved on this device.
 * Loaded as a classic script; also require()-able from node tests.
 *
 * Two-way merge sync: every sync first downloads the latest backup from
 * Drive, unions its entries with the phone's data by entry id (merge, never
 * wholesale replace), then uploads the merged state. Entries added on
 * either side survive; a same-id conflict keeps the more complete version,
 * or the Drive version on a tie. If the download fails (for example the
 * web app has not been redeployed with the download endpoint yet), the
 * sync falls back to the old upload-only behaviour and keeps going.
 * The menu "Restore from a backup" still does a wholesale replace and is
 * unchanged; it remains the manual fallback.
 */
(function (root) {
  var CFG_KEY = "mitoforge_sync_cfg";
  var DEBOUNCE_MS = 15000;
  var OPEN_DELAY_MS = 2000;
  var KEEPALIVE_MAX = 60000;

  function emptyConfig() {
    return { url: "", token: "", enabled: false, lastOkAt: "", lastError: "", lastSavedAt: "" };
  }

  function normalizeUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    var url;
    try { url = new URL(raw); }
    catch (err) { return ""; }
    var host = url.hostname;
    var local = host === "localhost" || host === "127.0.0.1";
    if (url.username || url.password) return "";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
    url.hash = "";
    return url.toString();
  }

  function byteLength(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    return String(text).length;
  }

  /* ---------- merge (pure; also used by node tests) ---------- */

  // Stable string form, used both as an identity for entries without an
  // id and to compare two versions of the same entry.
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ":" + canonical(value[k]); }).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  function isNonEmpty(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v !== "";
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true; // numbers (including 0) and booleans (including false) count
  }

  // How many fields of an entry actually carry a value. Only used to break
  // same-id conflicts; entries are otherwise never rewritten.
  function completeness(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return isNonEmpty(entry) ? 1 : 0;
    var n = 0;
    Object.keys(entry).forEach(function (k) { if (isNonEmpty(entry[k])) n++; });
    return n;
  }

  function entryIdentity(entry) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.id !== null && entry.id !== undefined) {
      return "id:" + String(entry.id);
    }
    return "v:" + canonical(entry);
  }

  // Same id, different content. The more complete version wins; on a tie
  // the Drive (remote) version wins, so an edit made in Drive is never
  // silently reverted by the phone's older copy.
  function resolveConflict(localEntry, remoteEntry) {
    if (canonical(localEntry) === canonical(remoteEntry)) return { entry: localEntry, winner: "same" };
    var lc = completeness(localEntry), rc = completeness(remoteEntry);
    if (rc > lc) return { entry: remoteEntry, winner: "remote" };
    if (lc > rc) return { entry: localEntry, winner: "local" };
    return { entry: remoteEntry, winner: "remote-tie" };
  }

  // Union two entry arrays by identity. Local order is kept; entries only
  // on the Drive side are appended in Drive order. Repeating the merge is
  // a no-op: no duplicates, no rewrites.
  function mergeEntryArrays(localArr, remoteArr) {
    var index = {};
    var merged = [];
    var stats = { addedFromRemote: 0, conflicts: 0, remoteWins: 0, localWins: 0 };
    function addLocal(item) {
      var key = entryIdentity(item);
      if (key in index) return; // de-dupe within the phone's own list
      index[key] = merged.length;
      merged.push(item);
    }
    localArr.forEach(addLocal);
    remoteArr.forEach(function (item) {
      var key = entryIdentity(item);
      if (!(key in index)) {
        index[key] = merged.length;
        merged.push(item);
        stats.addedFromRemote++;
        return;
      }
      var res = resolveConflict(merged[index[key]], item);
      if (res.winner !== "same") {
        stats.conflicts++;
        if (res.winner === "remote" || res.winner === "remote-tie") stats.remoteWins++;
        else stats.localWins++;
        merged[index[key]] = res.entry;
      }
    });
    return { merged: merged, stats: stats };
  }

  // Merge one stored value (a JSON string) with its Drive twin. Arrays
  // merge by entry identity. Anything else is phone-owned state (settings,
  // plans, scalars) and the phone's value is kept unchanged.
  function mergeKeyValue(localStr, remoteStr) {
    var localVal, remoteVal;
    try { localVal = JSON.parse(localStr); } catch (e) { return { value: localStr, changed: false, stats: null }; }
    try { remoteVal = JSON.parse(remoteStr); } catch (e) { return { value: localStr, changed: false, stats: null }; }
    if (!Array.isArray(localVal) || !Array.isArray(remoteVal)) {
      return { value: localStr, changed: false, stats: null };
    }
    var r = mergeEntryArrays(localVal, remoteVal);
    var out = JSON.stringify(r.merged);
    return { value: out, changed: out !== localStr, stats: r.stats };
  }

  // Merge two whole key maps (phone state vs Drive backup keys). Keys
  // present on only one side are kept as-is; nothing is ever deleted.
  function mergeKeyMaps(localKeys, remoteKeys) {
    var merged = {};
    var stats = { keysMerged: 0, addedFromRemote: 0, addedFromLocal: 0, conflicts: 0, remoteWins: 0, localWins: 0, keysAdded: [] };
    var seen = {};
    Object.keys(localKeys).forEach(function (k) { seen[k] = true; });
    Object.keys(remoteKeys).forEach(function (k) { seen[k] = true; });
    Object.keys(seen).forEach(function (k) {
      var inLocal = Object.prototype.hasOwnProperty.call(localKeys, k);
      var inRemote = Object.prototype.hasOwnProperty.call(remoteKeys, k);
      if (inLocal && !inRemote) { merged[k] = localKeys[k]; stats.addedFromLocal++; return; }
      if (!inLocal && inRemote) { merged[k] = remoteKeys[k]; stats.addedFromRemote++; stats.keysAdded.push(k); return; }
      var r = mergeKeyValue(localKeys[k], remoteKeys[k]);
      merged[k] = r.value;
      if (r.stats) {
        stats.keysMerged++;
        stats.addedFromRemote += r.stats.addedFromRemote;
        stats.conflicts += r.stats.conflicts;
        stats.remoteWins += r.stats.remoteWins;
        stats.localWins += r.stats.localWins;
      }
    });
    return { keys: merged, stats: stats };
  }

  function createMitoForgeDriveSync(deps) {
    if (!deps || typeof deps.backupText !== "function" || !deps.storage || typeof deps.fetch !== "function") {
      throw new Error("Drive sync is missing backup, storage, or fetch");
    }
    var setTimer = deps.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = deps.clearTimer || function (id) { clearTimeout(id); };
    var now = deps.now || function () { return new Date(); };
    var timer = null;
    var inflight = null;
    var queued = false;
    var merging = false; // true while applyMerge writes, so those writes do not re-trigger a sync
    var appStore = deps.store || deps.storage; // where merged keys are written (mfStore when wired, else localStorage)

    function read() {
      try {
        var raw = deps.storage.getItem(CFG_KEY);
        if (!raw) return emptyConfig();
        var o = JSON.parse(raw);
        if (!o || typeof o !== "object" || Array.isArray(o)) return emptyConfig();
        return {
          url: String(o.url || ""),
          token: String(o.token || ""),
          enabled: !!o.enabled,
          lastOkAt: String(o.lastOkAt || ""),
          lastError: String(o.lastError || ""),
          lastSavedAt: String(o.lastSavedAt || "")
        };
      } catch (err) {
        return emptyConfig();
      }
    }

    function write(cfg) {
      deps.storage.setItem(CFG_KEY, JSON.stringify(cfg));
      if (typeof deps.onChange === "function") deps.onChange(cfg);
      return cfg;
    }

    function configured(cfg) {
      return !!(cfg && cfg.enabled && cfg.url && cfg.token);
    }

    function buildPayload(token) {
      var text = deps.backupText();
      var body = JSON.parse(text);
      if (!body || body.app !== "MitoForge" || body.error || !body.keys || typeof body.keys !== "object") {
        throw new Error(body && body.error ? String(body.error) : "Could not read MitoForge data");
      }
      body.token = token;
      return body;
    }

    function remember(patch) {
      var cfg = read();
      Object.keys(patch).forEach(function (k) { cfg[k] = patch[k]; });
      return write(cfg);
    }

    function endpoint(url, token) {
      var join = url.indexOf("?") === -1 ? "?" : "&";
      return url + join + "token=" + encodeURIComponent(token);
    }

    async function readJson(res) {
      if (!res || res.type === "opaque") throw new Error("opaque");
      var text = await res.text();
      try { return JSON.parse(text); }
      catch (err) { return null; }
    }

    async function postBody(url, bodyStr, keepalive) {
      var opts = {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: bodyStr,
        redirect: "follow"
      };
      if (keepalive) opts.keepalive = true;
      try {
        var res = await deps.fetch(url, opts);
        var data = await readJson(res);
        if (!data) return { ok: false, error: "Drive sync returned an unreadable reply" };
        if (data.ok) return { ok: true, savedAt: data.savedAt || now().toISOString(), confirmed: true };
        return { ok: false, error: data.error || "Sync was rejected" };
      } catch (err) {
        if (keepalive) return postBody(url, bodyStr, false);
        try {
          await deps.fetch(url, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: bodyStr,
            redirect: "follow"
          });
        } catch (sendErr) {
          return { ok: false, error: "Offline or the Web app could not be reached" };
        }
        return { ok: false, unconfirmed: true };
      }
    }

    async function confirmGet(url, token) {
      try {
        var res = await deps.fetch(endpoint(url, token), { method: "GET", redirect: "follow" });
        var data = await readJson(res);
        if (data && data.ok) return { ok: true };
        return { ok: false, error: (data && data.error) || "Drive sync did not confirm" };
      } catch (err) {
        return { ok: false, error: "Offline or the Web app could not be reached" };
      }
    }

    // Download the latest backup from Drive. The web app only returns it
    // when asked with download=latest; a plain GET still only confirms the
    // connection (and returns the coach's plan), as before.
    async function pullLatest(cfg) {
      try {
        var url = endpoint(cfg.url, cfg.token) + "&download=latest";
        var res = await deps.fetch(url, { method: "GET", redirect: "follow" });
        var data = await readJson(res);
        if (!data) return { ok: false, error: "Drive sync returned an unreadable reply" };
        if (!data.ok) return { ok: false, error: data.error || "Drive sync did not confirm" };
        if (!data.backup || data.backup.app !== "MitoForge" || !data.backup.keys || typeof data.backup.keys !== "object") {
          return { ok: false, error: "Drive sync did not return a backup" };
        }
        return { ok: true, backup: data.backup };
      } catch (err) {
        return { ok: false, error: "Offline or the Web app could not be reached" };
      }
    }

    // Merge a downloaded backup into the phone's store. Only keys whose
    // merged value differs are written, and nothing is deleted.
    function applyMerge(backup) {
      var localText = deps.backupText();
      var localBody = JSON.parse(localText);
      if (!localBody || !localBody.keys || typeof localBody.keys !== "object") {
        throw new Error("Could not read MitoForge data");
      }
      var r = mergeKeyMaps(localBody.keys, backup.keys || {});
      merging = true;
      try {
        Object.keys(r.keys).forEach(function (k) {
          if (r.keys[k] !== localBody.keys[k]) appStore.setItem(k, r.keys[k]);
        });
      } finally {
        merging = false;
      }
      if (typeof deps.onChange === "function") deps.onChange();
      return r.stats;
    }

    async function syncNow(opts) {
      opts = opts || {};
      var cfg = read();
      if (!configured(cfg)) return { ok: false, skipped: true };
      if (inflight) {
        queued = true;
        return inflight;
      }
      inflight = run(cfg, opts).finally(function () {
        inflight = null;
        if (queued) {
          queued = false;
          schedule(1000);
        }
      });
      return inflight;
    }

    async function run(cfg, opts) {
      var mergeStats = null;
      if (!opts.skipPull) {
        var pulled = await pullLatest(cfg);
        if (pulled.ok && pulled.backup) {
          try {
            mergeStats = applyMerge(pulled.backup);
          } catch (err) {
            remember({ lastError: "Merge failed: " + (err.message || err) });
            return { ok: false, error: err.message };
          }
        } else {
          // Download unavailable (for example the web app has not been
          // redeployed with the download endpoint yet). Fall back to the
          // old upload-only behaviour instead of losing the phone's edits.
          remember({ lastError: pulled.error || "Could not download latest backup" });
        }
      }
      // A merge just rewrote local state, so a payload built before the
      // merge would upload stale data. Rebuild it from the merged state.
      if (mergeStats) opts.payload = null;
      var payload;
      try {
        payload = opts.payload || buildPayload(cfg.token);
      } catch (err) {
        remember({ lastError: err.message || "Could not read MitoForge data" });
        return { ok: false, error: err.message };
      }
      var bodyStr = JSON.stringify(payload);
      var keepalive = !!opts.keepalive && byteLength(bodyStr) <= KEEPALIVE_MAX;
      var posted = await postBody(cfg.url, bodyStr, keepalive);
      if (posted.unconfirmed) {
        var check = await confirmGet(cfg.url, cfg.token);
        if (!check.ok) {
          remember({ lastError: check.error });
          return { ok: false, error: check.error };
        }
        var stamped = now().toISOString();
        remember({ lastOkAt: stamped, lastSavedAt: stamped, lastError: "" });
        return { ok: true, savedAt: stamped, confirmed: false, merged: mergeStats };
      }
      if (!posted.ok) {
        remember({ lastError: posted.error || "Sync failed" });
        return posted;
      }
      remember({ lastOkAt: now().toISOString(), lastSavedAt: posted.savedAt || "", lastError: "" });
      if (mergeStats) posted.merged = mergeStats;
      return posted;
    }

    function schedule(ms) {
      var cfg = read();
      if (!configured(cfg)) return;
      if (timer != null) clearTimer(timer);
      timer = setTimer(function () {
        timer = null;
        syncNow().catch(function () {});
      }, ms);
    }

    function noteDataWrite(key) {
      if (merging) return;
      if (typeof key === "string" && key.indexOf("mf_") !== 0) return;
      schedule(DEBOUNCE_MS);
    }

    function installStore(store) {
      if (!store || store.__mfSyncWrapped) return;
      var origSet = store.setItem;
      var origRemove = store.removeItem;
      store.setItem = function (key, value) {
        var result = origSet.apply(store, arguments);
        noteDataWrite(key);
        return result;
      };
      store.removeItem = function (key) {
        var result = origRemove.apply(store, arguments);
        noteDataWrite(key);
        return result;
      };
      store.__mfSyncWrapped = true;
    }

    function save(input) {
      input = input || {};
      var current = read();
      var url = normalizeUrl(input.url != null ? input.url : current.url);
      var token = input.token != null && String(input.token).trim() ? String(input.token).trim() : current.token;
      if (!url) return { ok: false, error: "Enter the Web app URL that ends in /exec" };
      if (!token) return { ok: false, error: "Enter the sync token" };
      var cfg = write({
        url: url,
        token: token,
        enabled: true,
        lastOkAt: current.lastOkAt,
        lastError: "",
        lastSavedAt: current.lastSavedAt
      });
      return { ok: true, config: cfg };
    }

    function disable() {
      var current = read();
      current.enabled = false;
      write(current);
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      return read();
    }

    async function test(input) {
      input = input || {};
      var current = read();
      var url = normalizeUrl(input.url != null && String(input.url).trim() ? input.url : current.url);
      var token = input.token != null && String(input.token).trim() ? String(input.token).trim() : current.token;
      if (!url || !token) return { ok: false, error: "Save a Web app URL and token first" };
      return confirmGet(url, token);
    }

    function armOpenSync() {
      schedule(OPEN_DELAY_MS);
    }

    function onHidden() {
      var cfg = read();
      if (!configured(cfg)) return { ok: false, skipped: true };
      var payload;
      try { payload = buildPayload(cfg.token); }
      catch (err) { return { ok: false, error: err.message }; }
      var bytes = byteLength(JSON.stringify(payload));
      if (bytes > KEEPALIVE_MAX) return { ok: false, skipped: true, reason: "too-large-for-keepalive" };
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      return syncNow({ keepalive: true, payload: payload, skipPull: true });
    }

    return {
      get: read,
      save: save,
      disable: disable,
      buildPayload: function () { return buildPayload(read().token); },
      noteDataWrite: noteDataWrite,
      installStore: installStore,
      syncNow: syncNow,
      test: test,
      armOpenSync: armOpenSync,
      onHidden: onHidden,
      normalizeUrl: normalizeUrl
    };
  }

  var api = {
    create: createMitoForgeDriveSync,
    CFG_KEY: CFG_KEY,
    DEBOUNCE_MS: DEBOUNCE_MS,
    OPEN_DELAY_MS: OPEN_DELAY_MS,
    KEEPALIVE_MAX: KEEPALIVE_MAX,
    normalizeUrl: normalizeUrl,
    byteLength: byteLength,
    canonical: canonical,
    completeness: completeness,
    resolveConflict: resolveConflict,
    mergeEntryArrays: mergeEntryArrays,
    mergeKeyValue: mergeKeyValue,
    mergeKeyMaps: mergeKeyMaps
  };
  root.createMitoForgeDriveSync = createMitoForgeDriveSync;
  root.MitoForgeSyncClient = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
