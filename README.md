# jobklick.it browser extension

Right-click a job listing → **Job speichern**. Saves the listing to your [jobklick.it](https://jobklick.it) account,
fills application forms from your profile, and adds save buttons to StepStone, Indeed and LinkedIn.
Needs a [jobklick.it account](https://jobklick.it).

## Installation

- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/de/firefox/addon/jobklickit/)
- **Chrome, Edge, Brave:** `python3 build.py`, dann `chrome://extensions` → Entwicklermodus → **Entpackte Erweiterung laden** → `dist/chrome/`

Danach aufs Symbol der Erweiterung klicken → **Mit jobklick.it verbinden**. Anleitung: [jobklick.it/docs/erweiterung](https://jobklick.it/docs/erweiterung/)

## Develop

Plain JavaScript, no dependencies. `src/` is the extension, `tests/` the tests, `build.py` writes packages to `dist/`.

```sh
python3 build.py
for t in tests/*.test.js; do node "$t"; done
uv run --with playwright playwright install chromium   # once
uv run --with playwright python tests/test_listings.py
uv run --with playwright python tests/test_fill_dom.py
```

Job-board adapters live in `src/listings.js`. Data goes only to the backend you connect to; diagnostics stay local.
Pull requests welcome. License: [MIT](LICENSE).
