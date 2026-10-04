"""Repeating-section form fill (Workday "Hinzufügen"). Run with uv run --with playwright python tests/test_fill_dom.py."""
from pathlib import Path

from playwright.sync_api import sync_playwright

# Cut down from a real Workday "Meine Erfahrung" page: sections are labelled role=group, entries appear on click.
HTML = """
<div role="group" aria-labelledby="exp"><h4 id="exp">Berufserfahrung</h4>
 <div role="group" aria-labelledby="exp1"><h5 id="exp1">Berufserfahrung 1</h5><button>Löschen</button>
  <label for="jt">Tätigkeitsbezeichnung*</label><input type="text" id="jt" name="jobTitle">
  <fieldset><legend><label>Von*</label></legend>
   <div role="group" aria-labelledby="hiddenDateValueId-x"><input role="spinbutton" aria-label="Month"><input role="spinbutton" aria-label="Year"></div></fieldset>
 </div>
 <button data-automation-id="add-button">Weitere hinzufügen</button></div>
<div role="group" aria-labelledby="edu"><h4 id="edu">Ausbildung</h4>
 <div id="eduslot"></div><button data-automation-id="add-button" onclick="addEdu()">Hinzufügen</button></div>
<label for="li">Please provide us your LinkedIn account</label><input type="text" id="li">
<script>
let n=0; function addEdu(){ setTimeout(()=>{ n++; document.getElementById('eduslot').insertAdjacentHTML('beforeend',
 `<div role="group" aria-labelledby="edu${n}"><h5 id="edu${n}">Ausbildung ${n}</h5><label for="s${n}">Schule oder Hochschule</label><input type="text" id="s${n}"></div>`)},100)}
</script>"""

with sync_playwright() as p:
    page = p.chromium.launch().new_page()
    page.set_content(HTML)
    page.add_script_tag(path=Path(__file__).resolve().parent.parent / "src" / "fill.js")
    assert page.evaluate("jobTrackerExpand({experience: 1, education: 2})") == 2  # experience 1 already exists
    labels = [f["label"] for f in page.evaluate("jobTrackerCollect()")["fields"]]
    assert labels[1] == "Berufserfahrung › Berufserfahrung 1 › Von* › Month", labels
    assert labels[4].startswith("Ausbildung › Ausbildung 2 › "), labels
print("ok repeating sections")
