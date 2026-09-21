# FB Group Poster

A local, single-user tool that drips advertisements for a small number of
businesses into the Facebook groups you belong to, at a pace that neither
Facebook's automated systems nor human group admins object to.

## What it is not

It is not a mass-posting tool. The design deliberately refuses to post the same
ad to 100 groups at once, because doing so reliably produces (a) a temporary
posting block on the account and (b) removal from groups by their admins. The
second is worse — you cannot automate your way back into a group a human
removed you from. **The groups are the asset; the tool exists to protect them.**

There is also no evasion layer: no fingerprint spoofing, no proxy rotation, no
CAPTCHA solving, no multi-account rotation. When Facebook pushes back, the tool
stops and tells you.

## Why there is no API

Facebook's Groups API is gone. `publish_to_groups` was removed in 2020 and the
remaining Groups endpoints were deprecated in April 2024. There is no sanctioned
programmatic way to post into a group, including groups you own. Everything here
therefore drives a real browser.

## Modes

| Mode | What happens | Status |
|---|---|---|
| `assisted` | Playwright opens the group, fills the caption, attaches the image, shows you the group's rules, and stops. **You** click Post. | default |
| `auto` | Same, but it clicks Post itself. | opt-in, per group/business |

Both go through the same queue, the same cooldowns and the same log. Assisted
mode is not a lesser path — it is the identical code up to the final click.

**The mode is read live, at the moment of posting, from Settings.** Queue items
carry the mode they were committed with, but only for display: an earlier
version treated that snapshot as authoritative, so switching to auto left every
already-queued post assisted and the run still stopped to ask. Changing the
setting now also re-stamps everything still waiting.

Auto mode clicks Post through `submitPost()` in `runner/composers.ts`, which
searches **inside the composer dialog**, waits for the button to be *enabled*
(Facebook greys it out until the image upload finishes), and treats the dialog
closing as the receipt. If it cannot confirm that, the post is reported failed
with a screenshot — never as posted. A post logged as sent but never sent is
worse than a visible failure, because it silently starts that group's cooldown.

### Rounds

There is a third path, on its own screen. A **round** sends one ad to every
group selected for its business, now, and again a few hours later — which is
precisely what the drip planner refuses to do. It does not soften those rules;
it swaps them for hour-scale ones:

| Drip planner | Round |
|---|---|
| 7-day per-group cooldown | `minHoursBetweenRounds` (default 3h) |
| 21-day per-ad cooldown | not applied |
| `dailyCap` (15/day, all posting) | `roundDailyCap`, counted separately |
| 18–55 min between posts | `roundMin/MaxGapMinutes` (default 5–12) |
| — | `roundsPerDay`: rounds one group may receive in a day |

Everything else still holds: inactive and quarantined groups are skipped,
composer types must match, variants rotate with no back-to-back repeats, group
order is shuffled per round, and the circuit breaker still stops everything.

Rounds are tagged with a `roundId` that reaches `post_log`, and the round guards
count only rows carrying one — so an ordinary drip post never consumes a
group's round allowance, and vice versa.

Active hours are advisory for a round rather than enforced: you trigger it by
hand, and refusing at 21:05 would only be obstructive. It says so and proceeds.

## Shape

```
domain/      types + interfaces. Depends on nothing.
store/       SQLite persistence behind the Store interface.
scheduler/   Decides what gets posted where and when. Pure, seeded, testable.
runner/      Playwright. Two composers: normal status, marketplace listing.
orchestrator The run loop + circuit breaker.
server/      Fastify API on 127.0.0.1 only.
web/         Local UI, no build step.
```

Modules talk only through `domain/contracts.ts`. The scheduler has never heard
of SQLite; the runner has never heard of the scheduler.

## The safety rules, and why each exists

- **Daily cap (default 15).** Observed posting-block thresholds sit around
  10–20 group posts/day for an established account. Undocumented and moving, so
  this is a setting, not a constant.
- **Per-group cooldown (default 7 days).** What stops admins removing you. At
  100 groups and 15 posts/day, a 7-day cooldown still cycles every group weekly.
- **Per-ad-per-group cooldown (default 21 days).** Members should not see the
  same ad in the same place every week.
- **Randomised gaps (18–55 min).** A fixed cadence is a machine signature.
- **Active hours (08:00–21:00).** Nothing posts at 03:00.
- **Variant rotation.** Identical text across many groups in a short window is
  the single strongest spam signal. The planner avoids back-to-back duplicates.
- **Circuit breaker.** Any block, checkpoint or CAPTCHA stops everything until a
  human clears it. Sticky by design — an auto-reset would defeat the purpose.

## Dry run first

`plan()` produces the full schedule and posts nothing: every planned post with
its time, group, ad and variant, plus every excluded group with the reason.
Check the plan before pointing this at a live account.

## First run

```bash
npx playwright install chrome   # once
npm start                       # http://127.0.0.1:8787
```

Everything is driven from the UI. Terminal commands still exist (`npm run
bootstrap`, `npm run plan`, `npm run run`) but are no longer the main path.

In order:

1. **Import your groups.** Setup & Run → *Import groups from Facebook*. Chrome
   opens on a dedicated profile — sign in yourself, the app has no password
   field anywhere by design, and it waits up to 10 minutes for you including
   2FA. Imported groups arrive **inactive**; nothing can post until you switch
   them on.
