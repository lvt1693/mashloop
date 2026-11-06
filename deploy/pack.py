"""Packs the code for the server (tracked and new files, no data):
python deploy/pack.py <out.tgz>"""
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = ("data/", ".scratch/", ".qa/", ".venv/", "videos/", "tools/__pycache__/", "secrets/")

files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT, capture_output=True,
                       text=True, check=True).stdout.splitlines()
files = [f for f in files if not f.startswith(SKIP) and (ROOT / f).is_file()]
with tarfile.open(sys.argv[1], "w:gz") as tar:
    for f in files:
        info = tar.gettarinfo(str(ROOT / f), arcname=f)
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        if f.endswith(".sh"):
            info.mode = 0o755
        with open(ROOT / f, "rb") as fh:
            tar.addfile(info, fh)
print(f"{len(files)} files -> {sys.argv[1]}")
