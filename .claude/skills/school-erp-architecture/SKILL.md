---
name: school-erp-architecture
description: Use when adding a new module, feature, endpoint or model to the School ERP, or when unsure where code belongs. Explains the module layout, request lifecycle, and the service/schema/policy pattern every feature must follow.
---

# School ERP architecture

## Responsibilities
Keep every feature consistent with the modular-monolith design in docs/SYSTEM_ARCHITECTURE.md.

## Workflow for a new feature
1. Locate the owning module in SYSTEM_ARCHITECTURE.md §3. If none fits, propose one and add an ADR row.
2. Schema: add/modify models in `prisma/schema.prisma`, run a named migration, update DATABASE_SCHEMA.md.
3. `src/modules/<m>/<m>.schemas.ts` — Zod input schemas (`.strict()`), exported types.
4. `src/modules/<m>/<m>.policy.ts` — scope checks for record access.
5. `src/modules/<m>/<m>.service.ts` — `authorize` → policy → transaction → `audit`.
6. Entry point: server action (`src/app/erp/.../actions.ts`, returning `ActionState`) for forms, and/or a route handler in `src/app/api/...` that maps `AppError`s explicitly.
7. UI in `src/app/erp/...` using shared components; mobile layout first.
8. Tests: unit (pure logic), integration (service + RBAC), e2e if it is a primary journey.
9. Run `npm run check:deps` (cycles + layer boundaries) and the quality gate.
10. Update API_DOCUMENTATION.md, DEVELOPMENT_PROGRESS.md, CHANGELOG.md. Check the phase scope in DEVELOPMENT_ROADMAP.md before starting.

## Rules
- Services are the only mutation path. No Prisma in pages/components/handlers.
- Modules depend one way; call other modules through their services.
- Providers behind interfaces in `src/lib/<area>/`.

## Example skeleton
```ts
// src/modules/library/library.service.ts
export async function issueBook(ctx: AuthContext, input: IssueBookInput) {
  authorize(ctx, "library.issue");
  return prisma.$transaction(async (tx) => {
    const copy = await tx.bookCopy.findUniqueOrThrow({ where: { id: input.copyId } });
    if (copy.status !== "AVAILABLE") throw new ConflictError("Copy is not available");
    const issue = await tx.bookIssue.create({ data: { ...input, issuedAt: new Date() } });
    await tx.bookCopy.update({ where: { id: copy.id }, data: { status: "ISSUED" } });
    await audit(tx, ctx, { action: "library.issue", entityType: "BookIssue", entityId: issue.id, after: issue });
    return issue;
  });
}
```
