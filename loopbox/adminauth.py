"""The /admin page's sign-in. One account, kept beside the code in
secrets/admin.json as a scrypt hash with its salt (never the password, never
in git); without the file there is no admin page at all.

  python -m loopbox.adminauth          sets the account (asks for the name and the password)

Signed in, the browser holds a random token in a cookie the page's scripts
cannot read (HttpOnly, Secure, SameSite=Strict, sent to /api/admin only); the
server keeps only a hash of it, in memory, for SESSION_S. Guessing is slowed
three ways: every wrong attempt is answered after a pause, an address may
miss a few times in a window, and too many misses from everywhere lock the
sign-in for everyone for a while."""
import getpass
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
from collections import deque

from .config import ADMIN_FILE

N, R, P = 2 ** 15, 8, 1      # scrypt cost: about 32 MB and 0.1 s a try
MAXMEM = 64 * 1024 * 1024
SESSION_S = 12 * 3600
PER_IP = (5, 15 * 60)        # misses one address may make, per this many seconds
GLOBAL = (30, 3600)          # misses from everywhere before the lock
LOCK_S = 30 * 60
WRONG_DELAY_S = 1.0

_lock = threading.Lock()
_tokens: dict[str, tuple] = {}           # sha256(token) -> (expires at, the account hash it was given for)
_misses: dict[str, deque] = {}           # keyed hash of the address -> miss times
_all_misses: deque = deque()
_locked = {"until": 0.0}
_salt = secrets.token_bytes(32)          # for the address hashes, per process
_cache = {"mtime": None, "data": None}


def _hash(password: str, salt: bytes, n: int = N, r: int = R, p: int = P) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=MAXMEM, dklen=32)


def make(user: str, password: str) -> dict:
    salt = secrets.token_bytes(16)
    return {"user": user, "salt": salt.hex(), "hash": _hash(password, salt).hex(), "n": N, "r": R, "p": P}


def _account() -> dict | None:
    try:
        mtime = ADMIN_FILE.stat().st_mtime
    except OSError:
        return None
    if _cache["mtime"] != mtime:
        try:
            _cache.update(mtime=mtime, data=json.loads(ADMIN_FILE.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            _cache.update(mtime=mtime, data=None)
    return _cache["data"]


def enabled() -> bool:
    a = _account()
    return bool(a and a.get("user") and a.get("hash") and a.get("salt"))


def _who(ip: str) -> str:
    return hashlib.blake2b(ip.encode(), key=_salt, digest_size=12).hexdigest()


def wait_s(ip: str) -> int:
    """Seconds this address must wait before it may try again (0: now)."""
    now = time.time()
    with _lock:
        if now < _locked["until"]:
            return int(_locked["until"] - now) + 1
        q = _misses.get(_who(ip)) or deque()
        while q and now - q[0] > PER_IP[1]:
            q.popleft()
        if len(q) >= PER_IP[0]:
            return int(PER_IP[1] - (now - q[0])) + 1
    return 0


def check(ip: str, user: str, password: str) -> bool:
    """True for the account's name and password (both compared in constant
    time, the hash always computed); a miss is counted and answered late."""
    a = _account()
    if not a or wait_s(ip):
        return False
    good = hmac.compare_digest(_hash(password, bytes.fromhex(a["salt"]), a.get("n", N), a.get("r", R), a.get("p", P)),
                               bytes.fromhex(a["hash"]))
    good = hmac.compare_digest(user.encode("utf-8"), str(a["user"]).encode("utf-8")) and good
    if not good:
        now = time.time()
        with _lock:
            if len(_misses) > 5000:  # old addresses forgotten
                for k in [k for k, q in _misses.items() if not q or now - q[-1] > PER_IP[1]]:
                    _misses.pop(k, None)
            _misses.setdefault(_who(ip), deque()).append(now)
            _all_misses.append(now)
            while _all_misses and now - _all_misses[0] > GLOBAL[1]:
                _all_misses.popleft()
            if len(_all_misses) >= GLOBAL[0]:
                _locked["until"] = now + LOCK_S
                _all_misses.clear()
        time.sleep(WRONG_DELAY_S)
    return good


def new_token() -> str:
    """A sign-in for the current account (a new password ends the old ones)."""
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        for k in [k for k, (exp, _) in _tokens.items() if exp < now]:
            _tokens.pop(k, None)
        _tokens[hashlib.sha256(token.encode()).hexdigest()] = (now + SESSION_S, (_account() or {}).get("hash"))
    return token


def valid(token: str | None) -> bool:
    if not token or not enabled():
        return False
    with _lock:
        exp, of = _tokens.get(hashlib.sha256(token.encode()).hexdigest()) or (0.0, None)
    return exp > time.time() and of == _account().get("hash")


def drop(token: str | None) -> None:
    if token:
        with _lock:
            _tokens.pop(hashlib.sha256(token.encode()).hexdigest(), None)


def main() -> None:
    user = input("Tên đăng nhập: ").strip()
    pw = getpass.getpass("Mật khẩu: ")
    if not user or len(pw) < 12 or pw != getpass.getpass("Nhập lại mật khẩu: "):
        sys.exit("Cần tên, và mật khẩu từ 12 ký tự nhập giống nhau hai lần")
    ADMIN_FILE.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(ADMIN_FILE.parent, 0o700)
    tmp = ADMIN_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(make(user, pw)), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, ADMIN_FILE)
    print(f"Đã lưu tài khoản admin vào {ADMIN_FILE} (chỉ có mã băm). Các phiên đăng nhập cũ hết hiệu lực ngay.")


if __name__ == "__main__":
    main()
