---
name: dual-branch-finish
description: 'Use when a change must land on both `main` and `origin/develop` so an MR can be opened against each — "create both branches", "finish on both branches", "open MRs to main and develop", or an afterthought like "...and develop also". Skip if the work lands on a single branch.'
---

# Dual-Branch Finish

Land one logical change on two sibling branches — one off `main`, one off `origin/develop` —
so the same fix/feature can be merged into both integration branches via separate MRs.

This exists because some repos keep `main` and `develop` as parallel
integration branches that don't fast-forward into each other. A change that belongs in
both has to be carried to each independently. Doing it by hand is fiddly and easy to get
subtly wrong (wrong base, forgotten cherry-pick, divergent content), so this skill makes
the steps explicit and repeatable.

## The shape of the workflow

```
work committed on a main-based branch  ─┐
                                         ├─→  <name>          (off main,           → MR to main)
                                         └─→  <name>_develop  (off origin/develop, → MR to develop)
                  same commit(s), cherry-picked
```

The **main-based branch is home** — work happens there, and you end there. The develop
branch is a sibling that carries a cherry-pick of the same commit(s).

## Step 1 — Establish the commit(s) to carry

Read the working tree and current branch:

```bash
git status --short
git branch --show-current
```

- **If the working tree has uncommitted changes**, invoke the `commit` skill to commit them
  in proper logical scope. Don't hand-roll the commit — the `commit` skill handles ticket-ID
  scoping, grouping, and message format. Let it finish before continuing.
- **If everything is already committed** (e.g. the user committed earlier in the session),
  skip straight to identifying the range.

Then identify exactly which commits are new on this branch relative to `main` — these are
what gets carried:

```bash
git fetch origin main develop --quiet
git log --oneline origin/main..HEAD
```

