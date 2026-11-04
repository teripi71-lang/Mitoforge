/**
 * Browser side of MitoForge Drive sync.
 * Talks only to the web app URL the user saved on this device.
 * Loaded as a classic script; also require()-able from node tests.
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
        return { ok: true, savedAt: stamped, confirmed: false };
      }
      if (!posted.ok) {
        remember({ lastError: posted.error || "Sync failed" });
        return posted;
      }
      remember({ lastOkAt: now().toISOString(), lastSavedAt: posted.savedAt || "", lastError: "" });
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
      return syncNow({ keepalive: true, payload: payload });
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
    byteLength: byteLength
  };
  root.createMitoForgeDriveSync = createMitoForgeDriveSync;
  root.MitoForgeSyncClient = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
