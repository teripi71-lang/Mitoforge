/**
 * Phone-sized check of coach errors, the Drive backup line, the update helper, and the HIIT top block.
 * Sample profile only. No personal data.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts";
const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/index.html";
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const id = "t1";
const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "" }]),
  mf_active_profile: JSON.stringify(id),
  [`mf_${id}_log`]: JSON.stringify([{ id: 1, type: "cardio", date: "2026-11-21", exercise: "Bike", duration: 30, isZ2: true, sets: [] }])
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
await page.addInitScript(data => { for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v); }, seed);
await mkdir(OUT, { recursive: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });

const kinds = await page.evaluate(() => {
  const e = window.mfExplainAIError;
  return {
    off: e(new TypeError("Failed to fetch")).kind,
    timeout: e({ name: "AbortError" }).kind,
    key: e({ code: "bad_key", status: 401 }).kind,
    missing: e({ code: "no_key" }).kind,
    quota: e({ code: "rate_limited", status: 429 }).kind,
    server: e({ code: "upstream_error", status: 500, detail: "{\"raw\":true}" }).message,
    detail: e({ code: "upstream_error", detail: "{\"raw\":true}" }).detail,
    build: window.mfParseBuildLabel('const MF_BUILD_LABEL = "Build 45 · Nov 25";')
  };
});
assert(kinds.off === "offline" && kinds.timeout === "timeout", JSON.stringify(kinds));
assert(kinds.key === "key" && kinds.missing === "key" && kinds.quota === "quota", JSON.stringify(kinds));
assert(!/\{/.test(kinds.detail), kinds.detail);
assert(kinds.build === "Build 45 · Nov 25", kinds.build);

await page.getByTestId("drive-backup").waitFor();
let backup = await page.getByTestId("drive-backup").innerText();
assert(/Drive Sync not set up/.test(backup), backup);
await page.evaluate(() => {
  const t = new Date(Date.now() - 2 * 86400000).toISOString();
  localStorage.setItem("mitoforge_sync_cfg", JSON.stringify({ url: "https://example.com/exec", token: "t", enabled: true, lastOkAt: t, lastError: "", lastSavedAt: t }));
  window.dispatchEvent(new Event("mf-sync-changed"));
});
await page.waitForTimeout(200);
const color = await page.getByTestId("drive-backup").evaluate(el => getComputedStyle(el).color);
backup = await page.getByTestId("drive-backup").innerText();
assert(/Drive backup:/.test(backup), backup);
assert(color !== "rgb(0, 0, 0)", color);
await page.screenshot({ path: path.join(OUT, "b45-01-backup.png") });

await page.locator(".nav-btn").filter({ hasText: /Workout|HIIT/ }).click();
await page.locator(".workout-sub-btn", { hasText: "HIIT" }).click();
const top = page.getByTestId("hiit-top");
await top.waitFor();
const box = await top.boundingBox();
assert(box && box.y + box.height < 844, "HIIT heart rate and start should be on the first screen " + JSON.stringify(box));
await page.getByTestId("hiit-start").waitFor();
await page.getByTestId("hr-graph-card").waitFor();
await page.screenshot({ path: path.join(OUT, "b45-02-hiit.png") });

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
console.log("batch 45 checks passed");
