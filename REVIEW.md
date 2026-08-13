# Initial review

Findings from reading the existing slice before changing it. File references point at the code as submitted. Ordered by severity within each section.

## Critical issues

1. **Broken role authorization — any authenticated user can decide loans.** `underwriterProcedure` (`apps/api/src/router.ts:22`) checks `if (!ctx.session.user.role)`, which only rejects an empty/undefined role. A `SUPPORT` user passes the guard and can record loan decisions, violating the core rule that only `UNDERWRITER` may decide. The check must be `ctx.session.user.role !== "UNDERWRITER"`.

2. **Blanket `catch {}` destroys all error semantics.** The `decide` mutation wraps its whole body in a try/catch (`apps/api/src/router.ts:117`) that swallows its own deliberately thrown `TRPCError`s (NOT_FOUND, CONFLICT, BAD_REQUEST) and rethrows everything as `INTERNAL_SERVER_ERROR` "Decision failed". Clients cannot distinguish a validation problem from a lost race from a genuine outage; the web page's CONFLICT branch (`apps/web/src/app/applications/[id]/page.tsx:79`) is dead code because CONFLICT can never reach it. The original error and stack are also discarded, so real failures are undiagnosable.

3. **Race condition (TOCTOU) on the decision itself.** `decide` does find (`router.ts:79`) → status check (`router.ts:89`) → update (`router.ts:95`) as three separate queries with no transaction and no conditional predicate on the update. Two underwriters deciding the same application concurrently can both pass the status check and both "succeed"; the second silently overwrites the first, including flipping APPROVED to REJECTED. Terminality of APPROVED/REJECTED exists only as an in-process `if`, not as a persistence guarantee. This must become a single conditional update (`updateMany` with `status IN (expected)`, count 0 → CONFLICT) inside a transaction.

4. **Audit write is not atomic with the state change.** `updateApplication` and `createAudit` are separate non-transactional calls (`router.ts:95-108`, `apps/api/src/repository.ts:66-95`). If the audit insert fails, the application is already decided but has no audit trail — the exact "immutable trail for every effective decision" requirement broken — and thanks to issue 2 the caller just sees "Decision failed" while the decision actually persisted. The `failNextAudit` hook in `apps/api/test/support/in-memory-repository.ts:35` shows this scenario is expected to be handled. Both writes belong in one database transaction.

5. **PII written to logs.** `router.ts:84-87` logs the full `input`, the full `application` record (customer `taxId`, `nationalId`, `phone`, `email`, `monthlyIncomeMinor`), and the session user on every decision. Log pipelines are rarely scoped like the database; this is a data-protection incident waiting to happen. Log identifiers and statuses only.

6. **Unauthenticated `delete` mutation.** `loanApplications.delete` (`router.ts:58`) is on bare `t.procedure` — no session, no role check — so anyone who can reach the API can attempt to destroy application records, and by extension decision history. The UI never calls it. Additionally, the audit FK is `ON DELETE RESTRICT` (`packages/db/prisma/migrations/20260809000000_init/migration.sql:44-46`), so deleting a decided application would throw an unhandled Prisma error (a 500). I will remove the procedure entirely.

7. **Weak amount validation.** The input schema uses plain `z.number().optional()` for `approvedAmountMinor` (`router.ts:31`): `0`, negatives, fractions, and `Infinity` all pass the schema. `validateBusinessRules` catches non-integers and amounts above the requested amount, but never enforces positivity — approving `0` or `-100` succeeds. There is also no upper bound, while the columns are Postgres `INTEGER`; anything above 2,147,483,647 fails at the driver with an opaque error. Validation must be `z.number().int().min(1).max(2_147_483_647)` plus the ≤ requested-amount rule, and the reason should be trimmed at the boundary.

8. **Fail-open dev authentication.** The context factory (`apps/api/src/server.ts:26-32`) maps any unknown `x-user-role` header to `UNDERWRITER` and a missing `x-user-id` to `user-underwriter-1`. Absence of credentials grants the most privileged role — exactly backwards. Even a dev stub should fail closed (no/invalid headers → no session → UNAUTHORIZED) and the trust boundary should be documented.

