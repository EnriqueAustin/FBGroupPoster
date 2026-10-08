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

Auto mode clicks Post through `submitPost()` in `facebook/runner/composers.ts`, which
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

## Posting as a Page (identities)

Each business posts as one **identity**: your personal profile (the default)
or a Facebook Page that profile manages. Pages are added under Setup & Run →
Posting identities, and picked per business with "Posts as" on the Ads screen.
Ads and variants stay on the business, so nothing about them changes.

Each identity has **its own Chrome profile** (`core/browser.ts`,
`profileDirFor`). The personal profile keeps `.browser-profile/`, and each Page
gets `.browser-profile-page-<id>/`. The first import or run as a Page opens a
signed-out window: sign in with your own account there, once. From then on that
window stays switched into the Page. It is separate because "acting as a Page"
covers the whole Facebook session. Two runs sharing one profile would keep
switching each other between profile and Page in the middle of a post.

To act as the Page, the runner switches that profile's session into it, the way
you would by hand (the "Switch now" button on the Page). Facebook marks a
switched session with an `i_user` cookie
holding the Page's id, and `facebook/runner/identity.ts` uses only that cookie to
confirm who it is acting as. If it cannot switch automatically it asks you to
do it, then checks again. **If the switch cannot be confirmed, that post fails.
It never goes out under the wrong name.**

Groups are still one row per Facebook group, but **membership is per
identity** (`group_memberships`):

- A Page has to join each group itself, and many groups don't allow Pages. So
  importing groups takes an identity: "Import groups" for a Page switches into
  it and records only the groups it has joined. A group you and the Page are
  both in stays one row, keeps its curation, and gains a second membership.
  A group the Page no longer appears in is marked as left for the Page only.
- The planner, rounds and run loop only use groups where the business's
  identity is an active member (`facebook/scheduler/membership.ts`). Otherwise the plan
  excludes the group as `not-a-member`.
- If a group refuses a *Page* (`group-restricted`), only the Page's membership
  there is quarantined. Your profile can still post in that group.

What is deliberately **shared** across identities:

- **Per-group cooldowns.** The same ad from your profile and from your Page in
  one group is still one person posting twice, as far as the group's admins
  can tell.
- **The circuit breaker.** A Page is operated through your account, so an
  account-wide block or checkpoint stops everything.
- **The daily cap.**

### Running as two identities at once

Every job (import, posting run, round) runs in its identity's **lane**
(`core/jobs.ts`). Jobs in different lanes run side by side, each in its own
Chrome window. A second job in a busy lane is refused. So a round for a
business that posts as the Page can run while a round as the profile is going.

- A run takes only the queue items of businesses posting as its identity
  (`createOrchestrator({ identityId })`). Starting a round clears only that
  identity's stale round items, so the other round's queue is not touched.
- The circuit breaker is re-read before every post. If one run hits a
  checkpoint, the other stops at its next post.
- A round leaves out a group that another identity's round still has queued.
  That is the same per-group rest as above, applied before the other round's
  post lands in the history. That round's queued posts also count towards the
  daily round ceiling.
- Stop, and "Stop the run" at a post, end only that run.

Existing databases upgrade with every group as a profile membership and every
business posting as the profile, so nothing changes until you pick a Page.

## Shape

The app is a shell with one module per platform: Facebook groups, and
Instagram campaign DMs (`src/instagram/PLAN.md` — built, but its selectors
have not yet been run against the live site).

```
core/              shared, platform-agnostic
  browser.ts       persistent Chrome profile + wait-for-the-human sign-in loop
  jobs.ts          background jobs, one per lane (a lane is a Chrome profile)
  job-routes.ts    poll / answer / stop a job
  migrations.ts    per-module migration runner (one version table per module)
  http.ts rng.ts time.ts config.ts
facebook/          the group poster
  domain/          types + interfaces. Depends on nothing.
  store/           SQLite persistence behind the Store interface.
  scheduler/       Decides what gets posted where and when. Pure, seeded, testable.
  runner/          Playwright. Two composers: normal status, marketplace listing.
  orchestrator.ts  The run loop + circuit breaker.
  routes.ts        Fastify API.
  cli/             Terminal entry points.
instagram/         campaign DMs (own tables, own breaker, own Chrome profile)
  domain/          types + interfaces, including the IgRunner contract.
  store/           SQLite behind IgStore. Tables are ig_*, version ig_schema_version.
  planner/         What is due and when; lead lifecycle; filters; message rendering.
  runner/          Playwright: auth, harvest (collect-only), follow, dm, check.
  orchestrator.ts  Three loops: harvestIg, checkIg, runIg.
  routes.ts        Fastify API under /api/ig.
server/main.ts     Wires core + modules together; 127.0.0.1 only.
cli/backup.ts      Snapshot of the whole database.
web/               Local UI, no build step.
```

Inside a module, parts talk only through its `domain/contracts.ts`: the
scheduler has never heard of SQLite; the runner has never heard of the
scheduler. Modules never import each other — anything two modules need lives
in `core/`.

All modules share **one database file** (each owns its own tables and its own
version table) and **one job runner**. They do not share a Chrome profile: each
Facebook identity has one and Instagram has its own, and a job runs in its
profile's lane, so Instagram work and a Facebook round can be going at once
while two jobs in one lane cannot.

What is deliberately **not** shared between Facebook and Instagram: the
circuit breaker (a Facebook block says nothing about the Instagram account, and
the reverse), the daily caps, and the sign-in. The one thing that crosses is
media cleanup, which is told about Instagram's variant images so it never
deletes a file the other module is using.

## Instagram campaign DMs

A campaign points at local business accounts, collects the people who engage
with their posts, follows them, and messages them once a day or two later —
or sooner if they follow back. `src/instagram/PLAN.md` has the reasoning, the
data model, what will get the account blocked, and the order to try things in.

Two rules are worth repeating here, because they are what the module is for:

- **A username is a lead once, ever.** `ig_leads` is also the contacted
  registry, keyed on the username across every campaign, so nobody is
  approached twice. This is why a campaign with leads can be deactivated but
  never deleted.
- **Nothing is recorded as done unless it was confirmed.** A follow counts
  only once the button is seen to stay on "Following"; a DM counts only once
  the message is in the thread (or the human says they sent it). An
  unconfirmed action is a failure, because recording a follow that never
  happened would schedule a cold DM to someone who never saw it.

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
