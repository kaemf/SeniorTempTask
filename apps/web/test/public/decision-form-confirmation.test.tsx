import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecisionForm } from "../../src/components/DecisionForm";

afterEach(cleanup);

describe("DecisionForm confirmation mode", () => {
  it("renders no amount field", () => {
    render(<DecisionForm mode="confirmation" onSubmit={vi.fn()} requestedAmountMinor={500_000} />);

    expect(screen.queryByLabelText(/Approved amount/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Confirm")).toBeInTheDocument();
    expect(screen.getByLabelText("Reject")).toBeInTheDocument();
  });

  it("submits a confirmation with only a reason", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm mode="confirmation" onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.type(screen.getByLabelText("Reason"), "Independent review complete");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        decision: "CONFIRMED",
        reason: "Independent review complete",
      }),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("submits a rejection from confirmation", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm mode="confirmation" onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.click(screen.getByLabelText("Reject"));
    await user.type(screen.getByLabelText("Reason"), "Second look failed affordability");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        decision: "REJECTED",
        reason: "Second look failed affordability",
      }),
    );
  });

  it("requires a reason before confirming", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm mode="confirmation" onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason is required/i);
  });

  it("disables Confirm and pre-selects Reject when disableConfirm is set", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <DecisionForm
        disableConfirm
        mode="confirmation"
        onSubmit={onSubmit}
        requestedAmountMinor={500_000}
      />,
    );

    expect(screen.getByLabelText("Confirm")).toBeDisabled();
    expect(screen.getByLabelText("Reject")).toBeChecked();

    await user.type(screen.getByLabelText("Reason"), "Rejecting my own proposal");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        decision: "REJECTED",
        reason: "Rejecting my own proposal",
      }),
    );
  });
});
