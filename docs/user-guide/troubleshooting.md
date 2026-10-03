# Troubleshooting & FAQ

Short answers to common questions. If your question is not here, ask the board's Owner — most access questions are answered by checking your role.

## Access

### Why can't I edit?

You are probably a **Viewer** on this board. Viewers can look at the canvas, the Semantic Inspector, and History, but cannot change anything — so the editing buttons (**＋ New entity**, **Edit entity**, **＋ Checkpoint**, **Restore this version**) are not shown to you, and the canvas will not accept changes. Your role is shown as a badge in the top bar and on the board's card in **Your whiteboards**. Ask the Owner to change your role to **Editor** if you need to make changes. See [Roles & Sharing](roles-and-sharing.md).

### Why can't I see a board?

Boards are private to the people invited to them. If a board is missing or its link will not open:

- Check that you are signed in to the account that was invited.
- Ask the Owner to send you an invitation — you may never have joined, or you may have been removed.
- If you used to see it, tick **Show deleted** on **Your whiteboards**. An Owner may have deleted it, and an Owner can restore it.

### My invitation does not work

Each invitation is for one person and expires after a while. If it has already been used, has expired, or was made for a different person, ask the Owner for a fresh one. If the message says the invitation is "invalid or unavailable", that is the usual reason.

## The canvas and the Semantic Inspector

### Why isn't my semantic entity a canvas shape?

By design. Semantic entities are structured records, shown in the **Semantic** panel. They are not drawn on the canvas, and canvas shapes are not records. Use canvas notes to point at records if you want a visual cue. See [Canvas Basics](canvas-basics.md).

### What's the difference between the canvas and the Semantic Inspector?

The **canvas** is free-form visual space: shapes, drawings, text, arrows. The **Semantic Inspector** holds structured engineering records — requirements, experiments, evidence, decisions, tasks — that you can link together. Use the canvas to think visually; use the Inspector to record facts and reasoning.

### Why is an archived entity missing?

Archived records are hidden from the Inspector list on purpose, and there is currently no filter that shows them again. The change is still in **History**, so you can see that it was archived, and by whom. Only archive records you are sure you no longer need. See [Semantic Inspector](semantic-inspector.md).

### I filtered the list and it went blank

The panel shows **No entities match this filter** and how many records the board has in total. Set **Type** and **Status** back to **All**.

### What's the difference between Evidence and an Experiment?

An **Experiment** is the test itself: what you are trying to find out, how, and what counts as passing. **Evidence** is the proof it produced: a measurement table, a file, a link. Typically an Experiment is **supported_by** one or more Evidence records.

## Structured Evidence

### Why did my CSV fail?

- **The first line must be the column headers**, followed by at least one row of data.
- **Cells are separated by plain commas.** A comma inside a value, such as `"Smith, J."`, splits it into two cells. Remove such commas from the data first.
- **Every row should have the same number of cells as the header.** Otherwise the Inspector warns that extra cells were dropped or missing ones left blank.
- **Limits:** up to 20 columns and 2,000 rows per table.
- **Build table is greyed out** until you have pasted something into the box.

Fix the text and click **Build table** again — nothing is saved until you click **Create entity** (or **Save changes**).

### Why is my previous Structured Evidence table still stored?

Updating a table creates a new one and leaves the old one in place, so that checkpoints and restores keep working. Old tables are not removed. See [Structured Evidence](structured-evidence.md).

## History and restore

### What does Restore actually do?

It makes an earlier state of the board the **current** state — the canvas and the engineering records. Your current board is checkpointed first, and the restore is recorded in History as new entries; nothing in the timeline is erased. See [History & Restore](history-and-restore.md).

### When should I create a checkpoint?

Before anything you might want to undo in bulk: a major experiment, a design change, a big cleanup, a change to an important decision, a risky batch of edits. They cost nothing.

## Connection and refreshing

### What happens if my connection drops?

Your changes are sent to the board as you make them. If you lose your connection, changes you make while offline may not be saved. Once you are back online, the board normally reconnects by itself; if it does not look right, refresh the page and check that your latest work is there. Do not rely on offline edits being kept.

### When should I refresh?

- After your connection was interrupted and the board does not seem to be updating.
- If the Inspector or History list looks out of date — try the panel's **Refresh** button first.
- After your role has been changed, to make sure you see the right buttons.

You do **not** need to refresh simply to save — saving is automatic.

### I reloaded and my shapes are gone

They are almost certainly just out of view. Press **Shift + 1** to zoom so that everything fits on screen.
