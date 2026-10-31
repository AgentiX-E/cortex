"""Download a GitHub Actions artifact in ranged chunks, resuming across dropped connections.

Why not `curl -C -`: each call to the artifact's API URL answers 303 with a *fresh* signed
blob URL. `curl -C -` then asks that new URL for a byte range, and when the response comes
back 200 instead of 206 the flag makes curl truncate and rewrite from zero -- so a retry
loop can move backwards. That happened here (13.3 MB then 12.7 MB) and it is why this
script exists rather than another retry wrapper.

Why chunks at all: the transfer runs at roughly 10 KB/s through this proxy and dies at
around 6 MB. A chunk that dies costs one chunk. Each chunk asks the API for a fresh
signature, which the blob service honours because every request carries its own range.
"""
import os
import sys
import time
import urllib.error
import urllib.request

ARTIFACT_ID = sys.argv[1] if len(sys.argv) > 1 else "13046359642"
ARTIFACT = f"https://api.github.com/repos/AgentiX-E/cortex/actions/artifacts/{ARTIFACT_ID}/zip"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/a41203245999.zip"
CHUNK = 2 * 1024 * 1024


def token() -> str:
    with open("/workspace/cortex/.git/config", encoding="utf-8") as handle:
        for line in handle:
            if "oauth2:" in line:
                return line.split("oauth2:", 1)[1].split("@", 1)[0]
    raise SystemExit("no oauth2 token in .git/config")


def signed_url() -> str:
    request = urllib.request.Request(ARTIFACT, headers={"Authorization": f"Bearer {token()}"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        if error.code in (301, 302, 303, 307):
            return error.headers["Location"]
        raise SystemExit(f"artifact redirect failed: {error.code} {error.reason}")
    raise SystemExit("artifact URL answered without a redirect; nothing to stream")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def total_size(url: str) -> int:
    request = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(request, timeout=60) as response:
        return int(response.headers["Content-Length"])


def main() -> int:
    done = os.path.getsize(OUT) if os.path.exists(OUT) else 0
    url = signed_url()
    size = total_size(url)
    print(f"artifact {size} bytes, have {done}", flush=True)
    attempts = 0
    while done < size:
        end = min(done + CHUNK - 1, size - 1)
        request = urllib.request.Request(url, headers={"Range": f"bytes={done}-{end}"})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                blob = response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            attempts += 1
            print(f"chunk at {done} failed ({error}); attempt {attempts}", flush=True)
            if attempts > 40:
                raise SystemExit("too many failed chunks")
            time.sleep(2)
            url = signed_url()
            continue
        if not blob:
            raise SystemExit(f"empty chunk at {done} of {size}")
        with open(OUT, "ab") as handle:
            handle.write(blob)
        done += len(blob)
        print(f"  {done}/{size} ({100 * done / size:.1f}%)", flush=True)
    print("complete", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
