/**
 * Checks the one-time strength package repair. Sample data only.
 */
import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/index.html";
function assert(c, m) { if (!c) throw new Error(m); }

const id = "t1";
const pkgs = [
  { id: 11, name: "Other · extra", exercises: ["Plank"] },
  { id: 4, name: "Upper B · pull (from Nov 8)", exercises: ["Neutral-Grip Lat Pulldown", "Rear Delt Raise", "Cable Row"], recWeights: { "Cable Row": 90 } },
  { id: 2, name: "Upper A · push", exercises: ["Bench Press", "Rear Delt Raise"] },
  { id: 3, name: "Lower B · hinge 2 (from Nov 8)", exercises: ["Barbell RDL", "Bench Press", "KB Swing"] },
  { id: 1, name: "Lower A · squat", exercises: ["Zercher Split Squat", "Spanish Squat", "Hip Abduction", "Calf Raises"] }
];
const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "" }]),
  mf_active_profile: JSON.stringify(id),
  mf_str_templates: JSON.stringify(pkgs),
  mf_kb_templates: JSON.stringify([{ id: 9, name: "KB one", exercises: ["KB Swing"] }]),
  mf_keepme: JSON.stringify("still here")
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
await page.addInitScript(d => {
  if (!localStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); localStorage.setItem("__seeded", "1"); }
}, seed);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

const read = k => page.evaluate(x => JSON.parse(localStorage.getItem(x)), k);
let t = await read("mf_str_templates");
assert(JSON.stringify(t.map(x => x.id)) === JSON.stringify([1, 2, 3, 4, 11]), "order " + JSON.stringify(t.map(x => x.name)));
const lb = t.find(x => x.id === 3);
assert(lb.name === "Lower B · hinge (from Nov 8)", lb.name);
assert(JSON.stringify(lb.exercises) === JSON.stringify(["Barbell RDL", "Step-Up (Slow Step-Down)", "Step Down", "Pallof Press", "Single-Arm KB RDL", "KB Snatch", "KB Swing"]), "lowerB ex");
const ub = t.find(x => x.id === 4);
assert(JSON.stringify(ub.exercises) === JSON.stringify(["Neutral-Grip Pulldown", "Rear-Delt Raise", "Cable Row"]), "upperB ex " + ub.exercises);
assert(ub.recWeights["Cable Row"] === 90, "recWeights kept");
const ua = t.find(x => x.id === 2);
assert(ua.exercises.includes("Rear Delt Raise"), "Upper A must be untouched");
const la = t.find(x => x.id === 1);
assert(JSON.stringify(la.exercises) === JSON.stringify(pkgs[4].exercises) && la.name === "Lower A · squat", "Lower A untouched");
const bk = await read("mf_str_templates_backup_pkgfix2");
assert(JSON.stringify(bk) === JSON.stringify(pkgs), "backup is the original array");
assert(await read("mf_pkg_repair_v2_done") === true, "flag set");
assert((await read("mf_kb_templates"))[0].name === "KB one", "kb templates untouched");
assert(await read("mf_keepme") === "still here", "other storage kept");
await page.getByText("Workout packages fixed").first().waitFor({ timeout: 6000 }); // the toast shows once

// second run does nothing: change a name, reload, still changed
await page.evaluate(() => { const a = JSON.parse(localStorage.getItem("mf_str_templates")); a[0].name = "Lower A · edited"; localStorage.setItem("mf_str_templates", JSON.stringify(a)); });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
t = await read("mf_str_templates");
assert(t[0].name === "Lower A · edited" && t.length === 5, "second run must not change anything");
assert(JSON.stringify(await read("mf_str_templates_backup_pkgfix2")) === JSON.stringify(pkgs), "backup not overwritten");
assert(errors.length === 0, errors.join("\n"));
await browser.close();
console.log("package-repair: OK");
