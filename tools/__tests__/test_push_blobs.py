#!/usr/bin/env python3
"""The push tool must upload bytes exactly, and must refuse before it publishes.

## The defect this file is written against

`tools/push-via-api.py` sent every blob as `encoding: "utf-8"`, having read the file with
`surrogateescape`. That is lossless for source code and **corrupting for a PNG**: the first push
carrying binaries -- two screenshots in step 16 -- produced remote blobs of 118 KB from local files of
64 KB. The verification caught it, and by then the branch had already been moved, so the repository
was left with a commit whose images are not images.

Two properties are checked here, and they are different failures:

1. **The payload round-trips.** Same bytes in, same bytes out, for content that is not valid UTF-8.
   A test on text alone would pass with the broken implementation, which is why the fixture is a byte
   sequence no UTF-8 decoder accepts.
2. **The order is verify-then-publish.** A check that runs after the ref moves is a post-mortem. The
   assertion is on the source: `report_mismatch` must appear before the `PATCH` on the ref, because
   the failure this guards cannot be exercised without a remote to corrupt.

## What it does not do

It does not run a push. That needs a repository to write to, and a test that writes to one is a test
that fails when two of them run at once. The two properties above are the whole content of the
guarantee; everything else in that script is HTTP plumbing with its own retries.
"""

from __future__ import annotations

import base64
import importlib.util
import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "push-via-api.py"


def load():
    """Import the tool by path: the file name has dashes, so it is not an importable module name."""
    spec = importlib.util.spec_from_file_location("push_via_api", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


# A PNG header and a body that no UTF-8 decoder accepts: 0x89 is a continuation byte, 0xff and 0xfe
# never appear in UTF-8 text.
BINARY = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x01, 0xC3, 0x28])


class BlobPayloadTest(unittest.TestCase):
    def payload(self, raw: bytes) -> dict:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            handle.write(raw)
            path = handle.name
        try:
            return load().blob_payload(path)
        finally:
            Path(path).unlink()

    def test_binary_round_trips_exactly(self) -> None:
        payload = self.payload(BINARY)
        self.assertEqual(payload["encoding"], "base64")
        self.assertEqual(base64.b64decode(payload["content"]), BINARY)

    def test_text_round_trips_exactly(self) -> None:
        text = "readme with an em dash — and a newline\n".encode("utf-8")
        payload = self.payload(text)
        self.assertEqual(base64.b64decode(payload["content"]), text)

    def test_empty_file_is_not_an_error(self) -> None:
        payload = self.payload(b"")
        self.assertEqual(payload, {"content": "", "encoding": "base64"})

    def test_encoding_is_declared_rather_than_assumed(self) -> None:
        # The API defaults to utf-8 when `encoding` is absent, which is the exact assumption that
        # corrupted the screenshots. Declaring it is the fix, so the key's presence is asserted.
        self.assertIn("encoding", self.payload(BINARY))


class OrderTest(unittest.TestCase):
    def test_the_ref_moves_only_after_verification(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        body = source[source.index("def main()") :]
        verify = body.index("report_mismatch(pushed, local_map)")
        publish = body.index('"PATCH", f"/repos/{repo()}/git/refs/heads/{branch()}"')
        self.assertLess(verify, publish, "the ref is moved before the blobs are verified")

    def test_no_blob_is_ever_sent_as_utf8(self) -> None:
        # A single remaining `encoding: "utf-8"` on a blob upload is enough to corrupt the next PNG.
        self.assertNotIn('"encoding": "utf-8"', SCRIPT.read_text(encoding="utf-8"))
        self.assertIsNotNone(re.search(r'blob_payload\(path\)', SCRIPT.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
