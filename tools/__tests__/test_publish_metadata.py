"""What a package says about itself, checked because no other test in this tree can see it.

Every field `publish-metadata.mjs` reads is a fact a **consumer** reads: the install-time node floor,
the `npm repo` link, the search keywords, and -- the one whose absence is not loud -- the access level a
scoped name defaults to. The five packages built, tested and passed 3,500 readings while none of those
fields existed, which is the property that makes them worth a gate rather than a checklist: a defect
with no failing test is a defect the next reader inherits as a fact about the world.

These tests pin three things the tool's own `--self-test` cannot:

  - **the rule count.** `--self-test` proves each rule fires; nothing but this file notices a rule that
    was deleted from the array, because a deleted rule is a green self-test with a shorter table.
  - **every rule appears in the `--check` table for every package.** A rule that is in the array and
    skipped by the audit -- a `run` that throws, a package filtered out -- would leave the self-test
    green because the self-test builds its own fixture tree.
  - **the repository's real answer.** The other two are about the instrument; this one is about the
    five packages that would be published, and it is the assertion that would have been red before this
    round: 15 rows, three per package.
"""

import json
import pathlib
import re
import subprocess

TOOL = pathlib.Path(__file__).resolve().parents[1] / "publish-metadata.mjs"
ROOT = pathlib.Path(__file__).resolve().parents[2]
PACKAGES = sorted((ROOT / "packages").glob("*/package.json"))

# The rule names, restated here on purpose. A set imported from the tool would agree with the tool by
# construction, and the failure this sentence guards is the tool losing a rule.
EXPECTED_RULES = {
    "scoped-name",
    "semver",
    "one-version",
    "description",
    "license-file",
    "files-dist-only",
    "public-access",
    "engines-node",
    "repository-directory",
    "entry-inside-dist",
    "workspace-targets-exist",
}


def _run(*args: str, root: pathlib.Path | None = None) -> subprocess.CompletedProcess:
    env = None
    if root is not None:
        import os

        env = {**os.environ, "PUBLISH_METADATA_ROOT": str(root)}
    return subprocess.run(
        ["node", str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
        env=env,
    )


def test_the_self_test_passes() -> None:
    """Every rule must be provable, and the fixture count is the proof."""
    result = _run("--self-test")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS  publish-metadata self-test" in result.stdout
    assert "FAIL" not in result.stdout
    # 2 tree-level assertions, 1 rule-count assertion, 13 single-defect cases, 1 version-drift case, 1
    # missing-LICENSE case, 1 render case and the closing line. Counted rather than described, because a
    # case that stops being built is a defect class that stops being proved and its assertion simply
    # disappears from the output.
    assert result.stdout.count("PASS  ") == 20, result.stdout


def test_the_rule_count_is_the_documented_one() -> None:
    """A deleted rule is a green self-test with a shorter table, so the count is a reading."""
    result = _run("--self-test")
    match = re.search(r"the rule count is eleven, and this line has to be edited when it is not \((\d+)\)", result.stdout)
    assert match is not None, result.stdout
    assert int(match.group(1)) == len(EXPECTED_RULES)


def test_check_prints_every_rule_for_every_package() -> None:
    """The table is the report; a rule missing from it is a rule nobody applied."""
    result = _run("--check")
    rows = [line for line in result.stdout.splitlines() if line.startswith("| `")]
    assert result.returncode == 0, result.stdout + result.stderr
    assert len(rows) == len(PACKAGES) * len(EXPECTED_RULES), f"{len(rows)} rows for {len(PACKAGES)} packages"
    seen = {line.split("|")[2].strip() for line in rows}
    assert seen == EXPECTED_RULES, sorted(EXPECTED_RULES - seen)
    assert "**RED**" not in result.stdout


def test_the_published_packages_declare_what_a_consumer_needs() -> None:
    """The five fields a first publish turns on, read from the files rather than from the report.

    Restated as its own assertions because the report could agree with the tool and both could be
    wrong about npm: this block reads `package.json` directly, and each line names the consequence
    rather than the field.
    """
    assert PACKAGES, "no packages found"
    for path in PACKAGES:
        package = json.loads(path.read_text(encoding="utf-8"))
        name = package["name"]
        assert package.get("publishConfig", {}).get("access") == "public", (
            f"{name}: a scoped name defaults to restricted, so a first publish either fails or lands "
            "in a paid private scope"
        )
        assert package.get("engines", {}).get("node") == ">=22.0.0", (
            f"{name}: without a node floor the install succeeds into a tree the runtime cannot run"
        )
        repository = package.get("repository", {})
        assert repository.get("directory") == f"packages/{path.parent.name}", (
            f"{name}: the monorepo link a consumer follows has to point at this package's own directory"
        )
        assert repository.get("url", "").endswith("AgentiX-E/cortex.git"), f"{name}: repository.url is not the source"
        assert package.get("license") == "MIT"
        assert package.get("files") == ["dist"], f"{name}: publishes something other than dist"


def test_a_tree_with_one_defect_is_refused_by_name(tmp_path: pathlib.Path) -> None:
    """The instrument end to end, once, so `--check` is not only ever exercised on a green tree."""
    (tmp_path / "packages" / "one").mkdir(parents=True)
    (tmp_path / "package.json").write_text(json.dumps({"engines": {"node": ">=22.0.0"}}))
    (tmp_path / "LICENSE").write_text("MIT\n")
    (tmp_path / "packages" / "one" / "package.json").write_text(
        json.dumps(
            {
                "name": "@agentix-e/one",
                "version": "0.1.0",
                "description": "one",
                "license": "MIT",
                "main": "./dist/index.js",
                "types": "./dist/index.d.ts",
                "files": ["dist"],
                "publishConfig": {"access": "restricted"},
                "engines": {"node": ">=22.0.0"},
                "repository": {"type": "git", "url": "x", "directory": "packages/one"},
            }
        )
    )
    result = _run("--check", root=tmp_path)
    assert result.returncode == 1
    # The table goes to stdout on both paths and the refusal to stderr, so the row is read from the
    # stream that carries readings and the sentence from the stream that carries the failure.
    assert "public-access" in result.stdout
    assert "**RED**" in result.stdout
    assert "1 red row(s)" in result.stderr
