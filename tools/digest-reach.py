"""B1/B2 on prompt digests: did the window reach the routes it claims, and only those?

The pre-registration states B1 as "every MR/TR prompt digest changed" and B2 as "IE/KU/ABS unchanged per
question". B2's second half was written on *correctness*, which is a stochastic quantity across two dispatches of
one reader; the digest is the deterministic one, and it is what the reach claim is actually about. Both are
computed here so the two readings can be reported side by side.
"""

import json
import sys
from collections import defaultdict


def truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return bool(value)


def by_question(path):
    report = json.load(open(path))
    out = {}
    for question in report["questions"]:
        out[question["questionId"]] = {
            "capability": question["capability"],
            "route": question.get("route"),
            "digest": question.get("promptDigest"),
            "variants": question.get("promptVariants"),
            "chars": question.get("deliveredPromptChars"),
            "correct": truthy(question["correct"]),
        }
    return out


def main(argv):
    before = by_question(argv[1])
    after = by_question(argv[2])
    shared = sorted(set(before) & set(after))
    print(f"paired questions: {len(shared)}")

    table = defaultdict(lambda: {"n": 0, "same": 0, "changed": 0, "missing": 0, "chars_delta": 0})
    for qid in shared:
        a, b = before[qid], after[qid]
        bucket = table[a["capability"]]
        bucket["n"] += 1
        if a["digest"] is None or b["digest"] is None:
            bucket["missing"] += 1
        elif a["digest"] == b["digest"]:
            bucket["same"] += 1
        else:
            bucket["changed"] += 1
        if isinstance(a["chars"], int) and isinstance(b["chars"], int):
            bucket["chars_delta"] += b["chars"] - a["chars"]

    print(f'\n{"capability":<12}{"n":>5}{"same":>7}{"changed":>9}{"no digest":>11}{"chars delta":>13}')
    for capability in ("IE", "MR", "KU", "TR", "ABS"):
        if capability not in table:
            continue
        row = table[capability]
        print(
            f'{capability:<12}{row["n"]:>5}{row["same"]:>7}{row["changed"]:>9}'
            f'{row["missing"]:>11}{row["chars_delta"]:>+13}'
        )

    # B1: the two routes the window reaches must all differ. B2: the three it cannot reach must all match.
    reached = ("MR", "TR")
    control = ("IE", "KU", "ABS")
    reached_unchanged = [
        qid for qid in shared if before[qid]["capability"] in reached
        and before[qid]["digest"] == after[qid]["digest"]
    ]
    control_changed = [
        qid for qid in shared if before[qid]["capability"] in control
        and before[qid]["digest"] != after[qid]["digest"]
    ]
    print(f'\nB1  reached routes with an unchanged prompt: {len(reached_unchanged)}')
    for qid in reached_unchanged[:12]:
        print("      ", qid, before[qid]["capability"], before[qid]["route"])
    print(f'B2  control routes with a changed prompt:   {len(control_changed)}')
    for qid in control_changed[:12]:
        print("      ", qid, before[qid]["capability"], before[qid]["route"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
