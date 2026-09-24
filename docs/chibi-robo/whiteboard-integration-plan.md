# Chibi Robo whiteboard integration plan

## Implementation status -- 2026-09-22

V1 is implemented on `main` (`be088e4`, `46b7ab4`, `04bf600`; tests in
`04bf600`). This section is the delta between the plan below and what was
actually built; the rest of the document is still an accurate description of
the intent and constraints, and is left as originally written rather than
rewritten in place.

- **ID prefix is `engineering_entity:`, not `entity:`.** Verified against the
  installed `@tldraw/store@5.4.1` source: `RecordType.createId`/`isId`/
  `parseId` all tie a record's store ID to its `typeName`
  (`${typeName}:${suffix}`). Fighting that convention would only work by
  accident. The actual goal -- a namespace distinct from `shape:` IDs -- is
  fully preserved; only the literal string differs from this document's
  original sketch. See `shared/entities.ts` and
  `docs/reviews/2026-09-22-chibi-entity-design-deepseek.md`.
- **Storage is one record type, not eight.** `engineering_entity` carries an
  internal `entityType` discriminant validated by a Zod discriminated union,
  registered with `createTLSchema`'s `records` option (`server/rooms.ts`).
- **Relationship edges live only on the source entity's `relations` array**
  (no reverse index, no separate edge record). One-hop reverse lookups (`GET
  .../semantic-context?relationsFor=...`) scan all entities on read, which is
  fine at V1's expected board scale and was pressure-tested by DeepSeek (see
  the design review).
- **No hard-delete action exists.** `update_status` to `archived` is the only
  removal path, which is what actually delivers this document's "keep
  deletion reversible... prevent dangling IDs" goal -- nothing is ever
  removed, so a relation's `targetId` is always resolvable.
- **`record_experiment_result`, `attach_evidence`, `update_status`** are
  distinct, independently schema-validated actions (for legible history
  events and a clear AI-facing API), but share one underlying entity-update
  code path server-side rather than three duplicated branches.
- **History uses the existing generic snapshot-diff recorder unchanged** --
  no second history subsystem. It now emits `entity.created`/
  `entity.updated`/`entity.deleted` for `engineering_entity` changes instead
  of the generic `object.*` types, mirroring the pre-existing
  shape-specific `object.moved` special case.
- **Not yet built:** the human inspector UI and the nine-frame starter-board
  template (deferred; nothing in the V1 test list required them). The exact
  numeric read/write budgets below are implemented with concrete starting
  values in `shared/entities.ts` (`SEMANTIC_CONTEXT_LIMITS`,
  `SEMANTIC_WRITE_LIMITS`) rather than left as "TBD, needs load testing" --
  revisit them once real Chibi Robo boards exist.

## Purpose and boundary

Add the smallest useful engineering-semantic layer above the existing collaborative
tldraw canvas. Keep tldraw as the visual editor, the existing board database as the
persistent shared state, and the existing human/AI/system history attribution model.
This first layer is not a PLM, issue tracker, requirements database, or replacement for
source control.

Implementation should begin only after the outstanding public acceptance tests are
complete enough to establish a stable deployment baseline.

## First-layer entity types

Every visual semantic entity is anchored to one native tldraw shape ID and has a
stable semantic ID independent of layout. Evidence may be nonvisual and omit a shape
anchor when it references an existing board asset or external source.

| Type | Minimum purpose |
| --- | --- |
| `component` | A physical, electrical, software, or simulated subsystem or part |
| `interface` | A mechanical, electrical, data, power, or control boundary between components |
| `requirement` | A testable constraint with a short statement and status |
| `task` | A bounded engineering action with status and optional owner |
| `experiment` | A planned or completed test with hypothesis, method, result, and evidence links |
| `decision` | A selected option with rationale and consequences |
| `risk` | A possible failure or uncertainty with likelihood, impact, mitigation, and status |
| `evidence` | A reference to a file, measurement, image, run, commit, or external source |

## Minimal metadata envelope

Store one versioned, strictly validated metadata object per semantic entity:

```ts
type EngineeringEntityBase = {
  schemaVersion: 1
  id: string
  type: 'component' | 'interface' | 'requirement' | 'task' | 'experiment' | 'decision' | 'risk' | 'evidence'
  shapeId?: string
  title: string
  status?: string
  tags?: EngineeringTag[]
  relations?: Array<{ type: EngineeringRelationType; targetId: EngineeringEntityId }>
}
```

Define a strict discriminated union above this base with closed fields and status enums
for each type; do not expose a free-form `Record` in V1. Use `supported_by` relations as
the only evidence linkage rather than maintaining a second `evidenceIds` list. Semantic
IDs use a separate `entity:` namespace from native tldraw shape IDs. Reject unknown or
oversized values. Do not store prompts, secrets, large result bodies, or binary files
in metadata. Evidence references must be bounded board-asset identifiers or HTTPS URLs
from an explicit scheme allowlist rather than duplicated content.

