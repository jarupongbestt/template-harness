---
name: root-cause-debugging
description: Find the real cause before fixing. Use for any bug, test failure, or wrong behavior. Understand first, never guess.
---

# Root-Cause Debugging

**Rule:** Don't fix until you can say "**X** causes **Y** causes symptom **Z**, and my fix changes **X**." Can't fill that in? You haven't found the cause — keep digging, don't guess.

**Dig** by asking "why does that happen?" upstream from where the error *shows* to where it *starts*. Use only the effort the bug needs: a typo's chain is one line; an intermittent/async/multi-layer bug needs reproducing and narrowing until the cause is undeniable. Reach for logs or `git bisect` only when reasoning can't localize it.

**Stop rule:** If two fixes fail, stop trying a third — the cause or the design is wrong. Re-examine, or ask the user.

**Then:** fix the cause not the symptom; add a regression test if the bug could return; confirm the original case works.