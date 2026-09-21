# Phase 0: what the API actually does

The extension is not written yet, and on purpose. Productive's docs do not say whether a sub-task
inherits the parent's subscribers because the web app pre-fills them or because the server adds
them, and that difference decides whether this extension is possible at all. `scripts/phase0.mjs`
settles it against your real org, on your laptop.

The one rule this whole exercise exists to enforce: **a subscriber list read back from the API is
not the notification list.** A create can come back with a clean empty array and still have sent
mail. So every task the script creates carries a unique title, and the run ends with a checklist
you hand to whoever is subscribed. Their answer is the finding. The arrays are only a hint.

## Setting up

1. Pick an internal project. Not a client project. The script reads the project's watchers and
   will refuse to run if more than three people other than you could be notified.
2. Make a task in it to use as the sandbox parent. Give it a service, so we can also learn whether
   a sub-task inherits one.
3. Add exactly one other subscriber. **A second account you control is better than a colleague**,
   because then the notification check is your own inbox and you can re-run freely. If it is a
   colleague, warn them first: this run creates up to eleven tasks and some of them will notify.
4. Generate a personal API token: Settings, API integrations, Generate new token.
5. For the watcher question, have that same person watch the project before the armed run.

## Running it

Read-only first. Nothing below creates anything.

```
export PRODUCTIVE_TOKEN='paste-your-token'

node scripts/phase0.mjs spec
node scripts/phase0.mjs read --task <sandbox parent id>
node scripts/phase0.mjs people
```

`spec` downloads the OpenAPI document and prints only the fragments that matter, because the full
file is enormous. `read` inspects the parent and probes how subscribers are exposed. `people`
prints counts, not a roster, so we can see whether `hrm_type_id`, company, or the email domain is
the clean signal for 4Site staff.

Then the dry run. This prints the exact JSON body of all eleven rows and sends none of them:

```
node scripts/phase0.mjs matrix --parent <sandbox parent id>
```

Read what it prints. When it looks right, arm it:

```
node scripts/phase0.mjs matrix --parent <sandbox parent id> --yes
```

It spaces the creates three seconds apart so the recipient's notification timeline stays in order,
then waits 45 seconds and re-reads everything, which catches a server that adds subscribers on a
delay. That delayed case is the one an obvious test misses.

## What to send back

1. The whole terminal output of the three read-only commands and the armed matrix.
2. The notification checklist the run prints at the end, with the recipient's answers.
3. Whether the same person also got anything from the two conversion rows (R7 and R8), which
   create a normal task and then turn it into a sub-task.

If you re-run later, `node scripts/phase0.mjs recheck` re-reads every task the script created.

## Cleaning up

```
node scripts/phase0.mjs cleanup        # lists what it would delete
node scripts/phase0.mjs cleanup --yes  # deletes them
```

It only ever touches ids it wrote to `scripts/.phase0-ledger.json`, newest first. Anything it
cannot delete stays in the ledger and gets named, rather than being quietly left behind. If
Productive only archives tasks instead of deleting them, say so and I will switch cleanup to a
close and archive.

## What the rows prove

| Row | What it sends | What the result tells us |
|---|---|---|
| R0 | a normal task, no parent, no subscribers | the floor: who this project forces onto every task |
| R1, R2 | sub-task, subscriber field absent | whether inheritance is server-side, in each wire form |
| R3, R4 | sub-task, empty subscriber list | whether an empty list is honored or ignored |
| R5, R6 | sub-task, subscribers set to just me | whether an explicit list wins. The happy path |
| R7, R8 | normal task, then converted to a sub-task | the fallback, if explicit lists lose |
| R9 | both wire forms at once, disagreeing | which form the server honors and which it drops |
| R10 | a sub-task of a sub-task | whether nesting is allowed |

Two wire forms are tested because the vendor docs describe flat `subscriber_ids` and `assignee_id`
attributes, while two independent public clients build the same fields as JSON:API relationships.
One of those is wrong and a 201 will not tell us which, since an unrecognized field is dropped
silently. R9 is what makes the answer legible.

## Then what

If any row keeps the subscriber list clean and the recipient confirms no notification, that shape
becomes the extension's create call. If none does, the honest outcome is a blocked build and a
support ticket to Productive with this table attached, not a version that creates the sub-task and
strips subscribers afterward. By then the mail has gone out.
