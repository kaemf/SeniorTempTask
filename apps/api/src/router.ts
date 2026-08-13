import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";

import type { LoanApplicationRecord, LoanApplicationView, RequestContext } from "./domain.js";
import { decideTransition, MAX_AMOUNT_MINOR } from "./domain.js";
import { stripErrorStack } from "./trpc-error.js";

const t = initTRPC.context<RequestContext>().create({
  transformer: superjson,
  // Never leak stack traces or other internals to clients, regardless of NODE_ENV.
  errorFormatter({ shape }) {
    return stripErrorStack(shape);
  },
});

const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

export const underwriterProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.session.user.role !== "UNDERWRITER") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

export const decideLoanApplicationSchema = z.strictObject({
  applicationId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED", "CONFIRMED"]),
  approvedAmountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR).optional(),
  reason: z.string().trim().min(1).max(2000),
});

function toView(application: LoanApplicationRecord): LoanApplicationView {
  return {
    id: application.id,
    status: application.status,
    requestedAmountMinor: application.requestedAmountMinor,
    approvedAmountMinor: application.approvedAmountMinor,
    proposedById: application.proposedById,
    customer: {
      fullName: application.customer.fullName,
      lastName: application.customer.lastName,
      gender: application.customer.gender,
      taxId: application.customer.taxId,
      email: application.customer.email,
    },
  };
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

export const appRouter = t.router({
  loanApplications: t.router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const applications = await ctx.repository.listApplications();
      return applications.map(toView);
    }),

    getForReview: protectedProcedure
      .input(z.object({ applicationId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const application = await ctx.repository.findApplication(input.applicationId);
        if (!application) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        }
        return toView(application);
      }),

    decide: underwriterProcedure
      .input(decideLoanApplicationSchema)
      .mutation(async ({ ctx, input }) => {
        const actorId = ctx.session.user.id;

        try {
          const application = await ctx.repository.findApplication(input.applicationId);
          if (!application) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
          }

          // Log identifiers and statuses only — never customer PII.
          ctx.logger.info(
            {
              applicationId: application.id,
              actorId,
              decision: input.decision,
              previousStatus: application.status,
            },
            "Processing loan decision",
          );

          const transition = decideTransition(
            application,
            {
              decision: input.decision,
              approvedAmountMinor: input.approvedAmountMinor,
              reason: input.reason,
            },
            actorId,
          );
          if (!transition.ok) {
            throw new TRPCError({ code: transition.code, message: transition.message });
          }

          const updated = await ctx.repository.applyDecision({
            applicationId: application.id,
            expectedStatus: transition.expectedStatus,
            newStatus: transition.newStatus,
            approvedAmountMinor: transition.approvedAmountMinor,
            proposedById: transition.proposedById,
            audit: {
              applicationId: application.id,
              actorId,
              previousStatus: application.status,
              newStatus: transition.newStatus,
              approvedAmountMinor: transition.approvedAmountMinor,
              reason: input.reason,
            },
          });
          if (updated === "CONFLICT") {
            throw new TRPCError({ code: "CONFLICT", message: "Application state has changed" });
          }
          if (updated === "UNKNOWN_ACTOR") {
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message: "Session user is not recognized",
            });
          }

          // Post-commit notification: best effort. A delivery failure must never
          // roll back or fail an already-persisted decision.
          try {
            await ctx.notifier.send({
              applicationId: application.id,
              type: transition.notification,
            });
          } catch (error) {
            ctx.logger.warn(
              {
                applicationId: application.id,
                notificationType: transition.notification,
                error: describeError(error),
              },
              "Notification delivery failed",
            );
          }

          return {
            applicationId: updated.id,
            status: updated.status,
            approvedAmountMinor: updated.approvedAmountMinor,
          };
        } catch (error) {
          if (error instanceof TRPCError) {
            throw error;
          }
          ctx.logger.error(
            {
              applicationId: input.applicationId,
              actorId,
              decision: input.decision,
              error: describeError(error),
            },
            "Unexpected loan decision failure",
          );
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Decision failed" });
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
