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
      return syncJson_(syncBackupDownload_(latest.getBlob().getDataAsString("UTF-8")));
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

function syncPrune_(folder, today) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (syncShouldPrune(file.getName(), today, SYNC_KEEP_DAYS)) file.setTrashed(true);
  }
}
