# Structured Evidence

Structured Evidence lets you keep real experiment measurements as a table, attached to an Evidence record. Instead of squeezing a whole parameter sweep into a paragraph of prose, you store the actual rows and columns — and anyone can open and read them later.

Use it whenever a result is more than a sentence: a frequency sweep, a load test, a set of repeated trials.

## Creating a table

1. Open the **Semantic** panel and click **＋ New entity**.
2. Set **Type** to **Evidence**.
3. Enter a **Title**, for example "Lateral weight-shift sweep".
4. Set **Kind** to **table**. The Reference box is replaced by a **Structured table** box.
5. Paste or type your data into the box, as simple comma-separated text. **The first line is the column headers**; every line after that is one row.
6. Click **Build table**. The Inspector checks the data and reports, for example, `Ready: 2 row(s) × 4 column(s)`. If it finds a problem it tells you.
7. Click **Create entity**.

Example. Typing this:

```text
frequency_hz,support_margin_mm,slip_mm_s,result
0.16,5.22,12.1,PASS
0.17,4.95,13.4,FAIL
```

produces this table:

| frequency_hz | support_margin_mm | slip_mm_s | result |
|---:|---:|---:|---|
| 0.16 | 5.22 | 12.1 | PASS |
| 0.17 | 4.95 | 13.4 | FAIL |

Numbers are recognised as numbers; anything else is kept as text.

## Viewing a table

Open the Evidence record. Below its fields you see a summary such as **3 row(s) × 3 column(s)** with the column names. Click **View table** to show the full table, and **Hide table** to collapse it again.

## Updating a table when you have new data

1. Open the Evidence record and click **Edit entity**.
2. The form says *Leave blank to keep the existing table*. Paste the new, complete data into the **Structured table** box and click **Build table**.
3. Click **Save changes**.

**Updating a table creates a new, separate stored table rather than overwriting the old one.** The Evidence record now points at the new table; the old table is kept.

This is deliberate:

- **Checkpoints stay reproducible.** A checkpoint made before the update still refers to the table as it was at that moment.
- **Restoring works.** If you restore the board to an earlier state, the Evidence record points at the table it pointed at then, and that table is still there.

Paste the *whole* table each time — an update replaces the data, it does not add rows to the old one.

## How a table links into your reasoning

An Evidence record with a table is an ordinary Evidence record. Link it like any other: an Experiment can be **supported_by** it, a Decision can be **supported_by** it, and a Requirement can be **tested** by an Experiment that points to it. See [Semantic Inspector](semantic-inspector.md).

## Limits and known limitations

- **The data entry is deliberately simple.** Cells are split on plain commas. There is no support for quoted values or for a comma inside a cell, so a cell like `"Smith, J."` will be split in two. If your data contains commas inside values, clean it first. Rows with the wrong number of cells are flagged, with extra cells dropped and missing ones left blank.
- **Size limits.** A table can have up to 20 columns and 2,000 rows, and each board can hold up to 200 tables.
- **Old tables are kept.** Because updates never overwrite, earlier versions of a table remain stored. There is currently no way to delete them.
- **A table is a record of results, not a spreadsheet.** You cannot edit individual cells in place, and there are no formulas or charts. To correct a value, update the table with corrected data.
- Viewers can open and read tables but cannot create or update them.

## Next

[History & Restore](history-and-restore.md) explains how to protect important moments, including the state of your evidence.
