"""Pushes the local HEAD to AgentiX-E/cortex through the GitHub Git Data API.

Why not `git push`: the sandbox proxy admits api.github.com only, so the git
transport cannot be used. The API can still build a commit from blobs.

Why not the previous version of this script: it ran `git diff remote..head`, which
needs the remote commit in the local object store. Earlier pushes went through the
API, so the remote commits have no local counterpart and `git log` fails. This
version never asks git about a remote revision; it reads the remote tree over the
API and compares path -> blob-SHA maps, which is exact.

Why the verification does not compare tree SHAs: the API rebuilds the commit and
its tree, re-rooting the same paths into a different tree object. A tree-SHA
comparison therefore fails on a perfectly correct push. That happened, and it sent
me looking for a content problem that did not exist. Content is the property that
matters, so content is what is compared.

Usage: python3 tools/push-via-api.py
"""
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

# The repo is derived from `origin`, not written down here.
#
# It was the literal "AgentiX-E/cortex", and running this script from a checkout
# of cortex-docs -- which has its own `origin` and its own token -- would have
# pushed cortex-docs content into the cortex repository. The push was killed
# before it completed, and the fix is to read the remote rather than to remember
# to edit a constant: the wrong repo is now unrepresentable, not merely
# discouraged.
def _origin() -> tuple[str, str]:
    # A missing `.git`, a missing `origin`, and an `origin` that is not GitHub are three
    # problems with three fixes, and none of them is a traceback about a subprocess.
    try:
        listed = subprocess.run(
            ["git", "remote", "get-url", "origin"], check=True, capture_output=True, text=True
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit(
            "cannot read `origin` (git remote get-url origin failed): run this from the "
            "repository root, in a checkout whose origin is the repository you mean to push"
        )
    for line in listed.splitlines():
        url = line.strip()
        if "github.com" in url:
            path = url.split("github.com", 1)[1].lstrip(":/").removesuffix(".git")
            owner, _, name = path.partition("/")
            if owner and name:
                return f"{owner}/{name}", "master"
    sys.exit("origin is not a github.com remote; refusing to guess a repository")


_ORIGIN: tuple[str, str] | None = None
_TOKEN: str | None = None


def origin() -> tuple[str, str]:
    """The repository and branch, read from `origin` on first use.

    ## Why not at import

    This used to be `REPO, BRANCH = _origin()` at module level, which made **importing**
    this script run `git remote get-url origin`. Outside a checkout the import therefore
    failed with a `CalledProcessError` about a git command -- and a test that imported any
    pure helper here would have needed a git repository with the right remote.

    The identical defect was found in `dispatch-cortex-memory-ab.py` by the first test that
    imported it (§13.47). This file has no such test yet, and this repair is what makes the
    day it gets one a day that works.
    """
    global _ORIGIN
    if _ORIGIN is None:
        _ORIGIN = _origin()
    return _ORIGIN


def repo() -> str:
    return origin()[0]


def branch() -> str:
    return origin()[1]


def token() -> str:
    """The PAT from `.git/config`, read on first use. See `origin` for why it is lazy."""
    global _TOKEN
    if _TOKEN is None:
        try:
            config = open(".git/config").read().splitlines()
        except FileNotFoundError:
            sys.exit(
                "no .git/config in the working directory: the push token comes from the "
                "checkout's own config, so run this from the repository root"
            )
        for line in config:
            if "oauth2:" in line:
                _TOKEN = line.split("oauth2:", 1)[1].split("@", 1)[0]
                return _TOKEN
        sys.exit("no oauth2 token in .git/config")
    return _TOKEN


def req(method: str, path: str, payload=None):
    """One API call, retried on transient failures."""
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"https://api.github.com{path}", data=body, method=method)
    request.add_header("Authorization", f"Bearer {token()}")
    request.add_header("Accept", "application/vnd.github+json")
    if body:
        request.add_header("Content-Type", "application/json")
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            if error.code in (500, 502, 503, 504) and attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {error.code}\n{detail}")
        except Exception as error:  # noqa: BLE001 - network layer, retried uniformly
            if attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"{method} {path} -> {error}")


def blob_payload(path: str) -> dict:
    """The JSON body for `POST /git/blobs`, for a file of any kind.

    ## Why base64 and not `encoding: "utf-8"`

    This function read every blob as UTF-8 with `surrogateescape` and sent it as
    `encoding: "utf-8"`. That is lossless for text and **corrupting for anything else**: a PNG has
    bytes that are not valid UTF-8, the surrogate escape produces strings the JSON encoder rewrites,
    and the blob that lands on the remote is not the file. The first push that carried a binary --
    two screenshots, step 16 -- produced blobs of 118 KB from files of 64 KB, and the verification
    step caught it *after* the branch had already been moved.

    base64 is the encoding the API is designed for and it is exact for both kinds of file, so there
    is no branch here to get wrong.
    """
    with open(path, "rb") as handle:
        raw = handle.read()
    return {"content": base64.b64encode(raw).decode("ascii"), "encoding": "base64"}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