9. **Response reports the requested decision, not the persisted state.** `decide` returns `status: input.decision` (`router.ts:112`) instead of the status actually written. Today they coincide; the moment a high-value approval lands in `PENDING_CONFIRMATION`, the response would claim `APPROVED` while the database says otherwise. Return the persisted row's status.

10. **The core two-underwriter business logic is missing entirely.** There is no `PENDING_CONFIRMATION` status (schema enum has three values, `packages/db/prisma/schema.prisma:15-19`), no 1,000,000 minor-unit threshold, no confirmation operation, no `proposedById` tracking, no self-confirmation ban, and no "rejection clears the active approved amount" handling. `LoanNotifier` (`apps/api/src/notifier.ts`) is defined but never referenced anywhere in the codebase, so none of the three required business notifications is sent. This is the main feature to build, on top of fixing 1–9 so it stands on safe ground.

## Non-critical improvements

1. **Float-based money parsing in the browser.** `DecisionForm` converts euros to minor units with `Math.round(Number(approvedAmount) * 100)` (`apps/web/src/components/DecisionForm.tsx:33`). Binary floating point makes this fragile, and `Number("")`/garbage yields `NaN` which is silently submitted. Parse the decimal string exactly (split on the separator, validate ≤2 fraction digits, integer arithmetic) and block submission on invalid input.

2. **No cache invalidation or success feedback after deciding.** The mutation on the review page never invalidates `getForReview`/`list`, so the page keeps showing the pre-decision status. There is no success message, errors are not keyed by TRPC error code (beyond the dead CONFLICT branch), and feedback is not announced via an `aria-live` region.

3. **List page flickers and paginates oddly.** `ApplicationsList` renders the full-page "Loading…" state on `isFetching` (`apps/web/src/components/ApplicationsList.tsx:97`) while a manual 5-second `refetch` interval runs, so the whole table collapses to a loading shell every 5 seconds. Use `isLoading` (or `refetchInterval` with `keepPreviousData`). `pageSize = 2` with `manualPagination: true` over a client-side slice is also confusing; trivial to tidy.

4. **Data minimization for SUPPORT users.** `toView` (`router.ts:35-49`) exposes `taxId`, `gender`, and `lastName` to any authenticated user, including SUPPORT (though `nationalId`/`phone` are deliberately withheld — a public test asserts it). Role-scoped views would be better; noted as deferred.

5. **Thin test coverage.** Four happy-path API tests (`apps/api/test/public/loan-applications.test.ts`) and one UI test. Nothing covers role enforcement, the threshold, confirmation, self-confirmation, conflicts, audit atomicity, races, money bounds, or notifications — precisely the risky paths.

6. **`INTEGER` money columns.** Amounts cap at ~2.1e9 minor units (~21.4M EUR). `BIGINT`/`BigInt` would be safer long-term; within the timebox I will enforce the bound in validation instead and defer the migration.

7. **Redis is provisioned but unused** (`docker-compose.dev.yaml:18-29`). Either use it (e.g., as a notification queue later) or remove it; for now it is just noted.

## Implementation plan

