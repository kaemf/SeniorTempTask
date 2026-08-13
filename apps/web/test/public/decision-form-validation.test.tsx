import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecisionForm } from "../../src/components/DecisionForm";

afterEach(cleanup);

describe("DecisionForm amount parsing", () => {
  it.each([
    ["0.10", 10],
    ["12345.67", 1_234_567],
    ["12,50", 1_250],
  ])("converts %s exactly into %i minor units", async (input, expectedMinor) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={100_000_000} />);

    await user.type(screen.getByLabelText(/Approved amount/), input);
    await user.type(screen.getByLabelText("Reason"), "Affordability verified");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        decision: "APPROVED",
        approvedAmountMinor: expectedMinor,
        reason: "Affordability verified",
      }),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("DecisionForm amount validation", () => {
  it.each([
    ["abc", "not a number"],
    ["0", "zero"],
    ["-5", "negative"],
    ["1.234", "more than two decimal places"],
    ["5000.01", "above the requested amount"],
  ])("rejects %s (%s) without calling onSubmit", async (input) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.type(screen.getByLabelText(/Approved amount/), input);
    await user.type(screen.getByLabelText("Reason"), "Checked");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(onSubmit).not.toHaveBeenCalled();
    const error = await screen.findByRole("alert");
    expect(error).toBeVisible();
    const amountInput = screen.getByLabelText(/Approved amount/);
    expect(amountInput).toBeInvalid();
    expect(amountInput).toHaveAccessibleDescription(error.textContent ?? "");
  });

  it("rejects an empty amount without calling onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.type(screen.getByLabelText("Reason"), "Checked");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeVisible();
  });

  it("requires a non-empty reason", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.type(screen.getByLabelText(/Approved amount/), "100");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(onSubmit).not.toHaveBeenCalled();
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/reason is required/i);
    expect(screen.getByLabelText("Reason")).toBeInvalid();
  });

  it("requires a reason for rejections too", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.click(screen.getByLabelText("Reject"));
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason is required/i);
  });

  it("submits a rejection without an amount", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.click(screen.getByLabelText("Reject"));
    expect(screen.queryByLabelText(/Approved amount/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Reason"), "Insufficient income");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        decision: "REJECTED",
        reason: "Insufficient income",
      }),
    );
  });
});

describe("DecisionForm submitting state", () => {
  it("disables the form and shows a saving label while onSubmit is pending", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.type(screen.getByLabelText(/Approved amount/), "10");
    await user.type(screen.getByLabelText("Reason"), "OK");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    const savingButton = await screen.findByRole("button", { name: "Saving…" });
    expect(savingButton).toBeDisabled();

    resolveSubmit?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record decision" })).toBeEnabled(),
    );
  });
});
