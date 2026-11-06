/**
 * MitoForge private Drive sync.
 *
 * Paste this whole file into a Google Apps Script project in the Google
 * account that should store the data. Deploy it as a web app that runs as
 * you. The sync token lives in Script Properties (SYNC_TOKEN), never in
 * this file and never in the Drive file.
 *
 * Setup steps: drive-sync/SETUP.md
 */

var SYNC_FOLDER_NAME = "Mitoforge";
var SYNC_KEEP_DAYS = 30;

// PURE_START
function syncLatestName() {
  return "MitoForge sync (latest).json";
}

function syncPlanName() {
  return "MitoForge next week plan.json";
}

function syncSnapshotName(day) {
  return "MitoForge sync " + day + ".json";
}

function syncDayString(date) {
  var y = date.getFullYear();
  var m = date.getMonth() + 1;
  var d = date.getDate();
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  return y + "-" + pad(m) + "-" + pad(d);
}

function syncAuthorize(presented, expected) {
  if (!expected) return { ok: false, error: "SYNC_TOKEN is not set in the script" };
  if (presented == null || String(presented) !== String(expected)) return { ok: false, error: "Bad token" };
  return { ok: true };
}

function syncParseBody(text) {
  var body;
  try { body = JSON.parse(text || ""); }
  catch (err) { return { ok: false, error: "Body is not JSON" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body is not JSON" };
  if (body.app !== "MitoForge" || !body.keys || typeof body.keys !== "object" || Array.isArray(body.keys)) {
    return { ok: false, error: "Not a MitoForge backup" };
  }
  return { ok: true, body: body };
}

function syncFileContents(body) {
  var keys = {};
  Object.keys(body.keys).forEach(function (k) {
    if (k.indexOf("mf_") === 0 && typeof body.keys[k] === "string") keys[k] = body.keys[k];
  });
  var out = {
    app: "MitoForge",
    schema: body.schema || 1,
    exportedAt: body.exportedAt || "",
    keys: keys
  };
  return JSON.stringify(out);
}

function syncShouldPrune(name, today, keepDays) {
  var match = /^MitoForge sync (\d{4})-(\d{2})-(\d{2})\.json$/.exec(name);
  if (!match) return false;
  var fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  var cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  cutoff.setDate(cutoff.getDate() - keepDays);
  return fileDate < cutoff;
}

function syncParsePlan(text) {
  if (text == null || text === "") return undefined;
  try { return JSON.parse(text); }
  catch (err) { return text; }
}

// Validate the stored latest file and shape it for download. The phone
// merges this with its own data instead of replacing it (see the
// two-way merge sync in drive-sync/sync-client.js).
function syncBackupDownload_(fileText) {
  if (fileText == null || fileText === "") return { ok: false, error: "No sync file yet" };
  var backup;
  try { backup = JSON.parse(fileText); }
  catch (err) { return { ok: false, error: "Sync file is not JSON" }; }
  if (!backup || backup.app !== "MitoForge" || !backup.keys || typeof backup.keys !== "object" || Array.isArray(backup.keys)) {
    return { ok: false, error: "Sync file is not a MitoForge backup" };
  }
  return { ok: true, backup: backup };
}
// ---- Inbox: entries dropped into Drive by a coach or another tool ----
// A file named "MitoForge inbox.json" in the sync folder holds
// {"app":"MitoForge","keys":{"mf_<profile>_log":[ {entry}, ... ], ...}}.
// Only keys that start with mf_ and hold a JSON list are used. When the
// phone asks for the latest backup, entries that are not already in it
// are added to the download (the stored file is not touched). When the
// phone next uploads and its data contains an entry, that entry is
// removed from the inbox. The phone's own merge does the rest, and it
// never deletes anything.
function syncInboxName() {
  return "MitoForge inbox.json";
}

function syncCanonical(value) {
  if (Array.isArray(value)) return "[" + value.map(syncCanonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ":" + syncCanonical(value[k]); }).join(",") + "}";
  }
  return JSON.stringify(value);
}

function syncEntryKey(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.id !== null && entry.id !== undefined) {
    return "id:" + String(entry.id);
  }
  return "v:" + syncCanonical(entry);
}

function syncAsList(value) {
  var v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (err) { return null; }
  }
  return Array.isArray(v) ? v : null;
}

function syncParseInbox(text) {
  if (text == null || text === "") return { ok: false, error: "No inbox" };
  var body;
  try { body = JSON.parse(text); }
  catch (err) { return { ok: false, error: "Inbox is not JSON" }; }
  if (!body || body.app !== "MitoForge" || !body.keys || typeof body.keys !== "object" || Array.isArray(body.keys)) {
    return { ok: false, error: "Inbox is not a MitoForge inbox" };
  }
  var keys = {};
  var ignored = 0;
  Object.keys(body.keys).forEach(function (k) {
    var list = k.indexOf("mf_") === 0 ? syncAsList(body.keys[k]) : null;
    if (list) keys[k] = list; else ignored++;
  });
  return { ok: true, keys: keys, ignored: ignored };
}

