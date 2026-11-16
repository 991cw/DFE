#!/usr/bin/env python3
"""DFE_07 local development server (scene, environment, models and optional animation).

Put this file beside DFE_07.json and DFE_07_env.json and the models/ folder.
Exported DFE_07_anim.json is OPTIONAL; add it whenever you are ready.
The VEB.js viewer is still hosted at digital-factory.io; all user assets come
from localhost. Browser local-network / mixed-content permissions may apply.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode
import argparse
import json
import mimetypes
import sys
import webbrowser

ROOT = Path(__file__).resolve().parent
PORT = 8765
HOST = "127.0.0.1"  # accessible only from this machine
VIEWER = "https://digital-factory.io/vebjs/"
ALLOWED_ORIGINS = {
    "https://digital-factory.io",
    "https://www.digital-factory.io",
}

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")


class DFEHandler(SimpleHTTPRequestHandler):
    """Serve files without caching, with CORS for the official hosted viewer."""

    def end_headers(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                self.headers.get("Access-Control-Request-Headers")
                or "Content-Type, Accept, X-Requested-With",
            )
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


def viewer_url():
    base = f"http://localhost:{PORT}"
    params = {
        "inputscene": f"{base}/DFE_07.json",
        "repoMod3d": f"{base}/models/",  # YOUR folder, never professor's model repository
    }
    if (ROOT / "DFE_07_env.json").is_file():
        params["inputenv"] = f"{base}/DFE_07_env.json"
    if (ROOT / "DFE_07_anim.json").is_file():
        params["inputanim"] = f"{base}/DFE_07_anim.json"
    return VIEWER + "?" + urlencode(params)


def check_files():
    scene_path = ROOT / "DFE_07.json"
    print("\n=== DFE_07 LOCAL TEST SERVER ===")
    print("Working folder:", ROOT)
    for label, path in [
        ("Scene", scene_path),
        ("Environment", ROOT / "DFE_07_env.json"),
        ("Models folder", ROOT / "models"),
        ("Animation (optional)", ROOT / "DFE_07_anim.json"),
    ]:
        print(f"{label}: {'FOUND' if path.exists() else 'NOT FOUND'}")

    if not scene_path.is_file():
        print("ERROR: Export DFE_07.json into this folder first.")
        return False

    if not (ROOT / "models").is_dir():
        print("WARNING: Create a 'models' subfolder containing ALL GLBs required by the scene.")

    try:
        scene = json.loads(scene_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        print("ERROR: Scene JSON could not be read:", exc)
        return False

    context_repo = (scene.get("context") or {}).get("RepoPath")
    if context_repo:
        print("NOTE: Scene context RepoPath is not empty:", context_repo)
        print("      For predictable local tests, consider keeping Context RepoPath blank in Excel.")

    references = []
    for asset in scene.get("assets", []):
        for rep in asset.get("representations", []):
            if isinstance(rep, dict) and rep.get("file"):
                references.append((asset.get("id", "?"), str(rep["file"])))

    missing = []
    remote = []
    for asset_id, ref in references:
        filename = ref.split("#", 1)[0]
        if filename.lower().startswith(("http://", "https://")):
            remote.append((asset_id, filename))
        elif not (ROOT / "models" / filename).is_file():
            missing.append((asset_id, filename))
    if missing:
        print("\nWARNING: The following referenced local GLBs were NOT found in models/:")
        for asset_id, name in list(dict.fromkeys(missing))[:25]:
            print(f"  {asset_id}: {name}")
    if remote:
        print("\nNOTE: Some model 'file' cells contain full online URLs;")
        print("      those assets will NOT use your local models/ folder until you")
        print("      change their Excel 'file' cells to filenames and re-export:")
        for asset_id, name in list(dict.fromkeys(remote))[:12]:
            print(f"  {asset_id}: {name}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Serve DFE_07 assets locally.")
    parser.add_argument("--check", action="store_true", help="Show URL and verify files without starting server")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")
    args = parser.parse_args()

    valid = check_files()
    url = viewer_url()
    print("\nOpen VEB.js using this URL:\n", url)
    print("\nAfter Excel export, refresh VEB.js. No GitHub push needed.")
    if not (ROOT / "DFE_07_anim.json").is_file():
        print("When you add DFE_07_anim.json later, restart this launcher")
        print("once to include the inputanim parameter automatically.")
    if not valid:
        return 1
    if args.check:
        return 0

    try:
        with ThreadingHTTPServer((HOST, PORT), partial(DFEHandler, directory=str(ROOT))) as server:
            print(f"\nServing files at http://localhost:{PORT}/")
            print("Leave this window OPEN while testing. Press Ctrl+C to stop.\n")
            if not args.no_browser:
                try:
                    webbrowser.open(url, new=2)
                except Exception:
                    pass
            server.serve_forever()
    except OSError as exc:
        print("Server cannot start:", exc)
        print("Close another program already using port 8765, or stop the previous DFE server.")
        return 1
    except KeyboardInterrupt:
        print("\nServer stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
