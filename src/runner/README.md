# The runner

This is the only part of the project that touches Facebook, and the only part
that cannot be tested here. Everything else has real tests; the selectors below
have been written from knowledge of how Facebook's UI is structured, **not
verified against the live site**. Expect to fix them.

## First run

```bash
npx playwright install chrome
npm run bootstrap
```

A Chrome window opens using a dedicated profile in `.browser-profile/`. Log into
Facebook yourself — the app has no field for a password anywhere, by design. The
session persists in that profile, so you only do this once.

`bootstrap` then scrolls your joined-groups list and imports what it finds. Safe
to re-run: groups are matched on their Facebook id, so your curation is never
overwritten.

## When something breaks

In rough order of likelihood:

1. **`composers.ts` → `SELECTORS`.** Every piece of Facebook UI the tool clicks
   or types into is in that one object. A `ComposerError` names the patterns it
   tried, so the message tells you which entry to fix.
2. **`detect.ts` → `BLOCK_SIGNALS`.** If a real block is sailing through, or the
   tool keeps stopping for no reason, the wording changed. Add the new phrasing.
3. **`discover-groups.ts`.** If the import finds nothing, Facebook restructured
   the joined-groups page. The anchor query in `discover()` is the thing to
   adjust; the parsing helpers around it are tested and are probably fine.

Failures screenshot themselves into `data/media/diagnostics/` — look there
first, it usually shows exactly what the page looked like.

## Assisted vs auto

Assisted mode fills the composer and then asks you, in the terminal, whether you
posted it. It asks rather than guessing from the DOM because "did that post
actually go through" is genuinely ambiguous to detect, and a wrong guess
corrupts the cooldown history that every safety rule depends on.

Auto mode is the same code plus `submitPost()`. It is off by default. Turn it on
for a handful of low-stakes groups first and read the log for a week before
widening it.

`submitPost()` is more careful than "click the Post button", for reasons that
each cost a silent failure once:

- It searches **inside the composer dialog**. A group page carries the word
  "Post" in several places — the Posts tab, "Post approval", other members'
  menus — so a page-wide `.first()` match clicks the wrong thing and reports
  success.
- It waits for the button to be **enabled**, not merely visible. Facebook keeps
  Post greyed out until the image finishes uploading, and clicking a disabled
  button does nothing.
- It tries every pattern in `SELECTORS.submit`, polling for up to 60s.
- It treats the **dialog closing** as the receipt. If the composer is still
  open, the post did not go out and the run says `failed` with a screenshot.

That last one matters most: a post recorded as sent but never sent starts the
group's cooldown, so the group goes quiet for a week over something nobody saw.

The mode itself is read from Settings at the moment of posting, so flipping
assisted → auto takes effect on the very next post — including posts already
sitting in the queue.

## What this module will not do

No fingerprint spoofing, no proxy rotation, no CAPTCHA solving, no multi-account
rotation. When Facebook shows a block or a checkpoint, the runner reports
`blocked`, the orchestrator trips the circuit breaker, and everything stops until
you clear it by hand. That is the intended behaviour, not a limitation to work
around — if you are seeing blocks, the answer is to post less, not to hide
better.
