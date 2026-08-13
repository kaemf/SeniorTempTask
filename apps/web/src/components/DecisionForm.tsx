"use client";

import { useEffect, useId, useState, type FormEvent } from "react";

export type DecisionFormValue =
  | { decision: "APPROVED"; approvedAmountMinor: number; reason: string }
  | { decision: "REJECTED"; reason: string }
  | { decision: "CONFIRMED"; reason: string };

export type DecisionFormMode = "initial" | "confirmation";

interface DecisionFormProps {
  requestedAmountMinor: number;
  mode?: DecisionFormMode;
  disabled?: boolean;
  /** Confirmation mode only: disable the Confirm option (e.g. the viewer proposed the approval). */
  disableConfirm?: boolean;
  onSubmit(value: DecisionFormValue): Promise<void> | void;
}

const AMOUNT_PATTERN = /^\d+([.,]\d{1,2})?$/;

/**
 * Largest amount (in minor units) the server can store — it persists amounts
 * in a 32-bit integer column (see MAX_AMOUNT_MINOR in the api package).
 * Kept as a local constant so the client bundle does not import server code.
 */
const MAX_AMOUNT_MINOR = 2_147_483_647;

/**
 * Parses a user-entered amount ("1250.50", "12,50", "10") into integer minor
 * units using string arithmetic only — no floating point. Returns null when
 * the input is not a plain positive decimal with at most two decimal places.
 */
export function parseAmountToMinorUnits(raw: string): number | null {
  const trimmed = raw.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) {
    return null;
  }
  const [wholePart = "", fractionPart = ""] = trimmed.split(/[.,]/);
  const minor = Number(wholePart + fractionPart.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

function formatMoney(minor: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(minor / 100);
}

export function DecisionForm({
  requestedAmountMinor,
  mode = "initial",
  disabled = false,
  disableConfirm = false,
  onSubmit,
}: DecisionFormProps) {
  type Choice = "POSITIVE" | "REJECTED";
  const positiveDecision = mode === "confirmation" ? "CONFIRMED" : "APPROVED";
  const positiveLabel = mode === "confirmation" ? "Confirm" : "Approve";
  const confirmUnavailable = mode === "confirmation" && disableConfirm;

  const [choice, setChoice] = useState<Choice>(confirmUnavailable ? "REJECTED" : "POSITIVE");
  const [approvedAmount, setApprovedAmount] = useState("");
  const [reason, setReason] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const amountErrorId = useId();
  const reasonErrorId = useId();

  // disableConfirm can change after mount (the acting user is resolved from
  // localStorage in an effect); never leave the disabled option selected.
  useEffect(() => {
    if (confirmUnavailable) {
      setChoice("REJECTED");
    }
  }, [confirmUnavailable]);

  const showAmountField = mode === "initial" && choice === "POSITIVE";

  function selectChoice(next: Choice) {
    setChoice(next);
    // A different decision invalidates previously reported field errors;
    // keeping them would resurface a stale alert (e.g. Reject → Approve
    // remounting the amount field with last submit's error).
    setAmountError(null);
    setReasonError(null);
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Defense in depth: the effect above normally flips the selection away
    // from a disabled Confirm, but a submit can land in the window between
    // paint and that effect. Never build a CONFIRMED decision in that case.
    if (confirmUnavailable && choice === "POSITIVE") {
      setFormError("Confirming this application is unavailable. Choose Reject instead.");
      return;
    }
    setFormError(null);

    let parsedAmountMinor: number | null = null;
    let nextAmountError: string | null = null;
    let nextReasonError: string | null = null;

    if (showAmountField) {
      parsedAmountMinor = parseAmountToMinorUnits(approvedAmount);
      if (parsedAmountMinor === null) {
        // The parser also returns null for well-formed numbers whose minor
        // units overflow the safe-integer range — report those as magnitude,
        // not format, problems.
        nextAmountError = AMOUNT_PATTERN.test(approvedAmount.trim())
          ? "Amount is too large."
          : "Enter a valid amount, e.g. 1250.50 — digits with at most two decimal places.";
      } else if (parsedAmountMinor <= 0) {
        nextAmountError = "The approved amount must be greater than zero.";
      } else if (parsedAmountMinor > MAX_AMOUNT_MINOR) {
        nextAmountError = "Amount is too large.";
      } else if (parsedAmountMinor > requestedAmountMinor) {
        nextAmountError = `The approved amount cannot exceed the requested amount (${formatMoney(
          requestedAmountMinor,
        )}).`;
      }
    }

    if (reason.trim().length === 0) {
      nextReasonError = "A reason is required for every decision.";
    }

    setAmountError(nextAmountError);
    setReasonError(nextReasonError);
    if (nextAmountError !== null || nextReasonError !== null) {
      return;
    }

    let value: DecisionFormValue;
    if (choice === "REJECTED") {
      value = { decision: "REJECTED", reason };
    } else if (positiveDecision === "CONFIRMED") {
      value = { decision: "CONFIRMED", reason };
    } else {
      if (parsedAmountMinor === null) {
        return;
      }
      value = { decision: "APPROVED", approvedAmountMinor: parsedAmountMinor, reason };
    }

    setSubmitting(true);
    try {
      await onSubmit(value);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="decision-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <fieldset disabled={disabled || submitting}>
        <legend>Decision</legend>
        <div className="choice-group">
          <label className="radio-row">
            <input
              checked={choice === "POSITIVE"}
              disabled={confirmUnavailable}
              name="decision"
              onChange={() => selectChoice("POSITIVE")}
              type="radio"
              value={positiveDecision}
            />
            {positiveLabel}
          </label>
          <label className="radio-row">
            <input
              checked={choice === "REJECTED"}
              name="decision"
              onChange={() => selectChoice("REJECTED")}
              type="radio"
              value="REJECTED"
            />
            Reject
          </label>
        </div>

        {showAmountField ? (
          <label>
            Approved amount
            <span className="input-affix">
              <span aria-hidden="true">€</span>
              <input
                aria-describedby={amountError !== null ? amountErrorId : undefined}
                aria-invalid={amountError !== null || undefined}
                inputMode="decimal"
                onChange={(event) => {
                  setApprovedAmount(event.target.value);
                  // The reported error described a previous value; editing
                  // the field makes it stale.
                  setAmountError(null);
                }}
                required
                type="text"
                value={approvedAmount}
              />
            </span>
          </label>
        ) : null}
        {showAmountField && amountError !== null ? (
          <p className="error" id={amountErrorId} role="alert">
            {amountError}
          </p>
        ) : null}

        <label>
          Reason
          <textarea
            aria-describedby={reasonError !== null ? reasonErrorId : undefined}
            aria-invalid={reasonError !== null || undefined}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(null);
            }}
            required
            rows={4}
            value={reason}
          />
        </label>
        {reasonError !== null ? (
          <p className="error" id={reasonErrorId} role="alert">
            {reasonError}
          </p>
        ) : null}

        {formError !== null ? (
          <p className="error" role="alert">
            {formError}
          </p>
        ) : null}

        <button className="primary-button" type="submit">
          {submitting ? "Saving…" : "Record decision"}
        </button>
      </fieldset>
    </form>
  );
}
