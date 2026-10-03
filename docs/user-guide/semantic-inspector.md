# Semantic Inspector

The Semantic Inspector is where you keep your board's structured engineering records — the requirements you are designing to, the experiments you run, the evidence you collect, the decisions you make, and the tasks that follow. Each record is called an **entity**, and entities can be **linked** to one another so the reasoning is visible.

Records in the Inspector are separate from canvas shapes. Creating one does not draw anything on the canvas. See [Canvas Basics](canvas-basics.md).

## Opening the Inspector

Click **Semantic** in the top bar of a board. A panel opens on the right side. Click the **×** at its top, or **Semantic** again, to close it. **Refresh** reloads the list if you think it is out of date.

## The eight kinds of record

### Component

> A part, module, or subsystem of the thing you are building.

Create one when you want to track a physical or logical piece of the design.

Example: "Motor controller board", with Subsystem "Drive electronics" and a short Description.

Fields: Subsystem, Description.
Statuses: proposed, active, deprecated, archived.

### Interface

> A boundary where two parts meet — mechanical, electrical, data, power, or control.

Create one when how two things connect matters.

Example: "Controller-to-motor power connector", Kind **power**.

Fields: Kind (mechanical, electrical, data, power, control), Description.
Statuses: proposed, active, deprecated, archived.

### Requirement

> A condition the design should satisfy.

Create one for anything the design must achieve, stated so that you can later say whether it was met.

Example: "Robot must maintain at least 5 mm support margin during lateral weight shift."

Fields: Statement.
Statuses: draft, approved, satisfied, violated, archived.

### Task

> A piece of work someone needs to do.

Create one for a concrete next action.

Example: "Evaluate a larger heatsink", Owner "Sam".

Fields: Owner, Description.
Statuses: open, in_progress, blocked, done, archived.

### Experiment

> A test you plan to run, are running, or have run.

Create one when you want to check something against reality — in simulation or on real hardware.

Example: "Load sweep on motor controller", Test type **physical**, Pass criteria "Stays below 85 °C at every load."

Fields: Objective, Hypothesis, Test type (simulation or physical), Parameters, Metrics, Pass criteria, Result.
Statuses: planned, running, completed, inconclusive, archived.

Parameters and Metrics are typed one per line as `name: value`, for example:

```text
load_pct: 100
ambient_c: 25
```

### Decision

> A choice you have made, or are about to make, and why.

Create one so that nobody has to wonder later why the design is the way it is.

Example: "Use a larger heatsink", Rationale "Temperature exceeded the limit at full load."

Fields: Rationale.
Statuses: proposed, decided, superseded, archived.

### Risk

> Something that might go wrong.

Create one when you want to track a possible problem and what you are doing about it.

Example: "Controller may overheat in a closed enclosure", Likelihood **medium**, Impact **high**, Mitigation "Add airflow."

Fields: Likelihood and Impact (low, medium, high), Mitigation.
Statuses: open, mitigated, accepted, closed, archived.

### Evidence

> Something that backs up a claim: a measurement table, a file, a link, a commit.

Create one whenever a result, requirement, or decision should point at proof.

Example: "Load sweep results", Kind **table**, with the measurements stored as a table. See [Structured Evidence](structured-evidence.md).

Fields: Kind, Reference, Note. The kinds are git_commit, file_path, cad_file, simulation_file, image, graph, document, url, and table. For every kind except table, the Reference is stored as a plain label — it is not opened or fetched. A url reference must start with `https://`.
Statuses: active, archived.

## Finding records

The Inspector lists your records grouped by kind, with a count for each group, for example **REQUIREMENT (3)**. Each row shows the title and its current status.

Use the two drop-downs at the top to narrow the list:

- **Type** shows only one kind of record.
- **Status** shows only records with one status. The Status list offers the statuses that are currently present.

If your filters match nothing, the panel says so and tells you how many records the board has in total.

Click a row to open the record's **detail page**: all its fields, its status, and its relationships. **← Back to list** returns to the list.

## Creating a record

1. Click **＋ New entity**.
2. Choose the **Type**. The form changes to show the fields for that kind.
3. Enter a **Title** (required).
4. Optionally adjust the **ID**. It is filled in for you from the title; it only needs changing if you want a specific identifier, and it must be unique on the board.
5. Pick a **Status** (the first one in the list is the default) and fill in whichever fields you have information for.
6. Click **Create entity**.

If something is wrong — for example a required field is empty, or a url does not start with `https://` — a red message under the form explains it. Fix it and submit again.

## Editing a record

Open the record and click **Edit entity**. You can change the title, status, and fields. The type and ID are fixed once a record is created. Click **Save changes**.

Update statuses as work moves along — a Task goes from open to in_progress to done; a Requirement goes to satisfied or violated once you know.

## Archiving

There is no delete button. To remove a record from view, edit it and set its status to **archived**.

Archived records disappear from the Inspector list and cannot be shown again from there. Their history is still recorded, so you can see in **History** that they were archived and by whom. Archive records you are sure you no longer need.

## Relationships

A relationship links one record to another and says how they relate. To add one:

1. Open a record.
2. Under **Relationships**, click **＋ Add relationship**.
3. Choose the relationship type and the **Target entity**.
4. Click **Add relationship**.

To remove one, click the **×** beside it.

A relationship reads from the record you added it on, to the target. It is shown on the record where you added it. When you want to see everything an experiment relates to, open the experiment.

| Relationship | Meaning | Example |
|---|---|---|
| `contains` | This record includes the target as a part | Motor controller board **contains** Gate driver |
| `connects_to` | This record is physically or logically connected to the target | Power connector **connects_to** Motor controller board |
| `satisfies` | This record meets the target requirement | Larger heatsink **satisfies** Controller stays cool under load |
| `tests` | This record checks the target | Load sweep **tests** Controller stays cool under load |
| `blocks` | This record stops the target from going ahead | Missing driver chip (a risk) **blocks** Build prototype (a task) |
| `depends_on` | This record needs the target to be done or settled first | Evaluate heatsink (task) **depends_on** Improve cooling (decision) |
| `mitigates` | This record reduces the target risk | Add airflow (task) **mitigates** Controller may overheat (risk) |
| `supported_by` | This record is backed up by the target evidence | Improve cooling (decision) **supported_by** Load sweep results (evidence) |

You can link any record to any other record — the relationship names are there to make the link meaningful, not to restrict you.

### Three realistic chains

**Is a requirement being tested?**

```text
Requirement: Support margin stays above 5 mm
      ▲
      └── tests ── Experiment: Lateral weight-shift sweep
                         └── supported_by ──▶ Evidence: Sweep results table
```

**Why did we make this decision?**

```text
Decision: Use a larger heatsink
      └── supported_by ──▶ Evidence: Load sweep results
Task: Evaluate larger heatsink
      └── depends_on ────▶ Decision: Use a larger heatsink
```

**How are we handling this risk?**

```text
Risk: Controller may overheat in a closed enclosure
      ▲
      └── mitigates ── Task: Add airflow vents
```

## If you cannot see the buttons

**Viewers** can browse everything in the Inspector but do not see **＋ New entity**, **Edit entity**, or **＋ Add relationship**. If you need to change records, ask the board's owner for the Editor role. See [Roles & Sharing](roles-and-sharing.md).

## Next

[Structured Evidence](structured-evidence.md) shows how to keep real measurement tables as Evidence.