1. **Database (additive migration).** New Prisma migration: `ALTER TYPE "LoanApplicationStatus" ADD VALUE 'PENDING_CONFIRMATION'` and a nullable `proposedById` FK from `LoanApplication` to `User`. No backfill — legacy APPROVED/REJECTED rows stay terminal and are never reinterpreted. Keep the seed idempotent; do not touch `20260809000000_init`. Expand-only, so old code keeps running against the new schema.
2. **Domain layer.** A pure, exhaustively unit-tested state-machine function `decideTransition(application, command, actor)` with no I/O: PENDING_REVIEW + APPROVE ≤ 1,000,000 → APPROVED (notify `APPROVED`); PENDING_REVIEW + APPROVE > 1,000,000 → PENDING_CONFIRMATION retaining the proposed amount and recording the proposer (notify `APPROVAL_PROPOSED`); PENDING_CONFIRMATION + CONFIRM by a _different_ underwriter, carrying no amount → APPROVED preserving the proposed amount (notify `APPROVED`); REJECT from either non-terminal state, no amount, any underwriter including the proposer → REJECTED with `approvedAmountMinor` cleared, history intact in the audit table (notify `REJECTED`). Everything else → CONFLICT (wrong state), FORBIDDEN (self-confirmation), or BAD_REQUEST (invalid shape).
3. **API and persistence.** One repository method `applyDecision(...)` running a Prisma `$transaction`: a conditional `updateMany({ where: { id, status: { in: expectedStatuses } } })` whose `count === 0` maps to CONFLICT (optimistic concurrency — terminality enforced at the database, closing the race in issue 3), plus the audit insert in the same transaction (closing issue 4). Fix the role check to `role !== "UNDERWRITER"`; tighten zod (int, min 1, max 2,147,483,647, trimmed non-empty reason); remove the `delete` procedure; rethrow `TRPCError`s and log unexpected errors with ids/statuses only, no PII; make the dev session fail closed; return the actual persisted status.
4. **Notifications.** Dispatch through `LoanNotifier` _after_ the transaction commits; a notification failure is logged but never rolls back or fails the decision. This is at-most-once delivery, documented as such — a transactional outbox is the production answer and is deferred. Logging implementation wired in `server.ts`; a capturing fake in tests asserts type-per-transition.
5. **Frontend.** Exact decimal-string → minor-units parsing; status-aware review screen (initial decision form for PENDING_REVIEW; a confirmation view for PENDING_CONFIRMATION showing the proposed amount and proposer, where confirm carries no amount and reject is available); query invalidation after mutation; success and code-keyed error messages in an `aria-live` region; a dev user switcher driving `x-user-id`/`x-user-role` headers; list uses `isLoading` so refetches don't blank the table.
6. **Tests, then gates.** Add tests for each risk above: role enforcement (SUPPORT forbidden), threshold boundary (exactly 1,000,000 vs 1,000,001), confirmation and self-confirmation ban, conflict on already-decided and on concurrent decide, audit atomicity via `failNextAudit`, amount bounds, rejection clearing the amount, and notification dispatch/failure isolation. Finish with `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm build` all green.

## What I will not complete within the timebox

1. **Transactional outbox for notifications.** Correct exactly-once-ish delivery needs an outbox table plus a relay; within 90 minutes I ship post-commit at-most-once dispatch with the tradeoff documented.
2. **Real authentication/RBAC.** The header-based session remains a documented dev stub, hardened to fail closed. Production needs a real identity provider at the edge.
3. **Integration tests against real Postgres (testcontainers).** Concurrency safety is proven by the conditional-update semantics plus unit tests over an in-memory model with the same contract; a live-Postgres race test is the missing evidence tier.
4. **BIGINT money migration.** Bound is enforced by validation instead; the column-widening migration is deferred.
5. **SUPPORT-role data minimization** in `toView` (hide `taxId`/`gender`/`lastName` from non-underwriters).
6. **Server-side pagination** for the applications list; the dataset is tiny in this exercise.
7. **Redis usage** — provisioned but intentionally left untouched.

## Production readiness

### Observability

- **Metrics:** decision outcome counters labeled by decision type and resulting status; conflict (lost-race) rate; notification failure counter; decide-request latency histogram.
- **Logs:** structured, containing application id, actor id, previous/new status, and error codes only — never customer PII or full input payloads.
- **Traces:** a span around the decision transaction (find → conditional update → audit) and a child span for notification dispatch, so slow commits and notifier latency are separable.
- **Alerts:** 5xx rate on the decide endpoint, sudden conflict-rate spikes (suggests client retry storms or contention), and any notification failures (they are fire-and-forget, so the counter is the only signal).

### Rollout and rollback

- The migration is expand-only (new enum value + nullable column, no backfill, no renames), so the old API keeps working against the new schema. Deploy order: database migration first, then API, then web.
- Rollback = revert the application code. The extra enum value and nullable column remain in the schema, unused and harmless; no down-migration is needed. Because there is no backfill, existing final decisions are never reinterpreted as pending confirmation in either direction.
- Applications sitting in `PENDING_CONFIRMATION` during a rollback would be unreadable by the old code's three-state assumption — acceptable for this exercise, worth a guard (treat unknown statuses as read-only) in a real rollout.

### Known limitations

