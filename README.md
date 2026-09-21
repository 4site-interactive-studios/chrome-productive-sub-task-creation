# chrome-productive-sub-task-creation

A Chrome extension that creates a sub-task of the Productive task you are looking at, without
copying the parent's subscribers onto it. Two buttons: **Quiet** (just me) and **Team** (me plus
the parent's subscribers who work at 4Site). Creating a sub-task in Productive's own UI copies
every parent subscriber and notifies them, clients included, which is the behavior this routes
around.

The extension is not built yet. First we establish what Productive's API actually does when you
create a sub-task, because the docs do not say and getting it wrong means sending mail to a client.
See [PHASE0.md](PHASE0.md) for the probe script and how to run it.
