"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { DecisionForm, type DecisionFormValue } from "@/components/DecisionForm";
import { DEFAULT_DEV_USER, getDevUser, userDisplayName } from "@/lib/devUser";
import { trpc } from "@/lib/trpc";

import { Providers } from "../../providers";

function formatMoney(minor: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(minor / 100);
}

function successMessageForStatus(status: string): string {
  switch (status) {
    case "APPROVED":
      return "Decision recorded — the application is now APPROVED.";
    case "REJECTED":
      return "Decision recorded — the application is now REJECTED.";
    case "PENDING_CONFIRMATION":
      return "Approval proposed — the application is now PENDING_CONFIRMATION and needs a second underwriter to confirm it.";
    default:
      return `Decision recorded — the application is now ${status}.`;
  }
}

function decideErrorMessage(code: string | undefined, serverMessage: string): string {
  switch (code) {
    case "CONFLICT":
      return "Application state changed — someone else acted on it; the page has been refreshed.";
    case "FORBIDDEN":
      return serverMessage && serverMessage !== "FORBIDDEN"
        ? serverMessage
        : "Your role cannot record decisions.";
    case "BAD_REQUEST":
      return serverMessage && serverMessage !== "BAD_REQUEST"
        ? serverMessage
        : "The decision was rejected as invalid. Check the values and try again.";
    default:
      return "Something went wrong while recording the decision. Please try again.";
  }
}

function ApplicationReview() {
  const params = useParams<{ id: string }>();
  const applicationId = params.id;

  const [actingUserId, setActingUserId] = useState(DEFAULT_DEV_USER.id);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Resolve the acting dev user after mount to avoid SSR/hydration mismatches.
  useEffect(() => {
    setActingUserId(getDevUser().id);
  }, []);

  const utils = trpc.useUtils();
  const application = trpc.loanApplications.getForReview.useQuery({ applicationId });
  const decide = trpc.loanApplications.decide.useMutation({
    onSuccess: async (result) => {
      setSuccessMessage(successMessageForStatus(result.status));
      await Promise.all([
        utils.loanApplications.getForReview.invalidate({ applicationId }),
        utils.loanApplications.list.invalidate(),
      ]);
    },
    onError: async (error) => {
      setSuccessMessage(null);
      if (error.data?.code === "CONFLICT") {
        // Someone else acted on the application: refresh so the screen
        // reflects the actual persisted state.
        await Promise.all([
          utils.loanApplications.getForReview.invalidate({ applicationId }),
          utils.loanApplications.list.invalidate(),
        ]);
      }
    },
  });

  if (application.isPending) {
    return <main className="shell">Loading application…</main>;
  }

  if (application.isError) {
    return (
      <main className="shell" role="alert">
        Could not load this application: {application.error.message}
      </main>
    );
  }

  const item = application.data;

  async function submit(value: DecisionFormValue) {
    setSuccessMessage(null);
    try {
      if (value.decision === "APPROVED") {
        await decide.mutateAsync({
          applicationId,
          decision: "APPROVED",
          approvedAmountMinor: value.approvedAmountMinor,
          reason: value.reason,
        });
      } else {
        await decide.mutateAsync({
          applicationId,
          decision: value.decision,
          reason: value.reason,
        });
      }
    } catch {
      // Surfaced to the user through decide.error below.
    }
  }

  const proposerId = item.proposedById;
  const viewerIsProposer = proposerId !== null && proposerId === actingUserId;
  const errorMessage = decide.isError
    ? decideErrorMessage(decide.error.data?.code, decide.error.message)
    : null;

  return (
    <main className="shell">
      <div className="eyebrow">Application {item.id}</div>
      <div className="title-row">
        <h1>{item.customer.fullName}</h1>
        <span className={`status status-${item.status.toLowerCase()}`}>{item.status}</span>
      </div>

      <section className="summary-card" aria-labelledby="application-summary">
        <h2 id="application-summary">Application summary</h2>
        <dl>
          <div>
            <dt>Requested</dt>
            <dd>{formatMoney(item.requestedAmountMinor)}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{item.customer.email}</dd>
          </div>
        </dl>
      </section>

      {successMessage !== null ? (
        <p className="notice notice-success" role="status" aria-live="polite">
          {successMessage}
        </p>
      ) : null}

      {item.status === "PENDING_REVIEW" ? (
        <section aria-labelledby="record-decision" className="decision-section">
          <h2 id="record-decision">Record a decision</h2>
          <DecisionForm
            disabled={decide.isPending}
            onSubmit={submit}
            requestedAmountMinor={item.requestedAmountMinor}
          />
        </section>
      ) : null}

      {item.status === "PENDING_CONFIRMATION" ? (
        <section aria-labelledby="confirm-decision" className="decision-section">
          <h2 id="confirm-decision">Confirm or reject the proposed approval</h2>
          <dl className="facts">
            <div>
              <dt>Proposed amount</dt>
              <dd>
                {item.approvedAmountMinor !== null ? formatMoney(item.approvedAmountMinor) : "—"}
              </dd>
            </div>
            <div>
              <dt>Proposed by</dt>
              <dd>{proposerId !== null ? userDisplayName(proposerId) : "Unknown"}</dd>
            </div>
          </dl>
          {viewerIsProposer ? (
            <p className="notice" role="note">
              You proposed this approval — a second underwriter must confirm it. You may still
              reject the application.
            </p>
          ) : null}
          <DecisionForm
            disableConfirm={viewerIsProposer}
            disabled={decide.isPending}
            mode="confirmation"
            onSubmit={submit}
            requestedAmountMinor={item.requestedAmountMinor}
          />
        </section>
      ) : null}

      {item.status === "APPROVED" ? (
        <p className="notice">
          This application is approved
          {item.approvedAmountMinor !== null
            ? ` with a final amount of ${formatMoney(item.approvedAmountMinor)}`
            : ""}
          . No further decisions can be recorded.
        </p>
      ) : null}

      {item.status === "REJECTED" ? (
        <p className="notice">
          This application is rejected. No further decisions can be recorded.
        </p>
      ) : null}

      {errorMessage !== null ? (
        <p className="notice notice-error" role="alert" aria-live="assertive">
          {errorMessage}
        </p>
      ) : null}
    </main>
  );
}

export default function ApplicationReviewPage() {
  return (
    <Providers>
      <ApplicationReview />
    </Providers>
  );
}
