"""Bump the patch version, build and sign the Firefox package on AMO.

Needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET (see .envrc). Usage:
    python3 publish_firefox.py [--listed]
Unlisted (default) returns a signed .xpi in dist/; --listed submits to addons.mozilla.org.
"""
import json
import os
import subprocess
import sys

from build import SOURCE, build


def bump(version):
    major, minor, patch = version.split(".")
    return f"{major}.{minor}.{int(patch) + 1}"


def main():
    missing = [k for k in ("WEB_EXT_API_KEY", "WEB_EXT_API_SECRET") if not os.environ.get(k)]
    if missing:
        sys.exit(f"Missing {', '.join(missing)} (run `direnv allow` or export them).")
    channel = "listed" if "--listed" in sys.argv[1:] else "unlisted"

    path = SOURCE / "src" / "manifest.json"
    text = path.read_text()
    old = json.loads(text)["version"]
    new = bump(old)
    # ponytail: string replace keeps the manifest's hand formatting intact
    path.write_text(text.replace(f'"version": "{old}"', f'"version": "{new}"', 1))
    print(f"Version {old} -> {new}")

    build()
    # ponytail: AMO rejects reused versions, so a failed upload leaves the bump in place; rerun bumps again
    subprocess.run(
        ["bunx", "web-ext", "sign", "--channel", channel,
         "--amo-metadata", str(SOURCE / "amo-metadata.json"),
         "--source-dir", str(SOURCE / "dist" / "firefox"),
         "--artifacts-dir", str(SOURCE / "dist")],
        check=True,
    )


if __name__ == "__main__":
    assert bump("0.3.3") == "0.3.4" and bump("1.9.9") == "1.9.10"
    main()