def remote_blobs(tree_sha: str) -> dict[str, str]:
    """Every blob under a remote tree, as path -> SHA."""
    result = req("GET", f"/repos/{repo()}/git/trees/{tree_sha}?recursive=1")
    if result.get("truncated"):
        sys.exit("remote tree listing truncated; cannot verify completeness")
    return {
        item["path"]: item["sha"] for item in result.get("tree", []) if item["type"] == "blob"
    }


def local_blobs(tree_sha: str) -> dict[str, str]:
    """Every blob in a local tree, as path -> SHA. The local half of a comparison."""
    out = {}
    for line in git("ls-tree", "-r", tree_sha).splitlines():
        meta, path = line.split("\t", 1)
        _, kind, sha = meta.split()
        if kind == "blob":
            out[path] = sha
    return out


def report_mismatch(remote: dict[str, str], local: dict[str, str]) -> None:
    """Exits non-zero, naming every path that is missing, extra or different."""
    missing = sorted(set(local) - set(remote))
    extra = sorted(set(remote) - set(local))
    differing = sorted(
        path for path in set(local) & set(remote) if local[path] != remote[path]
    )
    sys.exit(
        "CONTENT MISMATCH\n"
        f"  missing remotely: {missing[:20]}\n"
        f"  extra remotely:   {extra[:20]}\n"
        f"  differing:        {differing[:20]}"
    )


def main() -> int:
    head = git("rev-parse", "HEAD")
    local_tree = git("rev-parse", f"{head}^{{tree}}")
    remote_head = req("GET", f"/repos/{repo()}/git/refs/heads/{branch()}")["object"]["sha"]
    remote_tree = req("GET", f"/repos/{repo()}/git/commits/{remote_head}")["tree"]["sha"]

    if local_tree == remote_tree:
        print(f"nothing to push: trees already match ({local_tree[:12]})")
        return 0

    print(f"remote {remote_head[:8]} tree {remote_tree[:12]}")
    print(f"local  {head[:8]} tree {local_tree[:12]}")

    remote_map = remote_blobs(remote_tree)
    local_map = local_blobs(local_tree)

    changed = sorted(
        [path for path, sha in local_map.items() if remote_map.get(path) != sha]
        + [path for path in remote_map if path not in local_map]
    )
    print(f"changed paths: {len(changed)}")

    if not changed:
        # Every blob already matches, so the content is on the remote even though
        # the tree SHAs differ. Commit nothing: the API rejects an empty tree with
        # 422 "Invalid tree info".
        if remote_map == local_map:
            print(f"nothing to push: all {len(local_map)} blobs already identical on the remote")
            return 0
        report_mismatch(remote_map, local_map)

    entries = []
    for path in changed:
        if path not in local_map:
            # Present remotely, absent locally: delete it.
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            print(f"  {path} -> deleted")
            continue
        result = req("POST", f"/repos/{repo()}/git/blobs", blob_payload(path))
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": result["sha"]})
        print(f"  {path} -> {result['sha'][:8]}")

    tree = req("POST", f"/repos/{repo()}/git/trees", {"base_tree": remote_tree, "tree": entries})
    message = git("log", "-1", "--pretty=%B").rstrip("\n")
    commit = req(
        "POST",
        f"/repos/{repo()}/git/commits",
        {
            "message": message,
            "tree": tree["sha"],
            "parents": [remote_head],
            "author": {
                "name": git("log", "-1", "--pretty=%an"),
                "email": git("log", "-1", "--pretty=%ae"),
                "date": git("log", "-1", "--pretty=%aI"),
            },
            "committer": {
                "name": git("log", "-1", "--pretty=%cn"),
                "email": git("log", "-1", "--pretty=%ce"),
                "date": git("log", "-1", "--pretty=%cI"),
            },
        },
    )
    # Verified **before** the branch moves. The previous order created the commit, moved the ref, and
    # only then compared -- so a mismatch left a corrupted commit on the branch and reported it
    # afterwards. A check that runs after the damage is a post-mortem, not a gate.
    pushed = remote_blobs(commit["tree"]["sha"])
    if pushed != local_map:
        report_mismatch(pushed, local_map)

    req("PATCH", f"/repos/{repo()}/git/refs/heads/{branch()}", {"sha": commit["sha"], "force": False})
    print(f"pushed {commit['sha']}")

    after = remote_blobs(commit["tree"]["sha"])
    if after != local_map:
        report_mismatch(after, local_map)
    print(
        f"verified: {len(local_map)} blobs byte-identical local vs remote "
        f"(tree SHAs differ only because the API rebuilds the tree object)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