// Add inbox entries that the backup does not already hold. An inbox entry
// with the same id as one in the backup but different content replaces it
// in the download, and the phone's own merge then decides which version
// is more complete. Returns a new backup object; the input is not changed.
function syncApplyInbox(backup, inboxKeys) {
  var out = { app: backup.app, schema: backup.schema, exportedAt: backup.exportedAt, keys: {} };
  Object.keys(backup.keys).forEach(function (k) { out.keys[k] = backup.keys[k]; });
  var added = 0;
  var updated = 0;
  var touched = [];
  Object.keys(inboxKeys).forEach(function (k) {
    var have = k in out.keys ? syncAsList(out.keys[k]) : [];
    if (have === null) return; // the backup holds something other than a list here
    have = have.slice();
    var index = {};
    have.forEach(function (item, i) { if (!(syncEntryKey(item) in index)) index[syncEntryKey(item)] = i; });
    var changed = false;
    inboxKeys[k].forEach(function (item) {
      var id = syncEntryKey(item);
      if (!(id in index)) {
        index[id] = have.length;
        have.push(item);
        added++;
        changed = true;
      } else if (syncCanonical(have[index[id]]) !== syncCanonical(item)) {
        have[index[id]] = item;
        updated++;
        changed = true;
      }
    });
    if (changed) {
      out.keys[k] = JSON.stringify(have);
      touched.push(k);
    }
  });
  return { backup: out, added: added, updated: updated, touched: touched };
}

// Which inbox entries are still not in the data the phone just uploaded.
function syncInboxRemaining(inboxKeys, uploadedKeys) {
  var keys = {};
  var count = 0;
  Object.keys(inboxKeys).forEach(function (k) {
    var have = k in uploadedKeys ? syncAsList(uploadedKeys[k]) : [];
    var seen = {};
    (have || []).forEach(function (item) { seen[syncEntryKey(item)] = true; });
    var left = have === null ? inboxKeys[k] : inboxKeys[k].filter(function (item) { return !seen[syncEntryKey(item)]; });
    if (left.length) { keys[k] = left; count += left.length; }
  });
  return { keys: keys, count: count };
}
// PURE_END

function doPost(e) {
  try {
    var parsed = syncParseBody(e && e.postData && e.postData.contents);
    if (!parsed.ok) return syncJson_(parsed);
    var auth = syncAuthorize(parsed.body.token, syncExpectedToken_());
    if (!auth.ok) return syncJson_(auth);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var savedAt = new Date().toISOString();
      var contents = syncFileContents(parsed.body);
      var folder = syncFolder_();
      syncWrite_(folder, syncLatestName(), contents);
      syncWrite_(folder, syncSnapshotName(syncDayString(new Date())), contents);
      syncPrune_(folder, new Date());
      syncConsumeInbox_(folder, parsed.body.keys);
      return syncJson_({ ok: true, savedAt: savedAt });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return syncJson_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  try {
    var token = e && e.parameter ? e.parameter.token : "";
    var auth = syncAuthorize(token, syncExpectedToken_());
    if (!auth.ok) return syncJson_(auth);
    var out = { ok: true };
    var folder = syncFolder_();
    if (e && e.parameter && e.parameter.download === "latest") {
      var latest = syncFind_(folder, syncLatestName());
      if (!latest) return syncJson_({ ok: false, error: "No sync file yet" });
      var down = syncBackupDownload_(latest.getBlob().getDataAsString("UTF-8"));
      if (down.ok) {
        var inbox = syncFind_(folder, syncInboxName());
        if (inbox) {
          var parsedInbox = syncParseInbox(inbox.getBlob().getDataAsString("UTF-8"));
          if (parsedInbox.ok) {
            var applied = syncApplyInbox(down.backup, parsedInbox.keys);
            down.backup = applied.backup;
            down.inboxAdded = applied.added;
            down.inboxUpdated = applied.updated;
          }
        }
      }
      return syncJson_(down);
    }
    var plan = syncFind_(folder, syncPlanName());
    if (plan) out.plan = syncParsePlan(plan.getBlob().getDataAsString("UTF-8"));
    return syncJson_(out);
  } catch (err) {
    return syncJson_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * One-time helper. Run this from the editor if you would rather not type
 * a token yourself. It refuses to replace a token that is already set.
 * Copy the value from the execution log, paste it into MitoForge, then
 * close the log.
 */
function createSyncToken() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("SYNC_TOKEN")) {
    throw new Error("SYNC_TOKEN is already set. It was not changed or printed. Delete that Script property first if you really want a new token.");
  }
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  props.setProperty("SYNC_TOKEN", token);
  Logger.log(token);
}

function syncExpectedToken_() {
  return PropertiesService.getScriptProperties().getProperty("SYNC_TOKEN");
}

function syncJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function syncFolder_() {
  var root = DriveApp.getRootFolder();
  var found = root.getFoldersByName(SYNC_FOLDER_NAME);
  if (found.hasNext()) return found.next();
  return root.createFolder(SYNC_FOLDER_NAME);
}

function syncFind_(folder, name) {
  var files = folder.getFilesByName(name);
  return files.hasNext() ? files.next() : null;
}

function syncWrite_(folder, name, contents) {
  var existing = syncFind_(folder, name);
  if (existing) {
    existing.setContent(contents);
    return existing;
  }
  // DriveApp's MimeType enum has no JSON member. A mime type string is valid here.
  return folder.createFile(name, contents, "application/json");
}

// After an upload, drop inbox entries the phone now holds. Never throws:
// a problem here must not fail the sync itself.
function syncConsumeInbox_(folder, uploadedKeys) {
  try {
    var inbox = syncFind_(folder, syncInboxName());
    if (!inbox) return;
    var parsed = syncParseInbox(inbox.getBlob().getDataAsString("UTF-8"));
    if (!parsed.ok) return;
    var left = syncInboxRemaining(parsed.keys, uploadedKeys);
    if (left.count === 0) {
      inbox.setName("MitoForge inbox done " + new Date().toISOString() + ".json");
    } else {
      inbox.setContent(JSON.stringify({ app: "MitoForge", keys: left.keys }));
    }
  } catch (err) {}
}

function syncPrune_(folder, today) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (syncShouldPrune(file.getName(), today, SYNC_KEEP_DAYS)) file.setTrashed(true);
  }
}