Confirm the list looks right (it should be only this task's commits, not unrelated history).
If the current branch isn't based on `main`, figure out the real merge-base first
(`git merge-base HEAD origin/main`) and use that — never assume.

Then, if the ponytail plugin is installed (`/ponytail-review` exists), run one `ponytail-review` pass on the full range (`git diff origin/main...HEAD`)
before anything is cherry-picked. This is the last point where a cut lands once instead of
twice: a `delete:`/`yagni:`/`shrink:` finding fixed here is carried to develop by Step 2 for
free, fixed after Step 2 it needs a second cherry-pick. Apply the findings you agree with via
the `commit` skill, then re-run `git log --oneline origin/main..HEAD` so the range includes
the fix. One pass only; never ask it for more findings. Without the plugin, skip the pass.

## Step 2 — Create the develop sibling and cherry-pick

Derive the develop branch name from the current (main-based) branch by appending the repo's
develop suffix (`_develop` below; see Gotchas for how to check): `fix/foo_bar` →
`fix/foo_bar_develop`. (Underscores in the descriptive segment, per repo convention.) Create
it off the freshly-fetched `origin/develop` and cherry-pick the range:

The sibling may already exist and be pushed from an earlier session — see Gotchas before
running `git checkout -b` below.

First check whether home is itself a linked worktree, because that changes the primitive:

```bash
git rev-parse --path-format=absolute --git-dir --git-common-dir
```

Two identical paths — an ordinary checkout, `git checkout -b` is right. Two different paths —
home is a linked worktree, and `git checkout -b` is the wrong primitive there: it rewrites
this worktree's index and working tree onto the new branch instead of creating a sibling.
Use `git worktree add`:

```bash
# ordinary checkout (--git-dir == --git-common-dir)
git checkout --no-track -b <name>_develop origin/develop
git cherry-pick <oldest>^..<newest>   # or just `git cherry-pick <sha>` for a single commit

# home is a linked worktree (--git-dir != --git-common-dir)
git worktree add --no-track -b <name>_develop ../<name>_develop origin/develop
git -C ../<name>_develop cherry-pick <oldest>^..<newest>
```

`--no-track` is load-bearing under the Bash sandbox, not a style choice — see the
`.git/config` Gotcha. Step 6's `git push --set-upstream` sets the tracking config anyway, so
nothing is lost by not setting it here.

In the worktree case Step 4's "return home" is a no-op — you never left — and every later
command against the sibling takes `-C ../<name>_develop`.

A clean cherry-pick means `develop`'s version of the touched files matched — good.

## Step 3 — Handle cherry-pick conflicts with judgment

If the cherry-pick conflicts, `develop` has diverged on the touched files. Don't blindly
abort and don't blindly force it. Look at the conflict:

```bash
git status --short
git diff   # inspect the conflict hunks
```

- **If the resolution is unambiguous** — e.g. the conflict is only contextual (surrounding
  lines moved) and your change clearly still applies, or it's a doc/whitespace overlap you
  can confidently reconcile — resolve it, `git add` the files, and `git cherry-pick --continue`.
  State plainly what you resolved and why.
- **If you're unsure** — the change interacts with develop-only logic, the intent is
  ambiguous, or resolving would mean guessing at someone else's edit — stop and ask. Show the
  conflicting files and the competing hunks, and let the user decide. Do **not** invent a
  resolution to keep the workflow moving; a wrong cherry-pick resolution is worse than a pause.

If the user wants out entirely, `git cherry-pick --abort` leaves the develop branch clean
at `origin/develop`.

## Step 4 — Confirm the patch, then return home

SHAs differ because the parents differ — expected for a cherry-pick. A matching subject proves
nothing about content, so compare per-commit patch-ids (line numbers and whitespace are
normalised out, hunk content is not):

```bash
git log -p --reverse origin/main..<name> | git patch-id --stable | cut -d' ' -f1
git log -p --reverse origin/develop..<name>_develop | git patch-id --stable | cut -d' ' -f1
```

- **Lists identical** — the sibling carries the exact patch. Say "patch identical, home
  verification carries over".
- **Lists differ** — a Step 3 resolution or develop's surrounding code changed the hunks, and
  the sibling is unverified. Run on the sibling, on the files the range touches:
  `npx vitest related --run <files>` and `npx eslint <files>`. In an ordinary checkout you are
  still on the sibling after Step 2, so run them before going home; in the worktree case run
  them in `../<name>_develop`. Quote the decisive line. A failure stops the workflow — report
  it, no push offer. No typecheck in a worktree (see the `.nuxt` Gotcha).

Then go back to the main-based branch (home) and show both tips:

```bash
git checkout <name>
git log --oneline -1 <name>
git log --oneline -1 <name>_develop
```

## Step 5 — Draft both MR descriptions

When the repo has `.gitlab/merge_request_templates/Default.md`, fill it in once per branch and
write each draft to the scratchpad as `mr-<branch, slashes as underscores>.md`. The repo's
`AGENTS.md` "Merge Request Descriptions" section, when present, is the authority on content.

- Why and What come from `git log origin/main..<name>` and the range diff, not from memory of the
  session.
- Verification quotes only output produced in this session: home's checks and the Step 4
  patch-id result. A check that did not run goes under "Not verified" with the reason.
- The first line of each draft names its twin branch (`twin MR: <name>_develop` and the reverse);
  MR numbers do not exist before the push.
- When Step 3 resolved a conflict or Step 4 patch-ids differed, say so in the develop draft's
  Review notes and quote the sibling's own checks in its Verification.

No template in the repo: skip this step and say so in one line. The drafts are not the
deliverable on their own: Step 6 encodes each one into its branch's MR creation link, so the
form opens with the description already filled in.

## Step 6 — Push both (after confirming once)

Ask the user once: "Push both branches and set upstreams?" On yes, push each and set tracking:

```bash
git push --set-upstream origin <name>
git push --set-upstream origin <name>_develop
```

For each pushed branch, store whichever `merge_requests` URL its push output prints on the
branch itself, so a later session can find it without `glab` or a network call:

```bash
git config branch.<name>.mr "<merge_requests url from push output>"
git config branch.<name>_develop.mr "<merge_requests url from push output>"
```

A branch's **first** push prints `merge_requests/new?...` — no MR exists yet, so there is no
number. A push to a branch that already has one prints
`View merge request for <name>: .../merge_requests/<n>`. Store either. When what you stored is
the `new?...` link, say so in one line, and once the MR is actually opened overwrite it with
the numbered URL via the same `git config branch.<name>.mr <url>` command.

Reverse lookup needs no network and no new file:

```bash
git config --get-regexp 'branch\..*\.mr'
```

Skip the `git config` write only when the push output carries no merge_requests URL at all
(the remote suppressed the banner), and say so in one line rather than storing a guess.

Under the Bash sandbox this write fails with `could not lock config file .../.git/config:
Operation not permitted`. That is the deny described in Gotchas, not a broken workflow. Report
it in one line and hand both `git config` commands to the user alongside the push commands;
they succeed from a shell outside the sandbox.

End with the MR creation links, one line per branch, with source, target, title and the Step 5
description all encoded in the URL, so the user opens a form that is already filled in. Never
relay the push output's `merge_requests/new` link, which omits the target and lets GitLab
default it to the project's default branch, and never leave the description only in the draft
file or in chat. Build each line with:

```bash
b=<branch> t=<target> title='<MR title>' desc='<absolute path of the Step 5 draft, or empty>'; python3 -c 'import sys, urllib.parse as u; b, t, title, desc, base = sys.argv[1:]; q = {"merge_request[source_branch]": b, "merge_request[target_branch]": t, "merge_request[title]": title}; q.update({"merge_request[description]": open(desc).read()} if desc else {}); print(f"- {b}, target {t}: {base}/-/merge_requests/new?{u.urlencode(q)}")' "$b" "$t" "$title" "$desc" "$(git remote get-url origin | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')"
```

The title is the subject of the branch's commit when the range has one, otherwise a summary of
the range; keep it single-quoted, since a subject like `fix(tests): ...` is a shell syntax error
unquoted. Pass an empty `desc` only when Step 5 was skipped; GitLab then falls back to the
repo's default template. A filled link is about 1.5 KB, well inside URL limits.

Run it for `<name>` with `main` and `<name>_develop` with `develop` (or the bases in use), and
print both lines verbatim as the last thing in the reply (shortened here):

```
- chore/remove_vacuous_unit_tests, target main: https://gitlab.example.com/group/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=chore%2Fremove_vacuous_unit_tests&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=...&merge_request%5Bdescription%5D=...
- chore/remove_vacuous_unit_tests_develop, target develop: https://gitlab.example.com/group/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=chore%2Fremove_vacuous_unit_tests_develop&merge_request%5Btarget_branch%5D=develop&merge_request%5Btitle%5D=...&merge_request%5Bdescription%5D=...
```

When a branch already has an open MR (its push printed `View merge request ...`), a creation link
would open a duplicate. Print that MR's URL instead, followed by its description draft for the
user to paste over the current description.

Print them even when the user declined the push and you handed over push commands instead —
the links work as soon as the branches are pushed.

## Gotchas

- **The develop sibling may already exist.** Check `git rev-parse --verify` /
  `git branch -r` first. If it exists, `git worktree add <path> <name>_develop` (or check
  it out where it is not already checked out) instead of `git checkout -b`; `checkout -b`
  fails, and forcing it discards the pushed sibling.
- **The Bash sandbox denies writes to `.git/config`, and a plain `git checkout -b <name>
origin/<branch>` needs one.** Everything else under `.git` is writable — `.git/index`,
  refs, objects, and `.git/worktrees/**` all work, so commits and worktree creation are fine.
  Denied: `.git/config` and `.git/hooks/**`, which are git's arbitrary-code surface
  (`core.hooksPath`, `core.fsmonitor`, aliases). Do not try to allowlist them.
  `checkout -b` from a remote-tracking start point writes `[branch "<name>"] remote/merge`, so
  it hits the deny and **fails partially**: exit 1, `error: could not lock config file
.git/config`, the branch ref created, HEAD left on the old branch (reproduced). Exit 1 is
  real — read it; the state it leaves is not one a clean failure would produce. `--no-track`
  on both `checkout -b` and `worktree add -b` avoids the config write entirely and exits 0.
- **Step 6's `git config branch.<name>.mr` write hits the same deny.** It is a convenience, not
  part of the change: if it fails, say so in one line and hand the two commands to the user with
  the push commands, rather than treating the workflow as blocked. They run outside the sandbox
  (prefix a shell line with `!`), where it succeeds.
- **Home may itself be a linked worktree.** Compare `git rev-parse --path-format=absolute
--git-dir --git-common-dir` before Step 2; when they differ, `git worktree add` replaces
  `git checkout -b`. Skipping this check once left a half-applied `checkout -b` (branch ref
  created, index and working tree rewritten, HEAD still on the old branch) that needed a
  `reset --hard` to undo and pushed an empty branch to origin.
- **Vitest in a fresh worktree needs three symlinks, not two.** `node_modules`, `generated`
  and `.nuxt`. Without `.nuxt` the `tsconfig.json` extends chain is unresolvable and every
  spec reports "no tests". Symlink `.nuxt` for vitest only — never run `nuxt prepare`,
  `npm run dev` or `npm run typecheck` from a worktree while `.nuxt` is a symlink; they
  rewrite the main repo's `.nuxt/eslint.config.mjs` and break `npx eslint` in every checkout
  (memory `project_worktree_nuxt_symlink_breaks_eslint`).
- **A Step 4 patch-id mismatch is not proof of a bad pick.** It also fires when only the
  context lines around a hunk differ on develop, even after a clean cherry-pick. That false
  alarm costs one test run and is accepted; a match is the only signal that lets home's
  verification carry over.
- **`_develop` is a repo majority, not a rule.** Repos differ (one runs about 75 `*_develop` to 50 `*_dev`, another 1 to 2). Check with `git branch -r | grep -oE '_develop$|_dev$' | sort | uniq -c` and match the winner.
- **Bases are configurable.** `main` + `origin/develop` are the defaults when the user names none. If a repo uses different integration branches (or the user names different ones), use those and keep the same two-sibling shape.
- **Never push without the explicit yes in Step 6; never `--no-verify`, never force-push.** Branch creation and cherry-pick are local and safe; pushing is the outward-facing action. If a push is rejected, report it and stop.
- **A cherry-pick conflict means `develop` diverged on the touched files — don't guess the resolution.** Resolve only when it's unambiguous (contextual/whitespace). If the change interacts with develop-only logic, stop and show the hunks; a wrong cherry-pick resolution is worse than a pause.
- **Don't assume the branch is based on `main`.** If it isn't, find the real merge-base (`git merge-base HEAD origin/main`) before identifying the commit range — a wrong base carries unrelated history.
- **End on the home (main-based) branch, not the develop sibling.** That's where the user was working and expects to land.
- **Opening the MRs with `glab mr create` instead of the pushed URLs? Run `glab auth status` first.** A token without the `api` scope blocked MR creation once (2026-08); the pushed `merge_requests/new` URLs need no token.
- **The push output's MR link has no target.** GitLab then defaults it to the project's default branch; the Step 6 links carry `target_branch` explicitly, so always end with those.
- **This skill carries one logical change verbatim across two bases** — it's not the place to add branch-specific edits. If the branches genuinely need different content, flag it as separate work.
