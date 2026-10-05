# Instagram campaign DMs — plan

Status: **planned, not built.** This is the design to build against, in the
same spirit as the Facebook module: assisted first, slow on purpose, stop the
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
| Volume spikes | Daily caps, defaults **30 follows / 15 DMs**, settings not constants. New accounts start lower. |
| Machine cadence | Random gaps between actions (default 3–9 min), active hours only. |
| Cold DMs land in Message Requests and get reported | **Follow first, DM 24–48h later.** Optional "only DM people who followed back". |
| Identical text to many people | Message variants with rotation, `{first_name}` placeholder, no back-to-back repeats. **No links in the first message.** |
| Messaging the same person twice | Global contacted registry: a username is contacted **once ever**, across all campaigns. |
| Ignoring warnings | "Action blocked", "Try again later", "We restrict certain activity", `/challenge/` → **IG circuit breaker trips**, everything IG stops until you clear it. Separate from the FB breaker. |
| Wrecking the main business account | Recommend a separate, warmed-up account. Automating follows/DMs breaks Instagram's terms; plan for the account being at risk. |

Also worth knowing: unsolicited direct marketing can fall under POPIA's
direct-marketing rules. Keeping the first message conversational and always
honouring "not interested" (→ lead marked `opted_out`, never contacted again)
keeps this on the right side of both the law and the spam filters.

## Data model (own tables, own `ig_schema_version`)

- **ig_campaigns** — name, active, source handles, posts per source (default 1),
  max likers per post, follow-first (bool), DM delay hours (min/max),
  filters (see below), message variants.
- **ig_message_variants** — campaign, text, weight, active.
- **ig_leads** — username (**globally unique**), display name, campaign,
  source handle, source post URL, status, skip reason, timestamps
  (`harvested_at`, `followed_at`, `dm_due_at`, `messaged_at`, `replied_at`).
  Status: `new → skipped | follow_queued → followed → dm_queued → messaged →
  replied | opted_out | failed`.
- **ig_action_log** — every follow / DM / profile visit / harvest with outcome.
  The daily caps are counted from here, exactly like FB's `post_log`.
- **ig_settings** — caps, gaps, active hours, DM delay, mode
  (`assisted` | `auto`), breaker state.

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

## Open questions

- One IG account for this, or your main business account? (Recommend separate.)
- Likers, commenters, or both?
- Should a DM wait for a follow-back, or go out after the delay regardless?
- First message: plain text only, or allow an image?
