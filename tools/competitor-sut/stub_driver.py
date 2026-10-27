#!/usr/bin/env python3
"""A deterministic driver for the system-under-test protocol.

## Why this exists beside `mem0_driver.py`

Two reasons, and the second is the one that pays.

**It is the protocol's executable specification.** A protocol document is a claim about a conversation, and the
only way to find out whether it is a *possible* conversation is to hold both ends. This driver is the smallest
one that is honest about all five operations, so every parent-side test runs with no competitor, no network, no
key and no cost.

**It is the floor arm.** Its ranking is lexical overlap over the turns it was given, which is the same idea as
`LexicalProvider` — so a run that includes both should produce the same recall *order* and different numbers only
where the driver's protocol round-trip loses something. When they disagree, the disagreement is about this
protocol rather than about anyone's memory system, which is exactly what a floor is for.

## What it deliberately does not do

No stemming, no IDF, no embeddings, no LLM. Every one of those would make this driver a competitor, and a
competitor that exists only to be beaten is not a measurement. It reports `build: "none"` and says in its notes
that it is a reference implementation.
"""

from __future__ import annotations

import json
import math
import re
import sys
from typing import Any

NAME = "reference/lexical"
VERSION = "1.0.0"

_TOKEN = re.compile(r"[a-z0-9]+")


def terms(text: str) -> set[str]:
    """The token set the ranking is over.

    Lower-cased and split on anything that is not alphanumeric. No stemming: the point of the floor is that a
    reader can reproduce it by hand.
    """
    return {token for token in _TOKEN.findall(text.lower()) if len(token) > 1}


class Store:
    """Every turn this driver has been given, in arrival order."""

    def __init__(self) -> None:
        self.entries: list[tuple[str, int | None]] = []

    def reset(self) -> None:
        self.entries = []

    def ingest(self, sessions: list[dict[str, Any]]) -> dict[str, Any]:
        turns = 0
        skipped: list[str] = []
        for session in sessions:
            content = session.get("turns") or []
            if not content:
                # An empty session is not an error, but it is not silent either: a corpus whose sessions arrive
                # empty is a parsing failure upstream and the count is the only place it shows.
                skipped.append(f"session {session.get('id', '?')} had no turns")
                continue
            at = session.get("at")
            for turn in content:
                self.entries.append((str(turn.get("content", "")), at))
                turns += 1
        return {"sessions": len(sessions) - len(skipped), "turns": turns, "skipped": skipped}

    def search(self, query: str, limit: int) -> dict[str, Any]:
        wanted = terms(query)
        scored: list[tuple[float, int, str, int | None]] = []
        for position, (text, at) in enumerate(self.entries):
            overlap = wanted & terms(text)
            if not overlap:
                continue
            # Length-normalised so a long turn cannot win by containing more words, which is the difference
            # between a lexical baseline and a bag of text.
            score = len(overlap) / math.sqrt(max(len(terms(text)), 1))
            # `-position` keeps the sort total: two turns with the same score stay in arrival order, so two runs
            # over one corpus produce one order.
            scored.append((score, -position, text, at))
        scored.sort(reverse=True)
        return {
            "hits": [
                {"text": text, "score": round(score, 6), **({"at": at} if at is not None else {})}
                for score, _, text, at in scored[:limit]
            ]
        }


def handle(store: Store, request: dict[str, Any]) -> dict[str, Any]:
    op = request.get("op")
    if op == "manifest":
        return {
            "ok": True,
            "name": NAME,
            "build": "none",
            "version": VERSION,
            "notes": "reference implementation of the SUT protocol; lexical overlap, no model, no vectors",
        }
    if op == "reset":
        store.reset()
        return {"ok": True}
    if op == "ingest":
        return {"ok": True, **store.ingest(list(request.get("sessions") or []))}
    if op == "search":
        limit = int(request.get("limit") or 0)
        if limit <= 0:
            return {"ok": False, "error": "search needs a positive limit"}
        return {"ok": True, **store.search(str(request.get("query") or ""), limit)}
    if op == "shutdown":
        return {"ok": True}
    return {"ok": False, "error": f"unknown op {op!r}"}


def main() -> int:
    store = Store()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            print(json.dumps({"ok": False, "error": f"request is not JSON: {error}"}), flush=True)
            continue
        response = handle(store, request)
        print(json.dumps(response), flush=True)
        if request.get("op") == "shutdown" and response.get("ok"):
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
