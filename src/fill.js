// Injected into the page (and loadable in Node for fill.test.js). Fills empty form fields from the profile.
// Top-level `var`, not `const`: the file may be injected into the same page more than once.

// autocomplete tokens (https://html.spec.whatwg.org/#autofill) -> profile keys. Most reliable signal, checked first.
var AUTOCOMPLETE = {
  "given-name": "first_name", "family-name": "last_name", name: "full_name", email: "email",
  tel: "phone", "tel-national": "phone", url: "website", "street-address": "street", "address-line1": "street",
  "postal-code": "postal_code", "address-level2": "city", country: "country", "country-name": "country",
};

// Fields that look like ours but are not about the applicant.
var SKIP = /company|firma|employer|arbeitgeber|school|universit|reference|referral|recruiter|user.?name|login|password|salary|gehalt|line.?2|zusatz/;

// Label/name/placeholder heuristics, English + German. Order matters: first match wins.
var RULES = [
  [/first.?name|given.?name|vorname/, "first_name"],
  [/last.?name|sur.?name|family.?name|nachname/, "last_name"],
  [/e.?mail/, "email"],
  [/phone|mobile|\btel\b|telefon|handy|mobil/, "phone"],
  [/linkedin|website|portfolio|homepage|\burl\b/, "website"],
  [/zip|postal|post.?code|\bplz\b|postleitzahl/, "postal_code"],
  [/\bcity\b|\btown\b|\bort\b|\bstadt\b|wohnort/, "city"],
  [/country|\bland\b/, "country"],
  [/street|address|stra(ss|ß)e|adresse|anschrift/, "street"],
  [/full.?name|your.?name|\bname\b/, "full_name"],
];

var TYPES = { email: "email", tel: "phone", url: "website" };

function jobTrackerClassify({ autocomplete = "", hint = "", type = "" }) {
  const token = autocomplete.trim().toLowerCase().split(/\s+/).pop();
  if (AUTOCOMPLETE[token]) return AUTOCOMPLETE[token];
  const h = hint.toLowerCase().replace(/[_\-[\]]+/g, " ");
  if (SKIP.test(h)) return null;
  for (const [re, key] of RULES) if (re.test(h)) return key;
  return TYPES[type] ?? null;
}

var jobTrackerText = (el) => el?.textContent ?? "";
var jobTrackerHint = (el) => [
  ...Array.from(el.labels ?? [], jobTrackerText),
  el.getAttribute("aria-label"),
  ...(el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => jobTrackerText(document.getElementById(id))),
  el.placeholder, el.name, el.id,
].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

// Labelled groups (ARIA role=group, fieldset) around el, outermost first: "Berufserfahrung › Berufserfahrung 1 › Von".
// Workday labels its date inputs only "Month"/"Year"; the groups say whose and which date.
var GROUP = "[role=group][aria-labelledby], fieldset";
var jobTrackerGroupLabel = (g) => g.tagName === "FIELDSET" ? g.querySelector("legend")
  : document.getElementById(g.getAttribute("aria-labelledby").split(/\s+/)[0]);
function jobTrackerContext(el) {
  const parts = [];
  for (let g = el.parentElement?.closest(GROUP); g; g = g.parentElement?.closest(GROUP)) {
    const label = jobTrackerText(jobTrackerGroupLabel(g)).replace(/\s+/g, " ").trim();
    if (label) parts.unshift(label);
  }
  return parts.join(" › ");
}

