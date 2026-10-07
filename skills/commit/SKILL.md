---
name: commit
description: 'ALWAYS use for any git commit — never run `git commit` yourself without it. Triggers immediately on a bare "commit", "commit the changes", "ok commit", "commit this", or any message whose intent is committing working-tree changes. Skip if the intent is push, MR, or branch integration (use dual-branch-finish or finishing-a-development-branch).'
---

# Commit

Stage and commit unstaged working-tree changes in logical scope.

## Step 1 — Survey

Run these in parallel:

```bash
git status --short
git branch --show-current
git diff
git ls-files --others --exclude-standard  # untracked files
```

Work only with **unstaged** changes (working tree vs HEAD). Ignore any already-staged files,
except files you staged yourself in this task (for example for a `--staged` test-quality check):
those belong to the scope, so name them in `git commit --only`.

## Step 2 — Group into logical commits

Apply these signals in priority order to form groups. A group is a set of files that share the same ticket, the same area, **and** the same change type.

**Signal 1 — Ticket ID** (strongest): extract from the branch name (e.g. `PROJ-123` from `feat/PROJ-123/short_name`), then check it against what the diff actually does before using it. Changes for different tickets go into separate commits.

The branch's ticket is a candidate, not a fact. Three cases:

- **Diff matches the ticket** — use it.
- **Diff reaches beyond the ticket** (a fix that also touches unrelated code) — omit the ticket rather than mislabel the wider change.
- **Branch names a different ticket than the work you were asked to do** — stop and ask which ID belongs on the commit; don't copy the branch's.

**Signal 2 — Feature area**: group by module or domain — `pageModules/footer/`, `pageModules/checkout/`, `common/stores/`, etc. Changes in different areas usually belong in separate commits.

**Signal 3 — Change type**: determine the type from what the diff actually does:

- New functionality → `feat`
- Bug correction → `fix`
- Code restructure without behavior change → `refactor`
- CSS/class-only changes → `style`
- Config, tooling, build → `chore`
- Comments, docs → `docs`

If all changes are in one area and one type, that's one commit. If there are multiple areas or mixed types with a meaningful distinction, split them.

**Judgment over rules**: if splitting would produce two nearly-identical tiny commits, keep them together and note both scopes. The goal is clarity, not maximum granularity.

## Step 3 — Draft commit messages

If the caller handed you a verbatim message, skip this step and use that string as-is.

Otherwise derive the shape from `git log --oneline -20` and state it before committing. Some repos use no type prefix at all; match what the log shows.

Illustration only — two shapes seen in the wild, `{type}({scope})[{ticket}]: {subject}` and `{type}: [{ticket}] {subject}`:

```
fix(teaser)[PROJ-123]: handle fallthrough click once per native event
fix: [PROJ-123] handle fallthrough click once per native event
```

- **type**: from Step 2 Signal 3
- **scope**: module name (e.g. `footer`, `checkout`) — only when the template carries `{scope}`
- **ticket**: the ID confirmed in Step 2 Signal 1 — omit when the branch has no ticket, or when the change reaches beyond that ticket's scope
- **subject**: present tense, ≤72 chars total line

When a commit covers multiple distinct changes worth calling out, add a blank line and `- detail` bullets under the summary line.

**Never add `Co-Authored-By` trailers.**

## Step 3b — Complexity pass (conditional)

If the ponytail plugin is installed (`/ponytail-review` exists), run one `ponytail-review` pass on the unstaged diff only when it adds a new file or exceeds
100 changed lines; smaller diffs skip this step. Surface the findings with the commit plan,
one line each, and let the user decide what to cut before anything is committed. One pass,
never re-asked for more. Without the plugin, skip this step.

## Step 4 — Execute

Commit each group with `git commit --only -m "<msg>" -- <paths>` (`git add <file>` first for untracked files). A bare `git commit -m` commits the whole index, so anything pre-staged would leak into the first group; if `git diff --cached --name-only` shows files you did not expect, stop and report them instead. Never `git add .`/`-A`, never `--no-verify`.

Check the subject length before each commit, never after: rewording a commit that already has a
cherry-pick on top means re-creating both and moving the branch ref.

```bash
subject='<subject line>'; [ ${#subject} -le 72 ] || echo "subject is ${#subject} chars, limit 72"
```

Any output means shorten the subject first.

**One commit**: commit immediately. No need to ask. Report what was committed after it's done.

**Two or more commits**: show the plan first and wait for a go-ahead:

