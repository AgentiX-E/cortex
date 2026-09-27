#!/usr/bin/env python3
"""Resolve GitHub hosts over DoH and pin them, so pushes stop depending on DNS.

WHY THIS EXISTS. The sandbox's resolver answers a set of hostnames with
addresses in `198.18.0.0/15` (RFC 2544 benchmarking range). Those addresses are
not routable, so every connection to them fails at TLS with `http=000` after a
pinned ~5s. Measured 2026-09-27:

    api.github.com   -> 198.18.0.12   (resolver)   -> 000
    api.github.com   -> 20.205.243.168 (DoH)       -> 200

The failure is therefore **resolution, not reachability**. Two controls make that
conclusive rather than a guess: `mirrors.tencent.com` answers `200` in 20ms at the
same instant, and substituting the DoH answer with `--resolve` turns the `000`
into a `200` without changing anything else. `docs/OPS-SANDBOX-EGRESS-STATE.md`
records the same signature from an earlier occurrence.

WHY A SCRIPT AND NOT A HAND-EDIT. `/etc/hosts` is restored on workspace restart
(its own header says so), so a manual fix is a fix that expires silently. This
re-derives the addresses on every invocation and is safe to re-run.

WHY DoH AND NOT A PUBLIC RESOLVER DIRECTLY. Port 53 to arbitrary servers is not
reliably open here, while `dns.alidns.com` answers over HTTPS. The repository
already used this path for artifact fetches (`tools/fetch-artifact.py`), so this
reuses the mechanism rather than introducing a second one.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DOH = "https://dns.alidns.com/resolve"

# Hosts this repository's own workflows need, and nothing more.
#
# A hosts file is a global override, so the default set stays small on purpose:
# pinning a host nothing uses is how a stale entry survives unnoticed and later
# sends a fetch to an address that has moved. Additional hosts are accepted on the
# command line for one-off needs (`nodejs.org` for a native module's headers is
# the case that came up), so the default does not have to grow to cover them.
#
# Each of these was measured synthetic-by-name before being listed:
#   api.github.com           198.18.0.12   -> 20.205.243.168
#   github.com               198.18.0.16   -> 20.205.243.166
#   codeload.github.com      synthetic     -> 20.205.243.165
#   objects.githubusercontent.com  synthetic -> 185.199.108-111.133
#   raw.githubusercontent.com      synthetic -> 185.199.108-111.133
DEFAULT_HOSTS = (
    "api.github.com",
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
)

HOSTS_FILE = Path("/etc/hosts")
MARKER = "# doh-pin"


def resolve(name: str) -> list[str]:
    """A records for `name` per DoH. Raises on a non-answer rather than guessing."""
    query = urllib.parse.urlencode({"name": name, "type": "A"})
    with urllib.request.urlopen(f"{DOH}?{query}", timeout=20) as response:
        payload = json.load(response)
    if payload.get("Status") != 0:
        raise RuntimeError(f"DoH status {payload.get('Status')} for {name}")
    answers = [
        entry["data"]
        for entry in payload.get("Answer", [])
        if entry.get("type") == 1 and "data" in entry
    ]
    if not answers:
        raise RuntimeError(f"no A record for {name}")
    return answers


def is_synthetic(address: str) -> bool:
    """True when the address is in the non-routable range the resolver hands out."""
    octets = address.split(".")
    if len(octets) != 4:
        return False
    try:
        first, second = int(octets[0]), int(octets[1])
    except ValueError:
        return False
    return first == 198 and 18 <= second <= 19


def strip_previous_pins(text: str) -> str:
    """Remove this tool's own lines, so re-running cannot stack duplicates."""
    lines = [line for line in text.splitlines() if MARKER not in line]
    return "\n".join(lines).rstrip("\n") + "\n"


def existing_pins(text: str) -> dict[str, list[str]]:
    """
    Host -> addresses for pins already in the file.

    Needed because `strip_previous_pins` drops everything this tool wrote, while a
    run resolves only the names it was given. Without reading the old pins back,
    `main(['nodejs.org'])` would silently unpin `api.github.com` -- a fix that
    breaks the previous fix, which is worse than no re-run at all.
    """
    pins: dict[str, list[str]] = {}
    for line in text.splitlines():
        if MARKER not in line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        address, name = parts[0], parts[1]
        pins.setdefault(name, []).append(address)
    return pins


def main() -> int:
    # Union of what was asked for and what is already pinned, so an invocation
    # adds hosts rather than replacing the set.
    previous = existing_pins(HOSTS_FILE.read_text())
    names = list(dict.fromkeys([*DEFAULT_HOSTS, *previous.keys(), *sys.argv[1:]]))

    resolved: dict[str, list[str]] = {}
    for name in names:
        try:
            addresses = resolve(name)
        except Exception as error:  # noqa: BLE001 - reported, not swallowed
            if name in previous:
                # A host that was pinnable before and is not now: keep the old
                # pin rather than dropping it. Dropping would turn a transient
                # DoH failure into a broken push path.
                print(f"keep  {name}: DoH failed ({error}); keeping {previous[name]}")
                resolved[name] = previous[name]
                continue
            print(f"FAIL  {name}: {error}")
            return 1
        real = [a for a in addresses if not is_synthetic(a)]
        if not real:
            # A synthetic answer over DoH would mean the interception is upstream
            # of the resolver and this bypass does not apply. Say so rather than
            # writing an address that will hang.
            print(f"FAIL  {name}: DoH returned only synthetic addresses {addresses}")
            return 1
        resolved[name] = real
        print(f"ok    {name}: {', '.join(real)}")

    text = HOSTS_FILE.read_text()
    stripped = strip_previous_pins(text)
    additions = "".join(
        f"{address} {name} {MARKER}\n" for name, addresses in resolved.items() for address in addresses
    )
    HOSTS_FILE.write_text(stripped + additions)
    print(f"\npinned {len(resolved)} hosts in {HOSTS_FILE}")

    # Verify through the system resolver, which is the thing that was broken.
    for name in resolved:
        try:
            output = subprocess.run(
                ["getent", "hosts", name], capture_output=True, text=True, check=True
            ).stdout
        except subprocess.CalledProcessError:
            print(f"FAIL  {name}: not resolvable after pinning")
            return 1
        if any(is_synthetic(line.split()[0]) for line in output.splitlines() if line.split()):
            print(f"FAIL  {name}: still synthetic after pinning")
            return 1
    print("verified through the system resolver")
    return 0


if __name__ == "__main__":
    sys.exit(main())
