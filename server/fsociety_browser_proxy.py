#!/usr/bin/env python3
"""fsociety NET — HTTPS proxy for the browser extension (Chrome / Yandex).

TLS on PORT with a real certificate (Chrome refuses self-signed proxies). Auth: Proxy-Authorization Basic
<user_id>:<exp>.<hmac>, HMAC-SHA256(BROWSER_PROXY_KEY, "<user_id>|<exp>")[:40] — issued by the API
(/api/vpn/browser-proxy, paid users only, lives 12 h), checked here without a DB. Supports CONNECT (HTTPS
sites) and plain http:// requests. Never logs users or destinations (no-logs). Refuses private / local
destinations and SMTP ports.

Env: BROWSER_PROXY_KEY (required), PORT (8443), BIND (listen IP, default all), CERT, KEY (PEM paths), MAX_CONN_PER_USER (300).
Python 3.10+, stdlib only.
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import os
import socket
import ssl
import time
from urllib.parse import urlsplit

KEY = os.environ.get("BROWSER_PROXY_KEY", "").encode()
PORT = int(os.environ.get("PORT", "8443"))
BIND = os.environ.get("BIND") or None   # one IP (e.g. not the API's), default all
# systemd LoadCredential= (unit fsociety-browser-proxy@<domain>) → $CREDENTIALS_DIRECTORY/cert, /key
_cred = os.environ.get("CREDENTIALS_DIRECTORY", "")
CERT = os.environ.get("CERT") or (os.path.join(_cred, "cert") if _cred else "")
PKEY = os.environ.get("KEY") or (os.path.join(_cred, "key") if _cred else "")
MAX_CONN = int(os.environ.get("MAX_CONN_PER_USER", "300"))
HEAD_MAX = 32 * 1024
BLOCKED_PORTS = {25, 465, 587}

active: dict[str, int] = {}


def check_auth(header: str) -> str | None:
    """User id if the Proxy-Authorization header is valid and not expired."""
    if not header.lower().startswith("basic "):
        return None
    try:
        user, _, pw = base64.b64decode(header[6:].strip()).decode().partition(":")
        exp_s, _, sig = pw.partition(".")
        exp = int(exp_s)
    except Exception:
        return None
    if exp < time.time() or not user:
        return None
    good = hmac.new(KEY, f"{user}|{exp}".encode(), hashlib.sha256).hexdigest()[:40]
    return user if hmac.compare_digest(good, sig) else None


async def resolve_public(host: str, port: int):
    """(ip, family) of a public address for host, or None."""
    if port in BLOCKED_PORTS or not 0 < port < 65536:
        return None
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return None
    for fam, _, _, _, addr in infos:
        ip = ipaddress.ip_address(addr[0])
        if ip.is_global and not ip.is_multicast:
            return addr[0], fam
    return None


async def pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter):
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass


def reply(w: asyncio.StreamWriter, status: str, extra: str = ""):
    w.write(f"HTTP/1.1 {status}\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n".encode())


async def handle(cr: asyncio.StreamReader, cw: asyncio.StreamWriter):
    user = None
    try:
        try:
            head = await asyncio.wait_for(cr.readuntil(b"\r\n\r\n"), 30)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, OSError):
            return
        lines = head.decode("latin-1").split("\r\n")
        try:
            method, target, version = lines[0].split(" ", 2)
        except ValueError:
            return
        headers = [l for l in lines[1:] if l]
        auth = next((l.split(":", 1)[1].strip() for l in headers
                     if l.lower().startswith("proxy-authorization:")), "")
        user = check_auth(auth)
        if not user:
            reply(cw, "407 Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="fsociety"\r\n')
            await cw.drain()
            user = None
            return
        if active.get(user, 0) >= MAX_CONN:
            reply(cw, "429 Too Many Requests")
            await cw.drain()
            user = None
            return
        active[user] = active.get(user, 0) + 1

        if method.upper() == "CONNECT":
            host, _, port_s = target.rpartition(":")
            host = host.strip("[]")
            port = int(port_s) if port_s.isdigit() else 0
            first = b""
        else:
            u = urlsplit(target)
            if u.scheme != "http" or not u.hostname:
                reply(cw, "400 Bad Request")
                await cw.drain()
                return
            host, port = u.hostname, u.port or 80
            path = (u.path or "/") + (f"?{u.query}" if u.query else "")
            keep = [l for l in headers if not l.lower().startswith(("proxy-", "connection:", "keep-alive:"))]
            first = (f"{method} {path} {version}\r\n" + "\r\n".join(keep + ["Connection: close"])
                     + "\r\n\r\n").encode("latin-1")

        dst = await resolve_public(host, port)
        if not dst:
            reply(cw, "403 Forbidden")
            await cw.drain()
            return
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(dst[0], port), 15)
        except (OSError, asyncio.TimeoutError):
            reply(cw, "502 Bad Gateway")
            await cw.drain()
            return
        if first:
            uw.write(first)
        else:
            cw.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await cw.drain()
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    except Exception:
        pass
    finally:
        if user:
            n = active.get(user, 1) - 1
            if n > 0:
                active[user] = n
            else:
                active.pop(user, None)
        try:
            cw.close()
        except Exception:
            pass


async def main():
    if not KEY:
        raise SystemExit("BROWSER_PROXY_KEY is not set")
    ctx = None
    if CERT:
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(CERT, PKEY)
    srv = await asyncio.start_server(handle, host=BIND, port=PORT, ssl=ctx, limit=HEAD_MAX,
                                     ssl_handshake_timeout=15 if ctx else None)
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