```
Proposed commits (2):

1. fix(teaser)[PROJ-123]: handle fallthrough click once per native event
   → src/pageModules/footer/components/Teaser.vue

2. feat(footer)[PROJ-123]: lay out teaser and seal as flex columns
   → src/pageModules/footer/components/DefaultFooter.vue
   → src/pageModules/footer/components/FooterSeal.vue

Proceed?
```

On approval, commit in order. On rejection or edits, adjust the plan first.

## Step 5 — MR creation link

Skip when another skill invoked this one (dual-branch-finish prints both links itself), when
the branch is `main`/`develop`, or when `origin` is not GitLab. Otherwise end the reply with the
branch's MR creation link, with the title and description already in it. Target is `develop`
when the branch ends in `_develop` or `_dev`, else `main`.

Before building the link, run one `/codex-review code --base origin/<target>` on the branch
unless a Codex review of this exact range already ran in the session. A remote review bot finds
the same defects one push later. Rank a finding that lets a blocking gate pass High, however
unlikely the input. Fix accepted findings with this skill before the link; Codex unavailable:
say so in one line and mark the range unreviewed in the description's Verification.

When the repo has `.gitlab/merge_request_templates/Default.md` (read it from the target branch
with `git show origin/<target>:<path>` when the working tree lacks it), fill it in for
`git log origin/<target>..HEAD` and write the draft to the scratchpad. The repo's `AGENTS.md`
"Merge Request Descriptions" section, when present, is the authority on content; Verification
quotes only output produced in this session. No template: write a concise non-empty description
of the change and checks actually run. Choose the title from the repo's MR title convention,
falling back to the commit shape from `git log`; keep the exact title and draft for read-back. Then:

```bash
b=$(git branch --show-current); case "$b" in *_develop|*_dev) t=develop;; *) t=main;; esac; title='<chosen MR title>'; desc='<absolute draft path>'; python3 -c 'import sys, urllib.parse as u; b, t, title, desc, base = sys.argv[1:]; q = {"merge_request[source_branch]": b, "merge_request[target_branch]": t, "merge_request[title]": title, "merge_request[description]": open(desc).read()}; print(f"- {b}, target {t}: {base}/-/merge_requests/new?{u.urlencode(q)}")' "$b" "$t" "$title" "$desc" "$(git remote get-url origin | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')"
```

Print its output verbatim (shortened here):

```
- chore/remove_vacuous_unit_tests, target main: https://gitlab.example.com/group/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=chore%2Fremove_vacuous_unit_tests&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=...&merge_request%5Bdescription%5D=...
```

Set `title` to the chosen convention-compliant title, using a summary of the range for several
commits (`title='...'`; unquoted, a subject like `fix(tests): ...` is a shell syntax error). When the
branch already has an open MR, print its URL and the draft for the user to paste instead; a
creation link would open a duplicate. Discover the MR with the read-only verifier shared with
`dual-branch-finish` (Node 22+, authenticated `glab`):

```bash
node "${CLAUDE_SKILL_DIR}/../dual-branch-finish/scripts/verify-mr.mjs" --repo . --branch '<branch>' --phase before-push
```

An inactive or ambiguous MR blocks any later push offer; follow-up work after merge belongs
on a fresh branch. Tool failure is unverified, not evidence that no MR exists. The creation
link works once the branch is pushed; this skill never pushes. Report "commit complete;
push/MR handoff pending" when no remote handoff was verified.

When resuming after a separately authorized push or MR edit, verify without asking for numbers:

```bash
node "${CLAUDE_SKILL_DIR}/../dual-branch-finish/scripts/verify-mr.mjs" --repo . --branch '<branch>' --target '<target>' --title '<exact title>' --description '<absolute draft path>'
```

Only exit 0 with `verified` means the MR handoff is complete: open state, exact source/target,
title, full description and pushed commit match. Exit 1 is pending (print the URL or creation
link plus the correction needed); exit 2 is unverified (keep the draft and rerun command).

## Gotchas

- **Never `git add .` or `git add -A`** — name each group's files explicitly in `git commit --only -- <paths>`, or you'll sweep unrelated working-tree changes into the commit.
- **Work only on unstaged changes** (working tree vs HEAD). Files already staged before the skill runs are ignored, and `--only` is what keeps them out — don't assume the index reflects your intended scope.
- **Never `Co-Authored-By` trailers** in any repo in this workspace (workspace rule), and never push or `--no-verify`.
- **One group commits immediately without asking; two or more requires the plan + a go-ahead first.** Don't silently commit a multi-group split.
- Confirm the branch's ticket ID matches the change's actual scope before using it: omit the ticket when the fix reaches beyond it, and ask when the branch names a different ticket than the work.
- On main/master of a code repo (not a notes repo), stop and create a feature branch before committing; never commit straight to the default branch.
