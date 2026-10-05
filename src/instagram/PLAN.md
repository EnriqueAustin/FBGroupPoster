# Instagram campaign DMs — plan

Status: **steps 1–2 built** — domain, store, planner and lead lifecycle,
all tested, no browser yet. Next: step 3 (sign-in + collect-only harvest).

Same spirit as the Facebook module: assisted first, slow on purpose, stop the
moment the platform pushes back.

## The idea

Local businesses' followers are local customers. A **campaign** points at a
list of local business accounts ("sources"). A run opens each source's latest
post(s), collects the people who liked it, filters them, follows them, and a
day or two later sends them the campaign's message.

```
sources ──harvest──▶ leads ──filter──▶ follow ──wait 24–48h──▶ DM ──▶ (reply?)
```

## What will get the account blocked (and the rule that answers it)

Instagram is stricter than Facebook groups about exactly this pattern
(follow + cold DM to strangers, in volume). The rules below are the product;
the automation is secondary.

| Risk | Rule |
|---|---|
| Volume spikes | Daily caps, defaults **25 follows / 12 DMs / 80 profile visits**, settings not constants. |
| Machine cadence | Random gaps between actions (default 3–9 min), active hours only. |
| Cold DMs land in Message Requests and get reported | **Follow first.** DM soon after a follow-back, otherwise 24–48h after the follow. |
| Identical text to many people | Message variants with rotation, `{first_name}` placeholder, no back-to-back repeats. **No links in the first message.** |
| Messaging the same person twice | Global contacted registry: a username is contacted **once ever**, across all campaigns. |
| Ignoring warnings | "Action blocked", "Try again later", "We restrict certain activity", `/challenge/` → **IG circuit breaker trips**, everything IG stops until you clear it. Separate from the FB breaker. |
| Losing the main business account | It runs on the main account by choice, so every other rule here is set conservatively. Automating follows/DMs breaks Instagram's terms; the account is at some risk regardless. |

Also worth knowing: unsolicited direct marketing can fall under POPIA's
direct-marketing rules. Keeping the first message conversational and always
honouring "not interested" (→ lead marked `opted_out`, never contacted again)
keeps this on the right side of both the law and the spam filters.

## Data model (own tables, own `ig_schema_version`)

Code: `domain/types.ts`, `store/migrate.ts`, `store/sqlite-store.ts`.

- **ig_campaigns** — name, active, source handles, posts per source (default 1),
  max leads per post, likers/commenters toggles, DM delay hours (min/max),
  filters (JSON).
- **ig_message_variants** — campaign, text (`{first_name}`, `{username}`),
  optional image, weight, active.
- **ig_leads** — username (**globally unique** — this is the contacted
  registry), display name, campaign (RESTRICT: a campaign with leads can only
  be deactivated, never deleted), source, status, skip reason, timestamps incl.
  `followed_back_at` and `dm_due_at`, variant sent, attempts.
  Status: `new → followed → messaged → replied`, or `skipped | opted_out | failed`.
- **ig_actions** — every follow / DM / profile visit / harvest / check with
  outcome. The daily caps are counted from here, exactly like FB's `post_log`.
- **ig_settings** — single JSON row of overrides merged over
  `DEFAULT_IG_SETTINGS`, so new settings need no migration.

Logic: `planner/planner.ts` (what's next and when — caps, gaps, active hours,
DM/follow alternation, variant rotation, round-robin across campaigns),
`planner/lifecycle.ts` (every lead status change, paired with its action-log
row), `planner/filters.ts`, `planner/messages.ts`.

FB's media cleanup is told about IG variant images (`otherReferencedImages`),
so it never deletes them.

## Filters

Cheap ones run at harvest (no extra page loads): already contacted, username
looks like a bot/brand (digits soup, `shop`, `store`, `official`…), the source
account itself.

Profile-level ones run **just before following** (one profile visit each,
counted against the caps): private account, follower/following bounds, is a
business account, bio keywords to require or exclude.

## Runner (Playwright, shared Chrome profile)

- `instagram/runner/auth.ts` — `isLoggedIn` (`sessionid` cookie, not on
  `/accounts/login`, `/challenge/`, `/two_factor`), using `core/browser.ts`'s
  `waitForSignIn`. You sign in by hand once; the profile keeps it.
- `harvest.ts` — open source profile → newest post(s) → open the likes list →
  scroll and collect usernames. Instagram sometimes hides like lists or caps
  them; when it does, fall back to **commenters** (arguably better leads anyway).
- `follow.ts` — open profile, run profile filters, click Follow, confirm state.
- `dm.ts` — open the DM thread, type the message humanely. **Assisted:** you
  press Enter. **Auto:** it sends and confirms the message appears in the
  thread; anything unconfirmed is a failure, never a "sent".
- `detect.ts` — block/challenge signals → breaker.
- All selectors in one `SELECTORS` object, as in the FB runner. They will need
  fixing against the live site.

## Jobs & UI

Jobs go through the shared job runner (one browser job at a time, app-wide):
`ig-harvest` (collect only — nothing is followed or sent), `ig-run` (work
through due follows and DMs within caps).

New sidebar section **Instagram**: Campaigns (sources, filters, message
variants, dry run), Leads (table by status, bulk skip), IG Safety (caps,
gaps, breaker).

## Build order

1. **Domain + store + migrations**, with tests. Pure, no browser.
2. **Planner** — given leads, caps and the action log, decide what is due and
   when (reuses `core/rng.ts`, `core/time.ts`). Tests.
3. **Sign-in + harvest, collect-only.** First live test: does it find the
   likers you'd expect? Nothing is followed or sent.
4. **Follow + DM in assisted mode.** You approve each one.
5. **UI** for campaigns, leads, safety.
6. **Auto mode + reply tracking** (check inbox, mark `replied`, stop the
   sequence for that lead).

## Decisions

- **Account:** the main business account. Defaults are therefore conservative
  (25 follows / 12 DMs a day) — raise them slowly, and only while nothing has
  pushed back. A block here costs the account customers already know.
- **Who:** likers **and** commenters.
- **When to DM:** as soon as a follow-back is seen (30–180 min after it), and in
  any case 24–48h after the follow even with no follow-back.
- **Message:** text, with an optional image per variant (sent after the text).
