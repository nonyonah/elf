"""Package only the built public plugin, never credentials or project files."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from shutil import copyfile
root = Path(__file__).resolve().parents[2]
source = root / "dist/bridge-plugin-public"
output = root / "console/dist/mcp/downloads/elf-bridge-hosted.zip"
output.parent.mkdir(parents=True, exist_ok=True)
copyfile(root / "assets/brand/elf-mascot-icon.png", root / "console/dist/mcp/elf-logo.png")
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in ["manifest.json", "code.js", "ui.html", "plugin-icon.png"]:
        archive.write(source / name, name)
print(f"Hosted plugin bundle ready: {output}")
