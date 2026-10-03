# Example: Engineering Workflow

This page walks through a complete, fictional project from first requirement to follow-up task. The goal is to show the **method** the whiteboard supports — state what must be true, test it, keep the evidence, record the decision, and track the work — not just which buttons to press.

**The scenario:** a team is building a small motor drive. They worry that the motor controller overheats under sustained load. All names and numbers below are invented for illustration.

```text
Requirement ◀── tests ── Experiment ── supported_by ──▶ Evidence (table)
                                                            ▲
Decision ─────────────────── supported_by ──────────────────┘
   ▲
   └── depends_on ── Task
```

## Step 0: Set up the board

Create a board named "Motor drive — thermal". On the **canvas**, sketch the drive: a box for the controller, a box for the motor, and an arrow between them. Add a sticky note: *"Overheating seen on bench — see Semantic panel."*

The canvas is where the team thinks visually. The records below are where the facts live.

Open **History** and create a checkpoint called **"Start of thermal investigation"**. Now there is a known-good starting point.

## Step 1: Record what the design must achieve — a Requirement

In **Semantic**, create a **Requirement**:

- **Title:** Controller stays cool under load
- **Statement:** The motor controller must remain below 85 °C during sustained operation at any load up to 100%.
- **Status:** approved

A requirement is something you can later say is met or not met. Writing the number down is what makes it testable.

## Step 2: Record the part — a Component

Create a **Component**:

- **Title:** Motor controller
- **Subsystem:** Drive electronics
- **Status:** active

The requirement is not linked to anything yet. The experiment in the next step will be what connects to it.

## Step 3: Plan the test — an Experiment

Create an **Experiment**:

- **Title:** Controller load sweep
- **Objective:** Measure controller temperature at several sustained load levels.
- **Hypothesis:** The controller stays below 85 °C at every load.
- **Test type:** physical
- **Parameters** (one `name: value` per line): `ambient_c: 25` and `sustained_minutes: 20`
- **Pass criteria:** Peak temperature stays below 85 °C at every load for 20 minutes.
- **Status:** planned

Add relationships on the experiment:

- **tests → Controller stays cool under load** (the requirement)
- **tests → Motor controller** (the component)

Create a checkpoint, **"Before load sweep"**, then set the experiment's status to **running** and run the test on the bench.

## Step 4: Keep the real measurements — Structured Evidence

When the sweep finishes, create an **Evidence** record:

- **Title:** Load sweep results
- **Kind:** table
- **Structured table:** paste the following

```text
load_pct,temperature_c,duration_min,result
50,52,20,PASS
75,68,20,PASS
100,91,12,FAIL
```

Click **Build table** — the Inspector reports `Ready: 3 row(s) × 4 column(s)` — then **Create entity**.

| load_pct | temperature_c | duration_min | result |
|---:|---:|---:|---|
| 50 | 52 | 20 | PASS |
| 75 | 68 | 20 | PASS |
| 100 | 91 | 12 | FAIL |

At 100% load the controller hit 91 °C after only 12 minutes and the test was stopped. That row is exactly the kind of detail that would be lost if the result were written as "mostly passed".

Open the experiment and add: **supported_by → Load sweep results**. Then edit it: set the **Result** to *"Failed at 100% load: 91 °C after 12 minutes"* and the status to **completed**.

## Step 5: Update the requirement's status

The result is clear: the requirement is not met at full load. Edit **Controller stays cool under load** and set its status to **violated**.

Create a checkpoint, **"Sweep results recorded"**.

## Step 6: Record the decision

Create a **Decision**:

- **Title:** Add cooling capacity
- **Rationale:** Cooling is insufficient at maximum load: 91 °C at 100% load after 12 minutes, against an 85 °C limit.
- **Status:** decided

Add: **supported_by → Load sweep results**.

Anyone who opens this decision a year from now can follow the link straight to the measurements that justified it.

## Step 7: Track the follow-up work — a Task and a Risk

Create a **Task**:

- **Title:** Evaluate improved heatsink and airflow
- **Owner:** the person responsible
- **Status:** open

Add: **depends_on → Add cooling capacity**.

Create a **Risk**:

- **Title:** Thermal shutdown in the field
- **Likelihood:** medium
- **Impact:** high
- **Mitigation:** Improve cooling and add a temperature limit in firmware.
- **Status:** open

Open the task and add: **mitigates → Thermal shutdown in the field**.

## Step 8: Re-test and update

Weeks later, the team fits a larger heatsink and repeats the sweep. In the Evidence record **Load sweep results**, click **Edit entity** and paste the new, complete table:

```text
load_pct,temperature_c,duration_min,result
50,48,20,PASS
75,61,20,PASS
100,79,20,PASS
```

Click **Build table**, then **Save changes**. The Evidence record now shows the new measurements. The earlier table is not lost — checkpoints made before the update, such as "Sweep results recorded", still show the original failing results. (See [Structured Evidence](structured-evidence.md).)

Then update the statuses:

- Requirement → **satisfied**
- Experiment → **completed**
- Task → **done**
- Risk → **mitigated**

Create a checkpoint, **"Cooling fix verified"**.

## What the board now tells a newcomer

Open the Inspector and follow the links:

- The **requirement** states the 85 °C limit and is marked satisfied.
- The **experiment** tests it and points to the **evidence** table with the real numbers.
- The **decision** explains why cooling was added, backed by the same evidence.
- The **task** depends on that decision, and mitigates the **risk**.
- **History** shows who did each step and when, and the checkpoints mark the key moments — start, before the sweep, results recorded, fix verified.

That is the whole method: **state it, test it, keep the proof, record the decision, track the work** — with the reasoning connected rather than scattered across notes and spreadsheets.
