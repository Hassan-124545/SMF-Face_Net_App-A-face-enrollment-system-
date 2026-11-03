"""Operator accounts, password hashing, login tokens and a small brute force limiter."""
import base64
import hashlib
import hmac
import os
import sqlite3
import threading
import time
from contextlib import closing

import jwt

from config import JWT_SECRET, LOGIN_LOCK_MINUTES, LOGIN_MAX_FAILS, TOKEN_HOURS, USERS_DB

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 15, 8, 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024
_lock = threading.Lock()
_fails = {}


def _db():
    conn = sqlite3.connect(USERS_DB)
    conn.row_factory = sqlite3.Row

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
        )
        """
    )

    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(users)").fetchall()
    }

    if "status" not in columns:
        conn.execute(
            "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"
        )
        conn.execute(
            """
            UPDATE users
            SET status = CASE
                WHEN active = 1 THEN 'active'
                ELSE 'disabled'
            END
            """
        )
        conn.commit()

    return conn


# ---------- passwords ----------
def hash_password(password):
    salt = os.urandom(16)
    digest = hashlib.scrypt(
        password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
        maxmem=_SCRYPT_MAXMEM, dklen=32,
    )
    return "scrypt${}${}${}${}${}".format(
        _SCRYPT_N, _SCRYPT_R, _SCRYPT_P,
        base64.b64encode(salt).decode(), base64.b64encode(digest).decode(),
    )


def _verify_hash(password, stored):
    try:
        _, n, r, p, salt_b64, digest_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        digest = hashlib.scrypt(
            password.encode(), salt=salt, n=int(n), r=int(r), p=int(p),
            maxmem=_SCRYPT_MAXMEM, dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected)


# used for unknown usernames, so the answer takes the same time as for a real account
_DUMMY_HASH = hash_password("dummy-password-for-timing")


# ---------- accounts ----------
def get_user(username):
    with closing(_db()) as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (str(username).strip().lower(),)).fetchone()
    return dict(row) if row else None


def list_users():
    with closing(_db()) as conn:
        rows = conn.execute(
    """
    SELECT username, name, active, status, created_at
    FROM users
    ORDER BY username
    """
).fetchall()
    return [dict(r) for r in rows]


def create_user(username, name, password, status="active"):
    username = username.strip().lower()

    if len(username) < 3:
        raise ValueError("The username must have at least 3 characters")

    if len(password) < 8:
        raise ValueError("The password must have at least 8 characters")

    if status not in ("active", "pending"):
        raise ValueError("Invalid account status")

    with closing(_db()) as conn, conn:
        try:
            conn.execute(
                """
                INSERT INTO users
                (username, name, password_hash, active, created_at, status)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    username,
                    name.strip() or username,
                    hash_password(password),
                    1 if status == "active" else 0,
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    status,
                ),
            )
        except sqlite3.IntegrityError:
            raise ValueError("This username already exists")


def set_password(username, password):
    if len(password) < 8:
        raise ValueError("The password must have at least 8 characters")
    with closing(_db()) as conn, conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = ? WHERE username = ?",
            (hash_password(password), username.strip().lower()),
        )
    if cur.rowcount == 0:
        raise ValueError("No such user")


def set_active(username, active):
    status = "active" if active else "disabled"

    with closing(_db()) as conn, conn:
        cur = conn.execute(
            """
            UPDATE users
            SET active = ?, status = ?
            WHERE username = ?
            """,
            (1 if active else 0, status, username.strip().lower())
        )

    if cur.rowcount == 0:
        raise ValueError("No such user")


def delete_user(username):
    with closing(_db()) as conn, conn:
        cur = conn.execute("DELETE FROM users WHERE username = ?", (username.strip().lower(),))
    if cur.rowcount == 0:
        raise ValueError("No such user")


def check_password(username, password):
    user = get_user(username)

    right = _verify_hash(
        password,
        user["password_hash"] if user else _DUMMY_HASH
    )

    if (
        user
        and user["active"]
        and user.get("status", "active") == "active"
        and right
    ):
        return {
            "username": user["username"],
            "name": user["name"]
        }

    return None


# ---------- login tokens ----------
def make_token(user):
    now = int(time.time())
    payload = {"sub": user["username"], "name": user["name"], "iat": now, "exp": now + int(TOKEN_HOURS * 3600)}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def verify_token(token):
    """Return the username for a valid token of an active account, otherwise None."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    user = get_user(payload.get("sub", ""))
    if not user or not user["active"]:
        return None
    return user["username"]


# ---------- brute force limiter ----------
def _recent_fails(key):
    cutoff = time.time() - LOGIN_LOCK_MINUTES * 60
    _fails[key] = [t for t in _fails.get(key, []) if t > cutoff]
    return _fails[key]


def is_locked(key):
    with _lock:
        return len(_recent_fails(key)) >= LOGIN_MAX_FAILS


def record_fail(key):
    with _lock:
        _recent_fails(key).append(time.time())


def clear_fails(key):
    with _lock:
        _fails.pop(key, None)

def approve_user(username):
    with closing(_db()) as conn, conn:
        cur = conn.execute(
            """
            UPDATE users
            SET active = 1, status = 'active'
            WHERE username = ? AND status = 'pending'
            """,
            (username.strip().lower(),)
        )

    if cur.rowcount == 0:
        raise ValueError("No pending user found")