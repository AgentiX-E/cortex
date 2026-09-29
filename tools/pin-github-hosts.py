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

## The acceptance test is a measured success rate

An address is pinned only after it answered three real HTTPS requests. Not after
its certificate was read, and not after one probe succeeded.

This was learned by getting it wrong twice in one sitting. A first draft pinned
whatever DoH answered, because DoH's answer had worked once. A second draft
concluded DoH's answer was blackholed, because a single `curl` to it failed with
`SSL_ERROR_SYSCALL` at 5.001s while a `curl` to another address returned 200.
Both were single samples of an intermittent quantity, and one more request
reversed the second conclusion completely:

    20.205.243.166  -> handshake OK, b'HTTP/1.1 200 OK'
    140.82.112.3    -> handshake OK, then read timeout

Three attempts per address gave the actual shape (`github.com`): `140.82.112.3`
and `.113.3` at 3/3, `20.205.243.166` and `.167` at 2/3, `140.82.114.3` at 1/3.
A later run of the same probe returned 3/3 for all of them. The set is mostly
fine with a per-address rate below 1 that moves with time, so `1/3` and `3/3`
must not both read as "works" -- which is what a single probe makes them do.

**A certificate read is weaker than a request.** A handshake completes before any
application data is sent, so `getpeercert()` succeeds against an endpoint that
then drops the connection. It looked like a discriminator for exactly one sample.

