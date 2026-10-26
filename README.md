# cadence

[![CI](https://github.com/wppypewo/cadence/actions/workflows/ci.yml/badge.svg)](https://github.com/wppypewo/cadence/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-informational.svg)

English | [繁體中文](README.zh-TW.md)

A single-user French review workbench, built for the DELF B1 exam in May 2027. It turns word lists, conjugation tables, grammar rules, practice for the four exam papers and a set of B2 resources into something worth opening every day.

- 33,895 cards in seven card types, scheduled with FSRS-6 (a line-by-line port of the reference implementation, checked against 732 golden vectors)
- A *Today* page that lays out all four DELF papers, so a neglected paper is visible
- Zero npm dependencies: the backend uses only Node built-ins (including `node:sqlite`); the frontend is native ES modules and hand-written CSS with no bundler
- The production site runs on Vercel and Supabase, locked to one owner

The interface is in Traditional Chinese.

---

## What it does

33,895 cards, seven card types, vocabulary from A1 to B2 (B2 comes from the 5,068 content words in FLELex):

| Card type | Cards | Prompt |
|---|---|---|
| Conjugation | 16,577 | Infinitive + tense + person; type the form |
| Recognition | 8,507 | French word; self-grade whether you recall the Chinese meaning |
| Chinese → French | 8,506 | Chinese meaning; type the French, accents count |
| Nominalisation | 92 | Base word; type article + derived noun |
| Sentence rewrite | 88 | Sentence + instruction; rewrite, then self-grade |
| Pick the connector | 75 | Multiple choice, four options |
| Connector mood | 50 | Does this connector take the indicative or the subjunctive? |

Four navigation items, plus one in cloud mode:

- **Today**: exam countdown, one primary button, and a ledger of the four DELF papers showing what each needs today. The landing page.
- **Review**: the cards due today. Navigation collapses to the card. Typed answers are graded immediately, compared character by character against the answer, with errors split into misspellings and missing accents; capitalisation does not count. Vocabulary cards show the noun's gender on the front and up to two Tatoeba example sentences on the back (with Chinese translations where available, each credited to its source and author).
- **Progress**: two tabs. *Now*: progress per card type, a practice heatmap, weakest cards, error-type breakdown and the next 30 days of workload. *Forecast*: pick an exam date and simulate the daily load and expected number of remembered cards up to that day.
- **Dictionary**: look up a word for its gloss, part of speech, level and full conjugation table.
- **Resources** (cloud mode only): free B2 sources (each with the date it was last checked), filters for the four papers, and a one-week action plan that opens straight into the workbench.

Two more workbenches sit outside the navigation: reading, writing, listening and speaking practice (from Today) and mock-exam records for all four papers (from Progress).
Writing practice has a timed draft and a word count, listening plays local audio files, and speaking records in the browser for playback; audio is never uploaded or stored.
The weak-cards list opens a bounded batch directly, and a self-graded "wrong" during review can be corrected afterwards by appending an event.

## Why these views

*Today* answers "I have just sat down; what do I do first?" Passing DELF B1 needs 50/100 overall
**and at least 5/25 on every paper**; one weak paper fails the exam. With all seven card types in one queue,
practice drifts towards conjugation, which has the most cards, while other papers go untouched. This page exists so that drift cannot hide.
Listening and speaking have no cards (the bank has no audio, and a machine cannot grade pronunciation or interaction), so those two rows point to official sample papers and fixed GPT practice prompts in `study/`. The app cannot record whether they were done, and the page says so.
Writing has both: cards drill conjugation, vocabulary and connectors, but on the official marking grid *Réalisation de la tâche* and *Adéquation sociolinguistique* (5 points each) and half of *Cohérence et cohésion*, about 12.5 points in total, are out of reach of any card. So the writing row also carries a writing guide and a check-in button.

Review is the page used every day. The other three answer questions a person cannot work out in their head:

- **Progress · Now**: "How far have I got, and where am I weakest?" Error counts and error types accumulate; nobody remembers them.
- **Progress · Forecast**: "How much will I remember on exam day, and how many cards a day is enough?" Over thirty thousand cards each have their own stability and due date, and forgetting follows a power law, not a straight line.
- **Dictionary**: "How does this verb conjugate again?", without reaching for a book.

## Scheduling: FSRS-6

Intervals are not a fixed table; each card gets its own.

FSRS tracks three values per card: **S** (stability, the number of days for recall probability to fall from just-reviewed to 90%), **D** (difficulty, 1–10) and **R** (the probability of recall right now). The next review date is worked back from the recall probability you want at review time; the default is 0.9.

`src/engine/fsrs.mjs` is a line-by-line port of `fsrs/scheduler.py` from py-fsrs (MIT), not a reinvention. **732 golden vectors**, generated by running the reference implementation, are checked in `tests/fsrs.test.mjs`; any drift in the port turns the tests red. See [docs/fsrs.md](docs/fsrs.md).

### How new cards are introduced

Due cards always come first; new cards fill whatever room is left. New cards are taken **round-robin by card type**, most frequent first within each type.
Frequencies are not compared across types because the three hand-written types (connector mood, pick the connector, sentence rewrite) have no frequency at all (all zero). Compared directly, those 213 cards would rank below 12,000 others, and at 15 new cards a day they would take over two years to appear, well after the exam.

Conjugation is the exception: instead of following frequency, it **rotates verbs, one tense (six forms) at a time**:
être present → être passé composé, avoir present → être imparfait, avoir passé composé, faire present…
Each round adds a new verb and moves every started verb on by one tense (present, passé composé, imparfait, futur simple, conditional, subjunctive).
Previously all 36 cards of a verb shared one frequency and came out in id order: être started with the conditional, and avoir only appeared after all six tenses of être.

New nominalisation and rewrite cards **show the answer first**. After "Seen it, test me later" the card moves four places back in the batch and is then tested for real.
These two types test rules; without having seen the rule you would be guessing, and a wrong answer would not mean forgetting. Viewing the answer writes nothing, and scheduling starts from the first real test.
The answer comes from a separate `/api/preview` endpoint, which only serves these two types for cards with no scheduling state yet.

A Chinese → French card for a word only appears after its Recognition card has been answered at least once (right or wrong). Testing spelling on first sight measured only 38–40% correct.

The setting that matters for new cards is the **daily new-card limit**, which can be switched off. The cost: new cards come back within days as due cards, so learning 100 today grows every day's load next week. The Forecast tab can show the effect first.

Vocabulary new cards come only from A2–B2 (`ACTIVE_LEVELS` in `src/db.mjs`), with two exceptions: conjugation ignores verb level, because être and avoir are tagged A1 and would otherwise never be drilled; and A1 cards already learned stay on their normal schedule.
Today, Review, statistics, Forecast and `npm run stats` all use the same range, so their numbers agree.

---

## Architecture

The same native-ESM frontend runs in two modes:

- **Cloud (production)**: Vercel Functions, Supabase Auth and Postgres. Since 2026-09-26 all reviews happen here.
- **Local**: `npm start`, then open `http://127.0.0.1:4173`. Local SQLite and JSONL, no account. Kept for development, tests and rebuilding the card bank.

Module layout and data flow are in [docs/architecture.md](docs/architecture.md); typed-answer grading is in [docs/grading.md](docs/grading.md).

## Cloud deployment

Vercel deploys only `web/`, an allow-listed set of `study/` documents and same-origin `/api/*`. The browser never holds a Supabase token; the session lives in an HttpOnly, SameSite cookie, and the server talks to Postgres with the user's JWT under row-level security.
The site only admits the first Supabase Auth user, so create the owner before opening sign-in.

`vercel.json` pins functions to `hnd1` (Tokyo) because the Supabase project is in AWS ap-northeast-1 (determined on 2026-09-29 by matching the database host's IPv6 address against AWS's published IP ranges). Without it a new Vercel project runs in `iad1` (Washington, D.C.), and every API call crosses between the US East Coast and Tokyo. Submitting one answer used to be four sequential requests (verify session, read card/state/settings, write event, write state); a single round trip from Taipei to Supabase measured 90–100 ms, and US East to Tokyo is further. Change this together with the Supabase region.

Since 2026-09-30 submitting an answer takes two round trips instead of four. The function verifies the access token's ES256 signature and `iss`/`aud`/`exp` itself, against Supabase's public JWKS (`/auth/v1/.well-known/jwks.json`, cached for ten minutes), instead of calling `/auth/v1/user` on every request; anything that fails falls back to `/auth/v1/user`, so the worst case is the old behaviour. Writing the event and the state is now one RPC, `cadence_record_review`, in one transaction, which also closes the gap where an event was written but the state was not.
Trade-off: a token that was signed out or revoked still passes the function until it expires (at most an hour), but that token could already call PostgREST directly.

Since 2026-10-23 `cadence_record_review` has a version lock: `card_states.version` counts reviews per card, and the RPC only updates when the stored version equals the submitted value minus one; otherwise it rolls back and returns 409. A double-clicked submit or two tabs answering the same card no longer overwrite each other and undercount reviews. Deploy the code first, then run `supabase/migrations/20261023000000_record_review_version_lock.sql` (corrections sent by the old client would be rejected by the new lock).

```bash
# Apply supabase/migrations/*.sql in filename order: tables, RLS, query functions and the B2 resource index.
# Then set these in Vercel:
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
CADENCE_OWNER_EMAIL=
CADENCE_TOKEN_SECRET=   # 64 random hex characters; Production/Preview secret only

npm run build:web
vercel deploy --prod
```

After rebuilding the card bank locally, bring the cloud in line with `scripts/cloud-sync-bank.mjs`:

```bash
# .env.cloud holds SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CADENCE_OWNER_EMAIL; the password is prompted for or read from CADENCE_PASSWORD
node scripts/cloud-sync-bank.mjs --env .env.cloud           # dry run: read-only, prints how many cards would be added/removed
node scripts/cloud-sync-bank.mjs --env .env.cloud --apply   # write
```

It signs in as the owner under RLS and only touches `cards` and `reference_entries`. Memory states, reviews and settings are never written, because cloud reviews do not flow back to the local copy and overwriting with locally computed states would roll back cloud progress.
Old cards missing from the new bank are deleted only when they have neither reviews nor a memory state.

When the data first moved from local to cloud, all 569 entries of `reviews.jsonl` were kept. Verbiste-derived conjugation cards and tables do not go to the cloud; their events stay in history as raw payloads, so GPL-2.0-derived data never mixes into the production card bank.
The one-off migration script `scripts/cloud-import.mjs` was deleted on 2026-09-27; it can be recovered from `dfdda6b`.

## Review records and backups

Review records are the only data that cannot be rebuilt, and they are append-only: undoing or correcting a grade appends another event.

**They are not in this repository.** Review records are personal data and live in a private repository, `cadence-data` (moved out of here on 2026-10-26). This repository's `.gitignore` blocks those files from being added back.

The cloud is the only source of reviews. Back it up with `scripts/cloud-backup.mjs`, which only reads from the cloud:

```bash
node scripts/cloud-backup.mjs --env .env.cloud   # writes to ../cadence-data/data/cloud-backup/ by default
```

- `review_events`, `checkin_events` and `practice_events` are each saved as `cloud-backup/<table>.jsonl`. Rows are matched by `event_id` and only rows new in the cloud are appended; existing lines never change (jsonb reorders keys, so whole lines cannot be compared).
- Rows present in the backup but gone from the cloud trigger a warning and stay, which is exactly what a backup is for. `settings.json` is a snapshot, overwritten each time.
- Two things are not backed up: `card_states` can be recomputed by replaying review events, and `practice_assets` files in Storage are not in any table.
- `cadence-data` is expected next to this repository (same parent directory). Set `CADENCE_DATA_REPO`, or pass `--out`, if it lives elsewhere. If it cannot be found the script stops with an error instead of silently creating a directory outside any repository.
- On macOS, launchd can run it weekly: `scripts/scheduled-backup.sh` checks that existing content was not rewritten, then commits in `cadence-data`. Installation steps are at the top of that script.

Local-mode storage (local mode was retired on 2026-09-26; `reviews.jsonl` stopped at 569 lines and the other two JSONL files were never created):

```
reviews.jsonl    One JSON line per answer, append-only. Source of truth; versioned in cadence-data.
checkins.jsonl   Manual check-ins for listening, writing and speaking, one line per day, append-only.
attempts.jsonl   Practice and mock-exam attempts for the four papers, one line each; text and numbers only, no audio.
settings.json    Exam date, daily new-card limit (or none) and target retention. Local only, not versioned.
cadence.db       SQLite index: card bank, memory states, statistics. Fully rebuildable, not versioned.
bank/            Build output from npm run build. Not versioned.
```

The reason for this split: if the SQLite file breaks, the schema changes or the project is abandoned, hundreds of days of practice are still there, in a format `cat` can read. A broken index is rebuilt from the three JSONL files with `npm run reindex`.

To read the records in `cadence-data` in local mode: `CADENCE_DATA=../cadence-data/data npm start`.

## Data and licensing

The code is under the [MIT license](LICENSE). Files outside its scope are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The card bank is computed at **build time** from five external sources. Neither the sources nor anything derived from them is in this repository:

| Source | Used for | License |
|---|---|---|
| `french-exam-generator/data` | A1–B1 vocabulary, 2,000+ hand-written Chinese glosses, English definitions | Personal data, not published |
| Ricky-KnowledgeBase `raw/sources/french/verbiste` | 784 verb conjugation tables | **Verbiste, GPL-2.0-or-later** |
| Ricky-KnowledgeBase `raw/sources/french/flelex` | B2 vocabulary and frequencies (original FLELex table) | CC BY-NC-SA 4.0 |
| Ricky-KnowledgeBase `wiki/concepts/french` | Grammar rules such as the mood each connector takes | Personal notes |
| Ricky-KnowledgeBase `wiki/outputs/study-packs` | Ready-made rewrite and multiple-choice items | Personal notes |

`lexicon/`, which is versioned here, sits on top of those lists: noun genders (from fr.wiktionary), Chinese glosses written one by one for this project (a review of 1,470 glosses fexgen had scraped, plus all of B2), Tatoeba example sentences (CC BY 2.0 FR, credited per sentence in the UI) and spelling corrections to FLELex. What is and is not included, and how to regenerate it, is in [lexicon/README.md](lexicon/README.md).

The frontend carries two third-party files directly, outside npm:

| File | Used for | License |
|---|---|---|
| `web/vendor/gsap.mjs` | GSAP 3.15.0: card transitions, letter-by-letter grading reveal, number roll, check-in stamp and entrance animations (all in `web/js/motion.mjs`) | GreenSock Standard "no charge" license, **not open source**: free for ordinary applications, but may not be used to build a visual animation editor competing with Webflow; the copyright header must stay |
| `web/fonts/newsreader-*.woff2` | Newsreader, for French text and large numerals | SIL OFL 1.1, full text in `web/fonts/OFL.txt` |

With the system "reduce motion" setting on, no GSAP animation runs.

Verbiste (Copyright 2003–2016 Pierre Sarrazin) is GPL-2.0-or-later. This project reads its XML only during `npm run build` and writes all output to `data/bank/`, which is git-ignored. **This isolation is deliberate**: GPL obligations attach when a derived work is distributed, and nothing derived is distributed. Think through the consequences before changing it.

One more piece of data is not in the table above: `src/build/connector-gloss.mjs`. The authoritative connector table is organised by mood and has no Chinese column; the secondary table has Chinese but only for common connectors. For the 25 connectors in neither, no Chinese exists in the vault, so this project writes it. When merging, the secondary table always wins and this file only fills gaps; if the vault later adds the same connector, `npm run build` flags the row for removal.

---

## Running locally

Requires Node 24 or later (for the built-in `node:sqlite`). There is nothing to `npm install`.

**The card bank cannot currently be built from this repository alone.** If any of the five sources above is missing, `npm run build` lists what is missing and stops; two of them are private repositories.
The tests do not need those sources and run straight after cloning:

```bash
npm test          # 322 tests, including 732 FSRS golden vectors
npm run lint      # syntax check of every file with node --check
```

On a machine that has the five sources:

```bash
npm run build     # rebuild the card bank from the five sources and lexicon/ (start-up also checks this)
npm start         # start the server and open the browser
```

Source locations can be overridden with `CADENCE_FEXGEN`, `CADENCE_VERBISTE`, `CADENCE_FLELEX`, `CADENCE_VAULT` and `CADENCE_PACKS`.
Each start compares a fingerprint of the source contents; if any source or `lexicon/` changed, the bank and index are rebuilt before the page opens.

`CADENCE_DATA` moves the card bank, index and review records somewhere other than the repository's `data/`. It exists for tests and demos, since answering a few cards or saving a practice attempt writes to the append-only record files. The directory must exist with a `bank/` inside (the three record files are created on first write); it is not created for you.

```bash
CADENCE_DATA=/tmp/cadence-demo npm start
```

### Commands

```bash
cadence serve     [--port 4173] [--no-open]   start the local server
cadence build     [--verbose]                 rebuild the card bank
cadence reindex                               rebuild the SQLite index from the three JSONL files
cadence stats     [--json]                    print progress in the terminal
cadence forecast  --exam YYYY-MM-DD [--limit 60] [--new 15] [--target 0.85]
cadence restore   --file <backup.json> [--dry-run]  preview or restore a backup
cadence doctor    [--json]                    check sources, card bank and index for consistency
```

`restore` only appends missing lines when the current JSONL is a prefix of the backup; add `--dry-run` to see the difference first.

`doctor` lists records not yet committed and not yet pushed to `origin/main` separately. Only pushed records have an off-site copy; these reminders do not affect the exit code.
It checks the repository that contains `CADENCE_DATA` (for example `cadence-data`), and skips the check when `CADENCE_DATA` is not a `data/` directory inside a repository.

## Development

```bash
npm test           # 322 tests, including 732 FSRS golden vectors
npm run lint       # syntax check of every file with node --check
npm run build:web  # produce dist/ for Vercel
```

CI runs lint and tests on every push to `main` and every pull request.

Zero third-party dependencies. Local mode serves `web/` directly with no build step; cloud mode has one step that copies allow-listed files (`npm run build:web`). `engines` says Node 24.x so Vercel picks that runtime.
Four tests call `python3`: the nominalisation exclusion list and derivation rules are copied from `french-exam-generator/tools/nominalize.py`, and those tests run the original to compare, so changing one side turns them red. Where `python3` or that file is unavailable (including CI), those tests are skipped and the rest run.

Maintenance rules (zero dependencies, append-only records, GPL isolation, frontend rules) are in [docs/DESIGN_NOTES.md](docs/DESIGN_NOTES.md). The other documents, in Traditional Chinese:

- [docs/architecture.md](docs/architecture.md): module layout and data flow
- [docs/fsrs.md](docs/fsrs.md): how FSRS-6 was ported and verified
- [docs/grading.md](docs/grading.md): how typed answers are graded, and why accents count