// Repeating sections ("Berufserfahrung", "Ausbildung") only get fields once "Hinzufügen" is clicked. Clicks it until
// the section has as many entries as the profile. Returns how many entries were added.
async function jobTrackerExpand({ experience = 0, education = 0 }) {
  const wanted = [[/experience|erfahrung/i, experience], [/education|ausbildung|studium/i, education]];
  let added = 0;
  for (const section of document.querySelectorAll("[role=group][aria-labelledby]")) {
    const parentGroup = (el) => el.parentElement?.closest("[role=group][aria-labelledby]");
    const heading = jobTrackerText(jobTrackerGroupLabel(section));
    const want = Math.min(wanted.find(([re]) => re.test(heading))?.[1] ?? 0, 10);
    const add = Array.from(section.querySelectorAll("button"))
      .find((b) => /hinzufügen|^\s*add/i.test(b.textContent) && parentGroup(b) === section);
    if (!want || !add) continue;
    const entries = () => Array.from(section.querySelectorAll("[role=group][aria-labelledby]"))
      .filter((g) => parentGroup(g) === section).length;
    for (let n = entries(); n < want; n++) {
      add.click();
      await new Promise((r) => setTimeout(r, 400)); // ponytail: fixed wait for the framework to render the entry
      added++;
    }
  }
  return added;
}

// Empty, visible, editable fields of the kinds we can fill.
function* jobTrackerEmptyFields() {
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (el.disabled || el.readOnly || el.multiple || !el.getClientRects().length) continue; // hidden or locked
    if (el.tagName === "INPUT" && !["text", "email", "tel", "url", "search", ""].includes(el.type)) continue;
    if (!el.value) yield el; // never overwrite what's there
  }
}

// Picks the option matching value (by value or visible text) or returns null.
function jobTrackerOption(el, value) {
  const want = value.trim().toLowerCase();
  return Array.from(el.options).find((o) => [o.value, o.text].some((v) => v.trim().toLowerCase() === want)) ?? null;
}

function jobTrackerSet(el, value, color, title) {
  if (el.tagName === "SELECT") {
    const option = jobTrackerOption(el, value);
    if (!option) return false;
    value = option.value;
  }
  // Native setter + events so React/Vue forms notice the change.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.style.outline = `2px solid ${color}`;
  if (title) el.title = title;
  return true;
}

function jobTrackerFill(profile) {
  let filled = 0;
  for (const el of jobTrackerEmptyFields()) {
    const key = jobTrackerClassify({ autocomplete: el.getAttribute("autocomplete") ?? "", hint: jobTrackerHint(el), type: el.type });
    const value = key && profile[key];
    if (value && jobTrackerSet(el, value, "#8fcdba")) filled++;
  }
  return filled;
}

// What is still empty after jobTrackerFill, described for the backend's AI pass (POST /api/fill).
// Each field is tagged so jobTrackerApply finds it again.
function jobTrackerCollect() {
  for (const el of document.querySelectorAll("[data-jobklick-field]")) delete el.dataset.jobklickField; // earlier runs
  const fields = [];
  for (const el of jobTrackerEmptyFields()) {
    const hint = jobTrackerHint(el);
    if (!hint || /password|passwort|captcha/i.test(hint)) continue;
    const label = [jobTrackerContext(el), hint].filter(Boolean).join(" › ").slice(0, 1000);
    const id = fields.length;
    el.dataset.jobklickField = id;
    const field = { id, label, type: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.type || "text" };
    if (el.tagName === "SELECT") field.options = Array.from(el.options, (o) => o.text.trim().slice(0, 300)).filter(Boolean).slice(0, 300);
    if (el.maxLength > 0) field.maxlength = el.maxLength;
    fields.push(field);
    if (fields.length === 80) break; // ponytail: matches the backend's cap; very long forms get filled in parts
  }
  return { url: location.href, page_title: document.title, text: document.body.innerText.slice(0, 100000), fields };
}

function jobTrackerApply(answers) {
  let filled = 0;
  for (const [id, value] of Object.entries(answers)) {
    const el = document.querySelector(`[data-jobklick-field="${CSS.escape(id)}"]`);
    if (el && !el.value && jobTrackerSet(el, value, "#f0b429", "Von KI vorgeschlagen – bitte prüfen")) filled++;
  }
  return filled;
}

if (typeof module !== "undefined") module.exports = { jobTrackerClassify };
