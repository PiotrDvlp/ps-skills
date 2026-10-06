#!/usr/bin/env python3
"""task-auditor Phase 1.75 deterministic evidence pre-scan.

Reads a structured KEYWORD_PLAN from JSON (file or stdin) and emits a
deterministic evidence packet to stdout for the Phase 2 Sonnet subagent to
reason over. Search lives here, outside the model loop, under a real
wall-clock timeout — Sonnet does not run find/rg/ls itself.

CLI:
  prescan.py --stack=shopin|fallback --root=<abs-path> --input=<json|-> \
             [--timeout=15] [--max-modules=8]

JSON input schema (Step A of Phase 1.75):
  {
    "jira_terms":       [string, ...],
    "primary_keywords": [string, ...],            # cap ≤6
    "variants":         { keyword: [variant, ...] },  # ≤2 per keyword
    "dropped_terms":    [{ "term": str, "reason": str }, ...],
    "scope_hints": {
      "include":        [{ "module": str, "reason": str }, ...],
      "candidate":      [{ "module": str, "reason": str }, ...]
    }
  }

Output (structured stdout):
  REPO_SHAPE, MODULE_HIT_TABLE (capped, cited-protected),
  FILENAME_HITS, CONTENT_HITS (rg -A2 -B2 context, NOT pre-read files),
  cap_reached, elapsed_ms.

Requires: python3, rg (ripgrep). Falls back to `find` for repo shape if `fd`
is unavailable. No other external deps.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# --- scope profiles --------------------------------------------------------

SHOPIN_SCOPE = [
    "src/pageModules", "src/components", "src/common", "src/pages",
    "generated/operations.ts", "generated/documents.ts",
]
SHOPIN_MODULE_ROOT = "src/pageModules"
EXCLUDED_DIRS = {"node_modules", ".nuxt", ".output", "dist", ".git", "coverage", ".next"}


# --- CLI -------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="task-auditor Phase 1.75 pre-scan")
    p.add_argument("--stack", required=True, choices=["shopin", "fallback"])
    p.add_argument("--root", required=True, help="absolute codebase root")
    p.add_argument("--input", required=True, help="path to keyword-plan JSON, or '-' for stdin")
    p.add_argument("--timeout", type=float, default=15.0, help="wall-clock budget (s)")
    p.add_argument("--max-modules", type=int, default=8, help="module-table cap")
    return p.parse_args()


def load_plan(arg):
    if arg == "-":
        return json.load(sys.stdin)
    return json.loads(Path(arg).read_text())


# --- deadline-aware subprocess --------------------------------------------

def remaining(deadline):
    return max(0.0, deadline - time.monotonic())


def run(cmd, deadline, cwd=None):
    """Run a command with the remaining wall-clock budget. Never raises."""
    budget = remaining(deadline)
    if budget <= 0:
        return 124, "", "no time"
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=budget, check=False)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "TIMEOUT"
    except FileNotFoundError as e:
        return 127, "", str(e)


# --- plan helpers ----------------------------------------------------------

def collect_keywords(plan):
    out, seen = [], set()
    for k in plan.get("primary_keywords", []):
        kk = (k or "").strip()
        if kk and kk.lower() not in seen:
            seen.add(kk.lower()); out.append(kk)
    for variants in plan.get("variants", {}).values():
        for v in variants or []:
            vv = (v or "").strip()
            if vv and vv.lower() not in seen:
                seen.add(vv.lower()); out.append(vv)
    return out


def cited_modules(plan):
    out = set()
    for bucket in ("include", "candidate"):
        for entry in plan.get("scope_hints", {}).get(bucket, []) or []:
            m = (entry or {}).get("module")
            if m:
                out.add(m)
    return out


def build_pattern(keywords):
    return "|".join(re.escape(k) for k in keywords) if keywords else r"(?!.*)"


# --- pre-scan steps --------------------------------------------------------

def emit_repo_shape(root, deadline):
    if shutil.which("fd"):
        rc, out, _ = run(["fd", "-d", "2", "-t", "d",
                          "-E", "node_modules", "-E", ".nuxt", "-E", "dist", "-E", ".git"],
                         deadline, cwd=root)
        if rc == 0 and out.strip():
            return out.strip()
    args = ["find", ".", "-maxdepth", "2", "-type", "d"]
    for d in EXCLUDED_DIRS:
        args += ["-not", "-path", f"*/{d}*"]
    rc, out, _ = run(args, deadline, cwd=root)
    return out.strip() if rc == 0 else "(repo shape unavailable)"


def list_candidate_modules(root, stack):
    if stack == "shopin":
        pm = Path(root) / SHOPIN_MODULE_ROOT
        if not pm.is_dir():
            return [], SHOPIN_MODULE_ROOT
        return sorted(p.name for p in pm.iterdir() if p.is_dir()), SHOPIN_MODULE_ROOT
    src = Path(root) / "src"
    base = src if src.is_dir() else Path(root)
    modules = sorted(p.name for p in base.iterdir()
                     if p.is_dir() and p.name not in EXCLUDED_DIRS)
    return modules, ("src" if src.is_dir() else ".")


def count_hits_in_dir(root, rel, pattern, deadline):
    full = Path(root) / rel
    if not full.exists():
        return 0
    rc, out, _ = run(["rg", "-c", "-i", "--no-messages", pattern, str(full)],
                     deadline)
    if rc not in (0, 1):
        return 0
    total = 0
    for line in out.splitlines():
        try:
            total += int(line.rsplit(":", 1)[-1])
        except (ValueError, IndexError):
            pass
    return total


def apply_module_cap(table, cited, max_modules):
    """Include all ≥1 hit + all cited (even at 0); cap with cited-protected priority."""
    included = [(m, c) for m, c in table if c >= 1 or m in cited]
    if len(included) <= max_modules:
        return included, [], False
    cited_rows = [(m, c) for m, c in included if m in cited]
    other_rows = sorted([(m, c) for m, c in included if m not in cited],
                        key=lambda r: -r[1])
    keep_other = max(0, max_modules - len(cited_rows))
    kept = cited_rows + other_rows[:keep_other]
    return kept, other_rows[keep_other:], True


def existing_scope(root, scope_paths):
    return [p for p in scope_paths if (Path(root) / p).exists()]


def filename_hits(root, scope_paths, keywords, deadline, cap=50):
    if not keywords or not scope_paths or remaining(deadline) <= 0:
        return []
    args = ["find"] + scope_paths + ["-type", "f", "("]
    for i, k in enumerate(keywords):
        if i:
            args.append("-o")
        args += ["-iname", f"*{k}*"]
    args.append(")")
    rc, out, _ = run(args, deadline, cwd=root)
    if rc != 0:
        return []
    return [l for l in out.strip().splitlines() if l][:cap]


def content_hits(root, scope_paths, pattern, deadline, cap=200):
    if not scope_paths or remaining(deadline) <= 0:
        return []
    args = ["rg", "-n", "-i", "-A2", "-B2", "-m", "3", "--no-heading", pattern]
    args += scope_paths
    rc, out, _ = run(args, deadline, cwd=root)
    if rc not in (0, 1):
        return []
    return out.strip().splitlines()[:cap]


# --- emit ------------------------------------------------------------------

def emit(kept, omitted, truncated, shape, fnames, contents,
         cited, cap_reached, elapsed_ms):
    print("REPO_SHAPE:")
    print(shape or "(empty)")
    print()
    print("MODULE_HIT_TABLE:")
    if not kept:
        print("  (no candidate modules matched any keyword)")
    for m, c in sorted(kept, key=lambda r: (-r[1], r[0])):
        marker = " (cited)" if m in cited else ""
        print(f"  {m}: {c}{marker}")
    print(f"  truncated: {'yes' if truncated else 'no'}")
    if omitted:
        names = ", ".join(m for m, _ in omitted[:10])
        more = "..." if len(omitted) > 10 else ""
        print(f"  omitted: {len(omitted)} ({names}{more})")
    print()
    print("FILENAME_HITS:")
    if fnames:
        for f in fnames:
            print(f"  {f}")
    else:
        print("  (none)")
    print()
    print("CONTENT_HITS:")
    if contents:
        for line in contents:
            print(f"  {line}")
    else:
        print("  (none)")
    print()
    print(f"cap_reached: {'yes' if cap_reached else 'no'}")
    print(f"elapsed_ms: {elapsed_ms}")


# --- main ------------------------------------------------------------------

def main():
    args = parse_args()
    plan = load_plan(args.input)
    root = args.root
    if not Path(root).is_dir():
        sys.stderr.write(f"prescan: --root not a directory: {root}\n")
        sys.exit(2)

    start = time.monotonic()
    deadline = start + args.timeout

    keywords = collect_keywords(plan)
    cited = cited_modules(plan)
    pattern = build_pattern(keywords)

    if args.stack == "shopin":
        scope_paths = existing_scope(root, SHOPIN_SCOPE)
    else:
        scope_paths = existing_scope(root, ["src", "."])

    shape = emit_repo_shape(root, deadline)
    candidates, module_root = list_candidate_modules(root, args.stack)

    table = []
    for m in candidates:
        if remaining(deadline) <= 0:
            break
        c = count_hits_in_dir(root, f"{module_root}/{m}", pattern, deadline)
        table.append((m, c))

    kept, omitted, truncated = apply_module_cap(table, cited, args.max_modules)
    fnames = filename_hits(root, scope_paths, keywords, deadline)
    contents = content_hits(root, scope_paths, pattern, deadline)

    cap_reached = remaining(deadline) <= 0
    elapsed_ms = int((time.monotonic() - start) * 1000)
    emit(kept, omitted, truncated, shape, fnames, contents,
         cited, cap_reached, elapsed_ms)


if __name__ == "__main__":
    main()
