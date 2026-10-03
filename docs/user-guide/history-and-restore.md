# History, Checkpoints, and Restore

Your board keeps a record of what changed, who changed it, and when. You can look back at any moment, mark important moments with a checkpoint, and — if you need to — return the board to an earlier state.

Three ideas, kept separate:

**History** records meaningful changes.

**A checkpoint** marks an important board state with a name you choose.

**Restore** creates a **new current state based on an earlier state**. It does not erase or rewrite the history that came before.

## Opening History

Click **History** in the top bar of a board. A panel opens on the right with a timeline, newest first. Each entry shows who did something, what they did, and when — for example *"Sam created a checkpoint"*, *"Sam entity updated"*, or *"Alex added an object"*.

The timeline covers both canvas changes (shapes added, edited, moved, deleted) and engineering-record changes (records created, updated, archived), as well as people joining the board and checkpoints.

### Finding an entry

Use the filters at the top:

- **Person** — only one person's activity.
- **Source** — all activity, only people, only AI assistants, or only system activity.
- **Event** — only one kind of event, such as *Checkpoint Created* or *Entity Updated*.

**Refresh** reloads the timeline. If there is more history than fits, **Load older activity** at the bottom shows earlier entries.

## Checkpoints

A checkpoint is a bookmark: *"the board as it is right now, with this name."*

To create one:

1. In the History panel, click **＋ Checkpoint**.
2. Optionally type a name. A descriptive name helps — "Before heatsink change" is much more useful than nothing.
3. Click **Save checkpoint**.

The checkpoint appears in the timeline. Only Owners and Editors can create checkpoints.

### Good moments to create a checkpoint

- Before running a major experiment
- Before a design change
- Before a large cleanup
- Before changing an important decision
- Before any risky batch of edits
- When you reach a state you are happy with

A checkpoint costs nothing and keeps nothing from you — make them freely.

## Looking at an earlier state

Click any entry in the timeline. The board switches to a **read-only view of how it was at that moment**. A banner at the top says **READ-ONLY HISTORY** with the date and time, and reminds you that the live whiteboard has not changed.

In this view you can:

- Use **← Older** and **Newer →** to step through the timeline.
- Click **Return to live board** to go back to the present.
- Click **Restore this version** (Owners and Editors only) to go back to this state — see below.

Nothing you do while looking at a past state changes the live board.

## Restoring

Restore makes an earlier state the board's **current** state.

1. Open the earlier state by clicking its entry in the timeline.
2. Check that it is the state you want.
3. Click **Restore this version**.
4. A confirmation appears: *Restore this version as the new live version? The current board will be checkpointed first.* Click **Yes, restore**, or **Cancel** to back out.

> **Restore changes the current board state. Review the earlier state before restoring.**

What restore does:

- The board — the canvas **and** your engineering records and their evidence — becomes what it was at the chosen moment.
- Your **current** board is checkpointed first, automatically, so the state you are restoring away from is not lost.
- Restore is recorded in the history as new entries (*started restoring an earlier version* and *restored an earlier version*). The earlier history is not removed or changed, so you can see exactly what happened.
- Because the state you left was checkpointed, you can undo a restore by restoring back to that checkpoint.

What restore does not do:

- It does not delete anything from the timeline.
- It does not affect other boards.

A restore changes the board for everyone who uses it, so tell your team before restoring a shared board.

## Viewers

Viewers can open History and look at earlier states, but cannot create checkpoints or restore. See [Roles & Sharing](roles-and-sharing.md).

## Next

[Roles & Sharing](roles-and-sharing.md) explains who can do what and how to invite people.