So the order is: DoH proposes candidates, three real requests rank them, the most
reliable is pinned, and the system resolver is re-read at the end to confirm what
the rest of the machine will actually use.
"""

from __future__ import annotations

import json
import socket
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DOH = "https://dns.alidns.com/resolve"

# Candidate addresses per host, used when DoH's own answer fails the certificate
# test. These are GitHub's published ranges, and they are candidates rather than
# answers: each is accepted only if its certificate covers the hostname, so a
# value that goes stale is rejected instead of pinned.
#
# Listed because DoH was measured handing out a blackholed address (see the
# module docstring): with only the DoH answer to choose from, the script would
# have pinned a host that never works.
FALLBACK_CANDIDATES: dict[str, tuple[str, ...]] = {
    "api.github.com": ("140.82.112.6", "140.82.113.6", "140.82.114.6", "140.82.121.6"),
    "github.com": ("140.82.112.3", "140.82.113.3", "140.82.114.3", "140.82.121.3"),
    "codeload.github.com": ("140.82.112.9", "140.82.113.9", "140.82.114.9", "140.82.121.9"),
    "objects.githubusercontent.com": (
        "185.199.108.133",
        "185.199.109.133",
        "185.199.110.133",
        "185.199.111.133",
    ),
    "raw.githubusercontent.com": (
        "185.199.108.133",
        "185.199.109.133",
        "185.199.110.133",
        "185.199.111.133",
    ),
}

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

# Every name this tool owns, whatever wrote the line. `strip_previous_pins` reads
# this, so it must include anything an earlier run could have pinned -- which is
# why it is derived from the defaults plus whatever the file currently pins, and
# not a second hand-maintained list that would drift from the first.
def managed_hosts(extra: tuple[str, ...] = ()) -> frozenset[str]:
    return frozenset((*DEFAULT_HOSTS, *extra))


def count_resolvers(getent_output: str, name: str) -> int:
    """
    How many `A` records the system resolver reports for `name`.

    The post-pin check used to ask whether ANY reported address was real. That
    question has the wrong answer set: with a stale pin in place the name resolves
    to one real address AND another, so "is one of them real" is `True` while the
    host is broken. Counting is what makes the defect visible, and the expected
    count is exactly one -- a second record means the file was not fully cleaned.

    Comment lines are ignored; `getent` prints none, but this also accepts a
    hand-edited file's shape without silently counting a comment as an answer.
    """
    count = 0
    for line in getent_output.splitlines():
        parts = line.split("#", 1)[0].split()
        if len(parts) >= 2 and parts[1] == name:
            count += 1
    return count


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


def end_to_end_ok(host: str, address: str, timeout: float = 8.0) -> bool:
    """
    Whether a real HTTPS request to `address` for `host` returns a status line.

    This is the acceptance test for a pinned address, and it is deliberately
    stronger than reading the certificate.

    Why the certificate alone is not enough, measured 2026-09-29: a handshake to
    `20.205.243.166` for `github.com` completed and presented a valid
    Sectigo-issued certificate, and a `curl` to the same address one minute
    earlier had failed with `SSL_ERROR_SYSCALL` at exactly 5.001s. `getpeercert`
    reads what the peer sends during the handshake; it does not establish that
    the connection carries data. The endpoints here are not equally stable, and
    only an application-level exchange distinguishes them.
    """
    try:
        context = ssl.create_default_context()
        with socket.create_connection((address, 443), timeout=timeout) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                tls.sendall(f"GET / HTTP/1.0\r\nHost: {host}\r\n\r\n".encode())
                return tls.recv(16).startswith(b"HTTP/")
    except Exception:  # noqa: BLE001 - every failure mode means the same thing
        return False


def reliability(host: str, address: str, attempts: int = 3) -> int:
    """
    How many of `attempts` real requests to `address` succeeded.

    A rate rather than a single result, because the measured failure mode is
    intermittent rather than binary. Measured 2026-09-29 over three attempts per
    address:

        github.com  140.82.112.3     3/3      <- stable
        github.com  140.82.113.3     3/3      <- stable
        github.com  20.205.243.166   2/3      <- intermittent
        github.com  20.205.243.167   2/3      <- intermittent
        github.com  140.82.114.3     1/3      <- mostly broken

    A single success made every one of those look identical, which is how a
    first attempt at this check concluded the DoH answer was blackholed and a
    second concluded the opposite. Both were single samples of an intermittent
    quantity; only the rate separates them.
    """
    return sum(1 for _ in range(attempts) if end_to_end_ok(host, address))


def select(name: str, proposed: list[str], previous: list[str], attempts: int = 3) -> list[str]:
    """
    The address to pin for `name`: the most reliable candidate, ties to the first.

    Tried in priority order, and the order is deliberate:

      1. what the previous pin used, so a working pin is stable across runs and
         an operator reading the file twice sees the same answer;
      2. what DoH proposed, filtered of synthetic answers;
      3. `FALLBACK_CANDIDATES[name]`.

    Ranking is by measured reliability, not by first success. A candidate is
    accepted only if it succeeded on EVERY attempt: the pin is what every later
    push depends on, and an address that works two times in three turns an
    intermittent fault into a push that fails once and looks like a content
    problem. When nothing is perfect the best rate wins and is reported as such,
    so the caller can see the pin is a best-effort rather than a clean one.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    for address in [*previous, *proposed, *FALLBACK_CANDIDATES.get(name, ())]:
        if address in seen or is_synthetic(address):
            continue
        seen.add(address)
        ordered.append(address)

    scored = [(address, reliability(name, address, attempts)) for address in ordered]
    if not scored:
        return []
    best_address, best_score = max(scored, key=lambda pair: pair[1])
    if best_score == 0:
        return []
    detail = ", ".join(f"{address} {score}/{attempts}" for address, score in scored)
    if best_score < attempts:
        print(f"note  {name}: no address was fully reliable ({detail}); using the best")
    else:
        print(f"note  {name}: candidates {detail}")
    return [best_address]


def existing_pins(text: str) -> dict[str, list[str]]:
    """
    Host -> addresses for pins already in the file.

    Needed because `strip_previous_pins` drops everything this tool wrote, while a
    run resolves only the names it was given. Without reading the old pins back,
    `main(['nodejs.org'])` would silently unpin `api.github.com` -- a fix that
    breaks the previous fix, which is worse than no re-run at all.

    A marked line records a pin by DEFINITION, so the marker is the test for
    membership. The fields are then parsed from the comment-free part, which is
    the same parse `strip_previous_pins` uses: reading `parts[1]` off the raw line
    turns `"ADDRESS # doh-pin"` -- a truncated write -- into a host named `"#"`,
    and a pin for a host that cannot exist would be carried forward forever.
    """
    pins: dict[str, list[str]] = {}
    for line in text.splitlines():
        if MARKER not in line:
            continue
        parts = line.split("#", 1)[0].split()
        if len(parts) < 2:
            continue
        address, name = parts[0], parts[1]
        pins.setdefault(name, []).append(address)
    return pins


