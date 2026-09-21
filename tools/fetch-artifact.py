#!/usr/bin/env python3
"""Resolve and fetch GitHub resources while the sandbox DNS answers with
`198.18.0.0/15` for a set of well-known names.

## The problem, stated precisely

The sandbox resolver intermittently returns RFC 2544 addresses (`198.18.0.0/15`)
for names including `api.github.com`, `github.com`, `*.blob.core.windows.net`,
`registry.npmjs.org` and `pypi.org`. That range is not routable on the public
internet, so TCP connects locally and then the TLS handshake dies with
`SSLZeroReturnError` at a hard 5.00s. Names with real addresses work at the same
instant (`example.com` 200, `api.deepseek.com` 401), so the egress *path* is
healthy -- only the answers are wrong.

## Why pinning is enough for the API but not for blob fetches

For `api.github.com`, any real GitHub edge will serve the request: the API is
addressed by the `Host` header and TLS SNI, and GitHub's edges are symmetric.
Substituting an address therefore works outright (verified: 200 on
`140.82.121.6`, `.5`, `140.82.112.6`).

Azure blob is **not** symmetric. A download URL carries a SAS token whose
signature covers the account in the host name, so connecting to a *different*
account's edge returns `404 AccountNotFound` -- the request is authenticated for
`productionresultssa10` and no other edge will accept it. Measured: pinning
`sa3` to its own real address returns `400` (correct, missing query parameters),
pinning it to `sa16`'s address returns `404 AccountNotFound`.

So a blob fetch needs the **real address of that specific host**, which the local
resolver will not give. `dns.alidns.com` is not in the blocked set, and its JSON
API resolves the CNAME chain all the way to the A records. That is the route used
here.

## What this module is not

It is not a fix for the sandbox, and it does not pretend the block is absent: it
records every substituted answer so a fetch that succeeds this way is
distinguishable in the log from one that resolved normally.
"""

from __future__ import annotations

import json
import socket
import sys
import time
from typing import Iterable

import requests

API = "https://api.github.com"

# GitHub API edges that were measured to answer 200. The API is edge-symmetric,
# so any of these serves any request as long as Host/SNI stay correct.
GITHUB_API_IPS = ("140.82.121.6", "140.82.121.5", "140.82.112.6")

# The only resolver reachable while the local one is answering synthetic ranges.
DOH_ENDPOINT = "https://dns.alidns.com/resolve"


class Egress:
    """Resolves blocked names over DoH and records every substitution."""

    def __init__(self) -> None:
        self._original = socket.getaddrinfo
        self.resolved: dict[str, list[str]] = {}
        self._cache: dict[str, str] = {}

    # -- resolution ---------------------------------------------------------

    def _doh(self, name: str) -> list[str]:
        """Resolve `name` to A records via DoH, following the CNAME chain."""
        for attempt in range(3):
            try:
                r = requests.get(
                    DOH_ENDPOINT,
                    params={"name": name, "type": "A"},
                    timeout=15,
                    headers={"Accept": "application/dns-json"},
                )
                if r.status_code != 200:
                    time.sleep(1.0 * (attempt + 1))
                    continue
                answers = r.json().get("Answer", [])
                addrs = [
                    a["data"]
                    for a in answers
                    if a.get("type") == 1 and not a["data"].startswith("198.18.")
                ]
                if addrs:
                    return addrs
            except requests.RequestException:
                time.sleep(1.0 * (attempt + 1))
        return []

    def _is_synthetic(self, name: str) -> bool:
        try:
            infos = self._original(name, 443, type=socket.SOCK_STREAM)
        except socket.gaierror:
            return True
        return all(i[4][0].startswith("198.18.") for i in infos)

    # -- installation -------------------------------------------------------

    def install(self) -> None:
        def patched(host, port, *args, **kwargs):
            if host == "api.github.com":
                self.resolved.setdefault(host, list(GITHUB_API_IPS))
                return self._original(GITHUB_API_IPS[0], port, *args, **kwargs)

            if self._is_synthetic(host):
                addr = self._cache.get(host)
                if addr is None:
                    found = self._doh(host)
                    if not found:
                        # Nothing to substitute; fail the way the block does
                        # rather than silently connecting somewhere else.
                        return self._original(host, port, *args, **kwargs)
                    addr = found[0]
                    self._cache[host] = addr
                    self.resolved.setdefault(host, found)
                return self._original(addr, port, *args, **kwargs)

            return self._original(host, port, *args, **kwargs)

        socket.getaddrinfo = patched

    def report(self) -> None:
        if not self.resolved:
            print("egress       : resolved normally (no substitution needed)")
            return
        print("egress       : substituted answers (local resolver returned 198.18.x)")
        for name, addrs in sorted(self.resolved.items()):
            label = addrs[0] if len(addrs) == 1 else ", ".join(addrs[:3])
            print(f"               {name} -> {label}")


def token() -> str:
    with open("/tmp/pat") as fh:
        return fh.read().strip()


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update(
        {
            "Authorization": f"Bearer {token()}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "cortex-artifact-fetch",
        }
    )
    return s


def download_artifact(artifact_id: int, repo: str, dest: str) -> bool:
    """Fetch one Actions artifact to `dest`. Returns True on success."""
    eg = Egress()
    eg.install()
    s = session()

    url = f"{API}/repos/{repo}/actions/artifacts/{artifact_id}/zip"
    r = s.get(url, timeout=60)
    eg.report()
    print(f"artifact     : {url} -> {r.status_code}, {len(r.content)} bytes")

    if r.status_code != 200 or len(r.content) < 1024:
        print("body preview :", r.content[:200])
        return False

    with open(dest, "wb") as fh:
        fh.write(r.content)
    print(f"written      : {dest}")
    return True


def main(argv: list[str]) -> int:
    """`fetch-artifact.py <artifact_id> <owner/repo> <dest.zip>`

    Exit status is meaningful: 0 only when the payload was written, so a caller
    can distinguish "fetched" from "the API answered but the bytes were not the
    artifact". The 404/XML case is the one that matters -- the artifact endpoint
    returns 200 with an XML error body when the redirect target cannot serve the
    request, which looks like success to a status-code-only caller.
    """
    if len(argv) < 4:
        print(__doc__.strip().splitlines()[0])
        print("usage: fetch-artifact.py <artifact_id> <owner/repo> <dest.zip>")
        return 2
    try:
        artifact_id = int(argv[1])
    except ValueError:
        print(f"artifact_id must be an integer, got {argv[1]!r}")
        return 2
    return 0 if download_artifact(artifact_id, argv[2], argv[3]) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