- Notifications are at-most-once: a crash between commit and dispatch loses the notification. The outbox pattern fixes this and is deferred.
- Authentication is a dev header stub; the API trusts `x-user-id`/`x-user-role` and must sit behind a real identity layer in production.
- `INTEGER` money columns cap amounts at 2,147,483,647 minor units (~21.4M EUR); enforced by validation, not by a wider column type.
- No server-side pagination or filtering on the list endpoint.
- Concurrency correctness is verified at the unit level against the conditional-update contract, and additionally smoke-tested against a local PostgreSQL 17.5 instance: two concurrent `decide` calls on the same PENDING_REVIEW application produced exactly one success and one CONFLICT with a single audit row. Sustained parallel-load testing (many writers, connection-pool pressure) remains out of scope.
- Live-database verification performed (local PostgreSQL 17.5, no Docker available): full migration history applied to a fresh database; the new migration applied to a simulated legacy database (init schema + pre-existing APPROVED/REJECTED/PENDING_REVIEW rows and an audit row) with all legacy rows byte-identical afterwards and the new status usable; the seed run twice without errors; the full two-underwriter workflow (high-value proposal → self-confirmation FORBIDDEN → cross-confirmation APPROVED with amount preserved; rejection from PENDING_CONFIRMATION clearing the amount; CONFLICT on terminal states; threshold boundary at exactly 1,000,000 approving immediately) exercised end-to-end over HTTP against the running API.
- tRPC error responses included stack traces in development mode; a custom `errorFormatter` now strips `stack` from every client-facing error regardless of NODE_ENV.
- The shared ESLint config compared `process.cwd()` against POSIX path suffixes, which never matched on Windows; it now normalizes the cwd to forward slashes before comparing, so lint works on Windows dev machines as well as Linux CI.

## Post-implementation adversarial review

After the initial implementation, a second review pass (requirements audit, adversarial API probing against the live database, frontend edge-case hunting, and a DB/test-quality audit) produced these hardening changes:

- **Proposer FK changed from `SET NULL` to `RESTRICT`** (migration `20260813120000_restrict_proposer_delete`, plus an index on `proposedById`): with `SET NULL`, deleting the proposing user would silently clear `proposedById` on an application still awaiting confirmation, voiding the self-confirmation ban. `RESTRICT` mirrors the audit `actorId` FK, so a user with an active proposal cannot be deleted.
- **Unknown session actor now fails cleanly.** A syntactically valid but non-existent `x-user-id` used to surface as an opaque 500 (audit FK violation, transaction rolled back). The FK violation is now mapped to `UNAUTHORIZED` "Session user is not recognized"; the rollback guarantee is unchanged and covered by a test.
- **Confirmation of an application with no stored proposed amount** (a data anomaly unreachable through the API) now returns CONFLICT instead of approving with a null amount.
- **Seed data now honors the audit invariant:** the seeded `PENDING_CONFIRMATION` fixture includes the audit row for its proposal.
- **Trust boundary and error formatter are unit-tested:** `parseDevSession` was extracted to `session.ts` and the stack-stripping formatter to `trpc-error.ts`, with tests covering fail-closed header parsing (missing/empty/array/lowercase/unknown values) and stack removal.
- **Applications list fixes:** row selection is keyed by application id (was array index, so selections silently migrated across pages/refetches); the page index clamps when data shrinks (was able to strand the user on an empty page); a failed background poll no longer replaces the loaded table with a full-page error (inline notice instead); empty state and distinct AA-contrast status pill styles for all four statuses added.
- **Decision form fixes:** field errors clear when the input or the selected decision changes; a submit-time guard prevents `CONFIRMED` from being produced while confirmation is unavailable (previously only a passive effect flipped the selection); over-cap amounts get a magnitude-specific message.

Residual risks accepted and documented: the Prisma repository's transaction path is proven by live manual verification and a contract-mirroring in-memory double, not by an automated integration suite (testcontainers deferred); audit-table immutability is enforced by construction at the application layer only (no DB trigger/`REVOKE`, and the app role retains UPDATE/DELETE grants); switching the dev user in a second browser tab desynchronizes an already-open tab's UI identity from its request headers (the server-side checks still apply — cosmetic only).
