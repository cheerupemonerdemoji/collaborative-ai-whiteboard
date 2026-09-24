# DeepSeek pass 3 — Chibi Robo semantic-layer review

- Date: 2026-09-15
- Model: `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`
- Scope: only the integration plan, `shared/ai.ts`, `server/canvas-api.ts`, and
  `shared/history.ts`

## Reviewer response

DeepSeek judged the plan disciplined but warned that eight entity types, a free-form
`fields` record, and a broad relation vocabulary could drift toward a lightweight PLM.
Its direct answer was that the smallest high-value layer is stable identity plus:

- component/interface topology;
- requirement traceability;
- experiment hypothesis, method, result, status, and evidence;
- concise decisions and rationale;
- evidence references without content duplication.

### Must-change recommendations

1. Replace free-form fields with closed per-type schemas and status enums.
2. Avoid dual evidence linkage; keep `supported_by` relations and remove `evidenceIds`.
3. Resolve whether evidence must have a shape or can be a nonvisual URL/asset reference.
4. Give semantic IDs a namespace distinct from tldraw shape IDs.
5. Hard-cap compact-context expansion and keep it to one hop.
6. Register future semantic actions explicitly in or parallel to the existing action
   schema union.
7. The reviewer recommended removing `task` and `risk` because they invite project
   tracker and risk-register scope.

### Optional or deferred recommendations

- Tags, the starter frames, and semantic history summaries are useful but not
  foundational.
- Defer multi-hop relations, workflows, embeddings, and bulk ingestion.
- Keep evidence references bounded and namespaced and avoid storing large results.

## Codex disposition

- **Accepted and incorporated:** closed discriminated schemas, one canonical evidence
  relation, optional nonvisual evidence anchors, separate semantic ID namespace,
  explicit semantic actions, and hard response/one-hop limits.
- **Modified:** kept all eight user-requested entity types. `task` and `risk` are
  explicitly constrained to thin engineering annotations, with scheduling, workflow,
  notifications, risk matrices, and portfolio features prohibited.
- **Deferred:** schema/action implementation, human inspector, starter template, and
  semantic history code until public acceptance establishes a stable baseline.