2. **Curate the registry** (Groups tab). Per group: composer type (normal vs
   marketplace), which business may post there, the group's own rules, and
   whether it is active. Use the bulk bar — with 100 groups, row-at-a-time is
   not viable.
3. **Add ads** (Businesses & Ads). At least two ads per business, each with
   three or more caption variants. This is not optional polish: an ad cannot
   return to the same group for 21 days, so one ad leaves most of your daily
   cap unusable.
4. **Dry run** (Plan tab). Read the schedule and the exclusions before
   committing anything.
5. **Post.** Setup & Run → *Post just one* to start. The browser opens the
   group with the post composed; the UI shows you that group's rules and the
   caption, and waits. You click Post in Chrome, then tell the UI what
   happened. Start with one, not fifteen.

There is no build step. Everything runs through `tsx`; `npm run build` only
typechecks.

## Your data

`data/app.db` holds hand-curated work — which groups are active, each group's
composer type, its rules, business assignments — that **cannot be regenerated**
by re-running the importer. Treat it as the valuable artefact, not the code.

- **Never delete it to test something.** Point at a scratch file instead:
  `FBGP_DB=data/scratch.db npm start`. Every entry point reads that variable.
  `FBGP_PORT` moves the port, so a scratch instance can run beside the real one.
- **Snapshot before anything risky:** `npm run backup`. Uses `VACUUM INTO`, not
  a file copy — with WAL journalling most recent writes live in `app.db-wal`,
  so copying `app.db` alone can capture almost nothing. Keeps the last 20 and
  prunes older ones into `data/backups/`.
- Re-importing groups is always safe: rows are matched on their Facebook id and
  every curated field falls back to what is already stored.

## Due vs queued

A posting run only touches items that are **due** — scheduled time reached. A
committed plan places posts inside your active hours, so right after committing
at midnight everything is queued and nothing is due. That is correct, and the
Setup screen states both numbers plus the next scheduled time. **Bring next
post forward** overrides the pacing for exactly one post, which is what you
want when testing and not otherwise; cooldowns are untouched.

## Rounds vs the drip

Two different jobs, and picking the wrong one is the main way to lose groups.

- **Drip** (Plan → Setup & Run) is for steady coverage across many groups over
  weeks. It is what the cooldowns and the daily cap are tuned for.
- **Rounds** (Rounds tab) are for pushing one ad hard into a small set of groups
  you are willing to risk. Every member sees the same business several times a
  day; whether those admins tolerate it is a judgement about your groups that
  no setting can make for you.

A round is deliberately manual — there is no scheduler for it. You open the app,
pick the business and ad, dry-run it, and start it. It works through every
eligible group in one sitting, so the window has to stay open: with 20 groups at
the default 5–12 min spacing that is roughly two hours. Come back in a few
hours and start another; groups that have had their `roundsPerDay` allowance or
are still inside their rest period are skipped with the reason shown.

## Due vs waiting

`runDue(maxPosts, waitForUpcomingMs)` only ever picks up items that are already
due. That is right for the drip planner — a run started at midnight must not sit
holding a browser open until 08:00 — and it was wrong for rounds, badly.

A round schedules its posts into the near future (now, +7 min, +5 min, …). With
no waiting horizon the loop posted the first item, found the second not yet due,
and ended the run, closing Chrome. From the outside that is indistinguishable
from a crash: one post goes out and the browser never comes back.

So a run now takes a horizon. When nothing is due, it looks at the next
scheduled item; if that falls inside the horizon it holds the browser open and
waits, otherwise it stops and says why. The round job passes
`roundMaxGapMinutes + 5`; the drip run passes nothing and keeps the old
behaviour.

Two things fall out of that and are worth stating:

- **The waits do not stack.** The inter-post pause fires only when the next item
  is *already* due (a drained backlog, which must not go out as a burst). When
  the next item is in the future, its own scheduled time is the gap.
- **Waiting is interruptible.** A round can wait ten minutes at a time, so the
  wait is served in five-second slices and abandoned as soon as Stop is pressed.
  One long `await` would ignore the button for the whole wait.

## Deleting queue items and history

Both tables can be cleared from Queue & Log — per row, by multi-select, or by
sweeping a whole status. The two are not equally safe.

**Queue items are just plans.** Deleting one removes the intention to post, and
nothing else. `post_log.queue_item_id` is `ON DELETE SET NULL`, so the record
that a post actually happened outlives the queue row it came from. Sweeping
`cancelled` and `failed` is routine housekeeping. A `running` item is never
swept by status, because deleting the row a live run is holding strands the
orchestrator mid-post.

**History rows are the cooldowns.** `post_log` is where "when did this group
last hear from us" comes from, so deleting a `posted` row tells the planner that
group never heard from you and frees it to be posted to again immediately. The
API refuses to touch successful posts unless the caller passes `confirmPosted`,
and the UI asks a second time, spelling out the consequence. Deleting `failed`,
`skipped` or `blocked` rows is harmless — cooldowns already ignore them.

## Scale reality

At the default cap, each group hears from you roughly every
`max(activeGroups / dailyCap, perGroupCooldownDays)` days. With 100 groups and
a 7-day cooldown that is weekly, about 100 posts a week — which is the
sustainable ceiling, not a limitation to tune away. To actually consume 15
posts a day you would need around 105 active groups. **Joining more groups
raises reach; raising the cap raises risk.**
