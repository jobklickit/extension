// Run: node extension/fill.test.js
const assert = require("node:assert/strict");
const { jobTrackerClassify: c } = require("../src/fill.js");

const cases = [
  [{ autocomplete: "given-name", hint: "whatever" }, "first_name"],
  [{ autocomplete: "section-apply shipping email" }, "email"],
  [{ hint: "First Name *" }, "first_name"],
  [{ hint: "job_application[last_name]" }, "last_name"],
  [{ hint: "Vorname" }, "first_name"],
  [{ hint: "Nachname" }, "last_name"],
  [{ hint: "E-Mail-Adresse" }, "email"],
  [{ hint: "Email address" }, "email"],
  [{ hint: "Telefonnummer" }, "phone"],
  [{ hint: "LinkedIn Profile" }, "website"],
  [{ hint: "PLZ" }, "postal_code"],
  [{ hint: "Wohnort" }, "city"],
  [{ hint: "Straße und Hausnummer" }, "street"],
  [{ hint: "Full name" }, "full_name"],
  [{ hint: "Name" }, "full_name"],
  [{ hint: "Company name" }, null],
  [{ hint: "Current employer" }, null],
  [{ hint: "Address line 2" }, null],
  [{ hint: "Username" }, null],
  [{ hint: "How did you hear about us?" }, null],
  [{ hint: "q7", type: "email" }, "email"],
];
for (const [input, want] of cases) assert.equal(c(input), want, JSON.stringify(input));
console.log(`ok ${cases.length} cases`);
