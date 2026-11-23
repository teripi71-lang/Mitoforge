/**
 * One-time strength package repair. Invented packages and a fake log.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/index.html";
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const id = "t1";
const original = [
  { id: "ub", name: "Upper B · pull (from Nov 8)", exercises: ["Neutral-Grip Lat Pulldown", "Chest Supported Row", "Rear Delt Raise"], recWeights: { "Neutral-Grip Lat Pulldown": "80" } },
  { id: "core2", name: "KB Core 2", exercises: ["KB Swing"] },
  { id: "lb2", name: "Lower B · hinge 2 (from Nov 8)", exercises: ["Neutral-Grip Pulldown", "Rear-Delt Raise"], recWeights: { "Neutral-Grip Pulldown": "70" } },
  { id: "carlsbad", name: "Carlsbad KB workout", exercises: ["KB Snatch"] },
  { id: "la", name: "Lower A · squat (from Nov 8)", exercises: ["Zercher Squat", "Zercher Split Squat"], recWeights: { "Zercher Split Squat": "95" } },
  { id: "ua", name: "Upper A · press (from Nov 8)", exercises: ["Neutral-Grip DB Bench", "Landmine Press"] }
];
const raw = JSON.stringify(original);
const log = [
  { id: 1, type: "strength", date: "2026-11-10", circuitItems: [{ exercise: "BB RDL" }, { exercise: "Neutral-Grip Lat Pulldown" }, { exercise: "Rear Delt Raise" }, { exercise: "Zercher Split Squat" }] },
  { id: 2, type: "strength", date: "2026-11-16", circuitItems: [{ exercise: "Split Squat" }] },
  { id: 3, type: "strength", date: "2026-11-20", circuitItems: [
    { exercise: "Barbell RDL" },
    { exercise: "Step-Up (Slow Step-Down)" },
    { exercise: "Pallof Press" },
    { exercise: "Single-Arm KB RDL" },
    { exercise: "KB Snatch" },
    { exercise: "KB Swing" },
    { exercise: "Neutral-Grip Pulldown" },
    { exercise: "Rear-Delt Raise" }
  ] }
];
const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "" }]),
  mf_active_profile: JSON.stringify(id),
  mf_str_templates: raw,
  [`mf_${id}_log`]: JSON.stringify(log)
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
await page.addInitScript(data => { for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v); }, seed);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.getByText("Your workout packages were repaired. Old copy saved.").waitFor({ timeout: 8000 });

const after = await page.evaluate(() => ({
  templates: JSON.parse(localStorage.getItem("mf_str_templates")),
  backup: localStorage.getItem("mf_str_templates_backup_pkgfix1"),
  flag: localStorage.getItem("mf_pkg_repair_v1_done"),
  build: window.mfParseBuildLabel(document.documentElement.innerHTML)
}));
assert(after.backup === raw, "backup was not the original value");
assert(after.flag === "true", "flag " + after.flag);
assert(after.build === "Build 44.6 · Nov 16", after.build);
const names = after.templates.map(t => t.name);
assert(JSON.stringify(names) === JSON.stringify([
  "Lower A · squat (from Nov 8)",
  "Upper A · press (from Nov 8)",
  "Lower B · hinge (from Nov 8)",
  "Upper B · pull (from Nov 8)",
  "KB Core 2",
  "Carlsbad KB workout"
]), JSON.stringify(names));
const byId = Object.fromEntries(after.templates.map(t => [t.id, t]));
assert(byId.lb2.id === "lb2", "lower B id changed");
assert(JSON.stringify(byId.lb2.exercises) === JSON.stringify(["Barbell RDL", "Step-Up (Slow Step-Down)", "Pallof Press", "Single-Arm KB RDL", "KB Snatch", "KB Swing"]), JSON.stringify(byId.lb2.exercises));
assert(JSON.stringify(byId.ub.exercises) === JSON.stringify(["Neutral-Grip Pulldown", "Chest Supported Row", "Rear-Delt Raise"]), JSON.stringify(byId.ub.exercises));
assert(byId.ub.recWeights["Neutral-Grip Pulldown"] === "80", JSON.stringify(byId.ub.recWeights));
assert(JSON.stringify(byId.la.exercises) === JSON.stringify(["Zercher Squat", "Split Squat"]), JSON.stringify(byId.la.exercises));
assert(byId.la.recWeights["Split Squat"] === "95", JSON.stringify(byId.la.recWeights));
assert(JSON.stringify(byId.ua.exercises) === JSON.stringify(["Neutral-Grip DB Bench", "Landmine Press"]), "upper A changed");
assert(JSON.stringify(byId.core2.exercises) === JSON.stringify(["KB Swing"]), "other package changed");

const second = await page.evaluate(() => {
  const before = localStorage.getItem("mf_str_templates_backup_pkgfix1");
  const again = window.mfRepairStrPackages();
  return { again, backup: localStorage.getItem("mf_str_templates_backup_pkgfix1"), same: before === localStorage.getItem("mf_str_templates_backup_pkgfix1"), templates: localStorage.getItem("mf_str_templates") };
});
assert(second.again.changed === false, "second run changed data");
assert(second.same, "backup was overwritten");

const page2 = await browser.newPage();
await page2.addInitScript(() => {
  localStorage.setItem("mf_onboarding_complete", "complete");
  localStorage.setItem("mf_interface_mode", "advanced");
  localStorage.setItem("mf_profiles", JSON.stringify([{ id: "t1", name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "" }]));
  localStorage.setItem("mf_active_profile", JSON.stringify("t1"));
  localStorage.setItem("mf_str_templates", JSON.stringify([{ id: "x", name: "Core", exercises: ["Plank"] }]));
});
await page2.goto(BASE, { waitUntil: "domcontentloaded" });
await page2.waitForTimeout(400);
const untouched = await page2.evaluate(() => ({
  templates: localStorage.getItem("mf_str_templates"),
  backup: localStorage.getItem("mf_str_templates_backup_pkgfix1"),
  flag: localStorage.getItem("mf_pkg_repair_v1_done")
}));
assert(untouched.backup == null && untouched.flag == null, JSON.stringify(untouched));
assert(JSON.parse(untouched.templates)[0].name === "Core", untouched.templates);

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
console.log("package repair checks passed");
console.log(JSON.stringify(after.templates.map(t => ({ name: t.name, exercises: t.exercises })), null, 2));
