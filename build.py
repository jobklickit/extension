"""Build browser packages from the shared WebExtension sources (no dependencies)."""
import json
from pathlib import Path
import shutil
import zipfile

SOURCE = Path(__file__).resolve().parent
SRC = SOURCE / "src"
# every file in src/ except the manifest, which is written per browser
ASSETS = tuple(sorted(p.name for p in SRC.iterdir() if p.is_file()
               and p.name != "manifest.json" and not p.name.startswith(".")))


def build():
    base = json.loads((SRC / "manifest.json").read_text())
    for browser in ("chrome", "firefox"):
        manifest = json.loads(json.dumps(base))
        if browser == "firefox":
            manifest["background"] = {
                "scripts": ["logging.js", "background.js"]}
        else:
            manifest["background"] = {"service_worker": "background.js"}
            manifest.pop("browser_specific_settings", None)
        destination = SOURCE / "dist" / browser
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        for asset in ASSETS:
            shutil.copyfile(SRC / asset, destination / asset)
        with zipfile.ZipFile(SOURCE / "dist" / f"{browser}.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            for asset in ("manifest.json", *ASSETS):
                archive.write(destination / asset, asset)
        print(destination)


if __name__ == "__main__":
    build()
