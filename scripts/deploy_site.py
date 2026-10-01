"""Publish landing/ to waivepulse.com over FTP.

    python scripts/deploy_site.py            # upload what changed
    python scripts/deploy_site.py --all      # upload everything
    python scripts/deploy_site.py --dry-run  # say what it would do

Credentials come from the repo's .env (gitignored, never printed):

    wp_ftp=ftp.waivepulse.com
    wp_userid=...
    wp_pw=...

Notes learned the hard way:
* The FTP root IS the web root on this host. The /home/u.../public_html path that the hosting
  panel shows does not exist over FTP, so wp_path is ignored.
* Some hosts want the account id prefixed to the username (u123456.name). If the username as
  given is refused, this retries with the account id taken from wp_path.
* Uploads go to a temp name and are renamed into place, so a half-uploaded file is never served.
"""
import argparse
import ftplib
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "landing"
ENV = ROOT / ".env"
LIVE = "https://waivepulse.com/"
SKIP = {".DS_Store", "Thumbs.db", ".gitkeep"}
# What we last put on the server, path -> sha256. Size alone misses a same-length edit.
STATE = ROOT / ".deploy-state.json"


def env():
    if not ENV.is_file():
        sys.exit(".env not found. It needs wp_ftp, wp_userid and wp_pw.")
    kv = dict(re.findall(r"^(\w+)=(.*)$", ENV.read_text(encoding="utf-8"), re.M))
    missing = [k for k in ("wp_ftp", "wp_userid", "wp_pw") if not kv.get(k, "").strip()]
    if missing:
        sys.exit(".env is missing: " + ", ".join(missing))
    return {k: v.strip() for k, v in kv.items()}


def connect(kv):
    host, user, pw = kv["wp_ftp"], kv["wp_userid"], kv["wp_pw"]
    acct = (re.search(r"/home/([^/]+)/", kv.get("wp_path", "")) or [None, None])[1]
    tries = [user] + ([f"{acct}.{user}"] if acct and not user.startswith(acct) else [])
    last = None
    for u in tries:
        try:
            f = ftplib.FTP(host, timeout=40)
            f.login(u, pw)
            return f
        except ftplib.error_perm as e:
            last = e
    sys.exit(f"FTP login refused ({last}). Check wp_userid / wp_pw in .env.")


def local_files():
    for p in sorted(SITE.rglob("*")):
        if p.is_file() and p.name not in SKIP:
            yield p, str(p.relative_to(SITE)).replace("\\", "/")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state():
    if STATE.is_file():
        try:
            return json.loads(STATE.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {}


def save_state(state):
    STATE.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def remote_sizes(ftp):
    """path -> size, for every file already on the server (one pass per directory)."""
    sizes, stack = {}, [""]
    while stack:
        d = stack.pop()
        try:
            entries = list(ftp.mlsd(d or "/"))
        except Exception:
            return sizes          # host without MLSD: fall back to uploading everything
        for name, facts in entries:
            if name in (".", ".."):
                continue
            rel = f"{d}/{name}".lstrip("/")
            if facts.get("type") == "dir":
                stack.append(rel)
            elif facts.get("type") == "file":
                sizes[rel] = int(facts.get("size", -1))
    return sizes


def ensure_dir(ftp, rel):
    parts = rel.split("/")[:-1]
    path = ""
    for part in parts:
        path = f"{path}/{part}" if path else part
        try:
            ftp.mkd(path)
        except ftplib.error_perm:
            pass                  # already there


def upload(ftp, local, rel):
    ensure_dir(ftp, rel)
    tmp = rel + ".uploading"
    with open(local, "rb") as fh:
        ftp.storbinary(f"STOR {tmp}", fh, blocksize=65536)
    try:
        ftp.delete(rel)
    except ftplib.error_perm:
        pass
    ftp.rename(tmp, rel)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="upload every file, not just changed ones")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    files = list(local_files())
    if not files:
        sys.exit(f"nothing to deploy: {SITE} is empty")

    kv = env()
    ftp = connect(kv)
    print(f"connected to {kv['wp_ftp']} (web root {ftp.pwd()})")
    have = {} if a.all else remote_sizes(ftp)
    state = {} if a.all else load_state()

    sent = skipped = 0
    for local, rel in files:
        size = local.stat().st_size
        digest = sha(local)
        # Unchanged only when the bytes match what we last uploaded AND the server still has
        # a file of that size. Either signal alone has fooled this script before.
        if not a.all and state.get(rel) == digest and have.get(rel, size) == size:
            skipped += 1
            continue
        print(f"  {'would upload' if a.dry_run else 'uploading'} {rel} ({size:,} bytes)")
        if not a.dry_run:
            upload(ftp, local, rel)
            state[rel] = digest
        sent += 1
    ftp.quit()
    if not a.dry_run:
        save_state(state)
    print(f"{sent} uploaded, {skipped} unchanged")

    if a.dry_run or not sent:
        return 0
    try:                                   # prove the live site really changed
        # This machine's Windows root store is stale and rejects Let's Encrypt, which looks
        # exactly like an outage. Verify against certifi's bundle instead (never CERT_NONE).
        ctx = None
        try:
            import certifi, ssl
            ctx = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            pass
        with urllib.request.urlopen(LIVE, timeout=30, context=ctx) as r:
            body = r.read()
        local_index = (SITE / "index.php").read_bytes()
        marker = "Using it at"             # a line only the current build has
        print(f"live {LIVE} -> {r.status}, {len(body):,} bytes, "
              f"business section {'present' if marker.encode() in body else 'MISSING'}")
    except Exception as e:
        print(f"could not verify {LIVE}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