def strip_previous_pins(text: str) -> str:
    """
    Remove every line that names a managed host, so re-running cannot stack.

    This used to remove only lines carrying `MARKER`, on the theory that the
    marker is this tool's ownership record and unmarked lines belong to someone
    else. The theory is wrong for the case that matters: a pin written by hand, or
    by a revision of this tool predating the marker, is ALSO this tool's line in
    effect -- it names the same hosts, it is there for the same reason, and it is
    the reason the host resolves twice.

    Two `A` records for one name is not a half-applied fix. `getent` returns both,
    a caller takes whichever it tries first, and the observable result is an
    intermittent `gnutls_handshake() failed` on a name that resolves correctly --
    which is indistinguishable from a network outage, and was diagnosed as one.
    Measured 2026-09-29: `/etc/hosts` carried four unmarked pins from an earlier
    session alongside the current four.

    The name is read from the SECOND whitespace field, so an aliased line
    (`ADDRESS host alias`) is still recognised, and the match is on the whole
    field, so `api.github.com.evil.example` is left alone.
    """
    keep = []
    managed = managed_hosts(tuple(existing_pins(text).keys()))
    for line in text.splitlines():
        parts = line.split("#", 1)[0].split()
        if len(parts) >= 2 and parts[1] in managed:
            continue
        keep.append(line)
    return "\n".join(keep).rstrip("\n") + "\n"


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
            # A DoH failure is no longer fatal on its own: the candidate list
            # includes the fallbacks, and the certificate still has to accept
            # whatever is chosen. Reported because it is worth knowing that one
            # of the two sources was unavailable.
            print(f"note  {name}: DoH failed ({error}); falling back to candidates")
            addresses = []
        real = [a for a in addresses if not is_synthetic(a)]

        chosen = select(name, real, previous.get(name, []))
        if not chosen:
            # Every candidate failed every attempt. Saying so is the point:
            # writing one of them anyway would produce exactly the five-second
            # TLS hang this script exists to remove, and the pin would look like
            # it had been applied.
            print(
                f"FAIL  {name}: no candidate answered a real request "
                f"(tried {', '.join(real) or 'none'} from DoH plus fallbacks)"
            )
            return 1
        resolved[name] = chosen
        print(f"ok    {name}: {', '.join(chosen)}")

    text = HOSTS_FILE.read_text()
    stripped = strip_previous_pins(text)
    additions = "".join(
        f"{address} {name} {MARKER}\n" for name, addresses in resolved.items() for address in addresses
    )
    HOSTS_FILE.write_text(stripped + additions)
    print(f"\npinned {len(resolved)} hosts in {HOSTS_FILE}")

    # Verify through the system resolver, which is the thing that was broken.
    #
    # Two questions, and the second is the one the earlier revision failed to
    # ask. "Did a real address appear" passes while a stale second record is
    # still there; "how many records did this name get" does not. Exactly one is
    # the contract, because the file was just rewritten to contain exactly one
    # line per host, so a second answer comes from somewhere this tool does not
    # control and the pin is not in effect.
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
        sources = count_resolvers(output, name)
        if sources != 1:
            print(
                f"FAIL  {name}: resolves to {sources} address(es), expected 1 — another\n"
                f"      source is overriding the pin. Look for an unmarked line for this\n"
                f"      name elsewhere in {HOSTS_FILE}, or a resolver that precedes it."
            )
            return 1
    print("verified through the system resolver")
    return 0


if __name__ == "__main__":
    sys.exit(main())