`EngineeringEntityId` is `entity:` followed by 1–80 lowercase ASCII letters, digits,
underscores, or hyphens and must be unique within a board. `EngineeringRelationType`
is a closed enum containing only the relationship names below. Tags are normalized,
bounded strings (maximum 20 tags and 40 characters per tag), not an extensible schema.
Evidence URLs are stored and displayed as references only and are never dereferenced,
previewed, checksummed, or fetched by the server.

`task` and `risk` remain because they are required for the proposed Chibi Robo
workspace, but they stay deliberately thin: a task is only a current engineering
action, and a risk is only a concise uncertainty plus mitigation link. No scheduling,
notifications, workflows, assignment system, risk matrix, or portfolio reporting is
included.

## Minimal relationships

Support only directed typed links needed for initial engineering work:

- `component` **has_interface** `interface`
- `interface` **connects_to** `component` or `interface`
- any entity **satisfies** or **violates** `requirement`
- `task` **concerns** any entity
- `experiment` **tests** a component, interface, requirement, risk, or decision
- `experiment` **produces** `evidence`
- `decision` **resolves** a risk, requirement, experiment, or interface question
- `risk` **affects** any entity and **mitigated_by** a task, experiment, or decision
- any entity **supported_by** `evidence`

Relationships reference semantic IDs, never display titles. Prevent dangling IDs and
keep deletion reversible by marking entities archived before removing metadata.

## Default workspace

Create a starter board template containing visually distinct frames:

1. System Architecture
2. Mechanical
3. Electronics
4. Controls
5. Simulation
6. Experiments
7. Problems / Risks
8. Engineering Decisions
9. Current Tasks

These are ordinary tldraw frames, not database partitions. Entities may be placed in
any frame; frame placement supplies useful context but does not change authorization.

## Compact AI context

Extend the existing compact canvas API rather than sending a full tldraw snapshot.
Future read requests should accept bounded filters such as entity IDs, types, frame,
tags, relation neighborhood depth (exactly one initially), and changed-since history
cursor. Responses should include:

- compact visual objects already returned by the canvas API;
- validated engineering metadata for the selected objects;
- one-hop relationships whose endpoints are both authorized;
- referenced requirement/risk/evidence summaries;
- current document clock for optimistic concurrency.

Each response has hard limits on selected entities, relationship edges, referenced
summaries, and serialized bytes. A request exceeding a limit fails explicitly rather
than silently expanding into the full canvas.

Writes have matching hard budgets: maximum serialized bytes per entity and action
batch, maximum semantic entities and relationships per board, and per-token/per-session
semantic-write rate limits. Validation occurs before the atomic transaction so rejected
writes are neither broadcast nor recorded. Exact numbers must be established with load
tests before implementation, then enforced in the shared schema and server.

AI writes should remain explicit action requests with `expectedClock`. Add semantic
create/update/link/archive actions alongside existing visual actions; validate all
references and limits before one atomic application. Existing token permissions remain
the authorization boundary.

## Experiments and evidence

The first experiment representation contains only:

- title and status (`planned`, `running`, `completed`, `inconclusive`);
- hypothesis;
- short method;
- related component/interface/requirement/risk IDs;
- short result summary;
- `produces` or `supported_by` relations to evidence entities.

Evidence contains a label, kind, stable reference, optional checksum, and short note.
Measurements remain small scalar fields or referenced files; do not build a laboratory
notebook, time-series store, or file versioning system in V1.

## History and collaboration

Semantic mutations must flow through the same room transaction and history recorder as
visual mutations. History events retain the existing human, AI, and system source plus
actor attribution, and add entity type/ID and a bounded summary of semantic field and
relationship changes. Restore must restore visual and semantic state together. Live
clients receive semantic changes through the existing room synchronization path.

## Proposed first implementation sequence

1. Define strict shared schemas and size limits for the metadata envelope and eight
   entity types.
2. Store metadata in a dedicated namespaced tldraw record, not arbitrary shape metadata,
   so anchored and nonvisual entities share one lifecycle and are included in existing
   snapshots, collaboration, checkpoints, and restore. Shape deletion archives or
   detaches its anchored entity according to an explicit validated action; it never
   silently deletes semantic history.
3. Add compact filtered semantic reads and explicit semantic actions to the existing AI
   API, preserving token scopes and optimistic concurrency.
4. Add a lightweight human inspector for editing type, status, fields, and links.
5. Add the nine-frame starter-board command/template.
6. Add focused tests for validation, authorization, realtime sync, attribution,
   checkpoint/restore, dangling references, and bounded context responses.

## Explicitly deferred

- generalized workflows, schedules, resource allocation, approvals, and notifications;
- cross-project portfolios and organization-wide entity catalogs;
- BOM/PLM/CAD version management;
- arbitrary user-defined entity schemas or relation types;
- embeddings, vector search, autonomous background agents, and bulk ingestion;
- a separate semantic database unless measured limits prove the shared-record approach
  inadequate.

## Readiness gate

Begin implementation only after public multiuser synchronization, role enforcement,
reconnect, invitation, upload, session, history, and restore acceptance results are
recorded. The exit-node dependency may remain an accepted operational risk, but it must
be documented and monitored during those tests.
