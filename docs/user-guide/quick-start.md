# Quick Start

This walkthrough takes about ten minutes. By the end you will have a small, connected set of engineering records on a board, and a checkpoint you can return to.

You will build this chain of reasoning:

```text
Experiment ── tests ──────────▶ Requirement
Experiment ── supported_by ───▶ Evidence
Decision   ── supported_by ───▶ Evidence
Task       ── depends_on ─────▶ Decision
```

Read in plain words: *an experiment tests a requirement; the experiment's result is backed by evidence; a decision is backed by that evidence; and a task follows from the decision.*

## 1. Sign in

Someone with a board gives you an **invitation link**. Open it, then:

- If you are new, choose **Create account**, enter your display name, a username or email, and a password of at least 10 characters. The invitation is filled in for you.
- If you already have an account, choose **Sign in**. Once you are signed in you see **Join this whiteboard**; click **Accept invitation** and the board is added to your list.

If you were handed an invitation as a code instead of a link, create your account and paste the code into **Invitation code**. Invitations are meant for one person, so ask for a new one if yours does not work.

## 2. Open or create a board

After signing in you land on **Your whiteboards**.

- Click a board card to open it, or
- Click **＋ New whiteboard**, type a name, and choose **Create and open**.

For this walkthrough, create a new board called "Quick Start Practice". You become its **Owner**.

## 3. Add something to the canvas

The big area in the middle is the canvas. Pick the rectangle or sticky-note tool from the toolbar at the bottom, then click and drag on the canvas. Type a few words in it — for example, "Motor driver overheats". You can move it, resize it, or delete it. See [Canvas Basics](canvas-basics.md) for the full tour.

Your changes save automatically. Reload the page and everything is still there.

## 4. Open the Semantic Inspector

In the bar at the top of the board, click **Semantic**. A panel opens on the right. It is empty because you have not created any engineering records yet.

Remember: canvas shapes and Semantic Inspector records are different. The record you are about to create will **not** appear as a shape on the canvas — you find it in this panel. [Canvas Basics](canvas-basics.md) explains why.

## 5. Create a Requirement

Click **＋ New entity**.

1. **Type:** choose **Requirement**.
2. **Title:** "Controller stays cool under load".
3. **Statement:** "The motor controller must stay below 85 °C during sustained operation."
4. Click **Create entity**.

You land on the new record's detail page.

## 6. Create an Experiment

Click **← Back to list**, then **＋ New entity** again.

1. **Type:** **Experiment**.
2. **Title:** "Load sweep on motor controller".
3. **Objective:** "Measure controller temperature at several load levels."
4. **Test type:** **physical**.
5. **Pass criteria:** "Stays below 85 °C at every load."
6. Click **Create entity**.

## 7. Create Evidence

Create another entity:

1. **Type:** **Evidence**.
2. **Title:** "Load sweep results".
3. **Kind:** **url**, and for **Reference** enter any `https://` address (for example, a link to a log or report).
4. Click **Create entity**.

Evidence records point at something that backs up a claim — a file name, a link, a commit, or a measurement table. To store a real table of numbers instead of a link, see [Structured Evidence](structured-evidence.md).

## 8. Link the records

Open the **Load sweep on motor controller** experiment from the list. Under **Relationships**:

1. Click **＋ Add relationship**.
2. Relationship: **tests**. Target entity: **Controller stays cool under load**. Click **Add relationship**.
3. Click **＋ Add relationship** again. Relationship: **supported_by**. Target: **Load sweep results**. Click **Add relationship**.

The links appear under the experiment's **Relationships** heading. A relationship is shown on the record you added it from.

## 9. Create a Decision and a Task

Create a **Decision** titled "Improve cooling" (Rationale: "Temperature exceeded the limit at full load."). Open it and add a relationship: **supported_by → Load sweep results**.

Create a **Task** titled "Evaluate a larger heatsink". Open it and add a relationship: **depends_on → Improve cooling**.

You now have the full chain from the diagram at the top of this page.

## 10. Open History and create a checkpoint

Click **History** in the top bar. You will see a timeline of everything you just did — every record you created and every link you added — with your name and the time.

Click **＋ Checkpoint**, give it a name such as "Quick start complete", and choose **Save checkpoint**.

A checkpoint is a named bookmark of the board as it is right now. If something goes wrong later, you can go back to it. See [History & Restore](history-and-restore.md).

## Where to go next

- Learn what each kind of record is for: [Semantic Inspector](semantic-inspector.md)
- Store real measurement tables: [Structured Evidence](structured-evidence.md)
- See the whole method on a realistic project: [Example: Engineering Workflow](engineering-workflow-example.md)
- Invite teammates: [Roles & Sharing](roles-and-sharing.md)
