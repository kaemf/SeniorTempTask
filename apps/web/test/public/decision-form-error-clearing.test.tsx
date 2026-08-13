import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecisionForm } from "../../src/components/DecisionForm";

afterEach(cleanup);

describe("DecisionForm stale error clearing", () => {
  it("clears the amount error and aria-invalid as soon as the amount changes", async () => {
    const user = userEvent.setup();
    render(<DecisionForm onSubmit={vi.fn()} requestedAmountMinor={500_000} />);

    await user.type(screen.getByLabelText(/Approved amount/), "abc");
    await user.type(screen.getByLabelText("Reason"), "Checked");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByLabelText(/Approved amount/)).toBeInvalid();

    await user.clear(screen.getByLabelText(/Approved amount/));
    await user.type(screen.getByLabelText(/Approved amount/), "125");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const amountInput = screen.getByLabelText(/Approved amount/);
    expect(amountInput).not.toHaveAttribute("aria-invalid");
    expect(amountInput).not.toHaveAttribute("aria-describedby");
  });

  it("clears field errors when the decision choice changes", async () => {
    const user = userEvent.setup();
    render(<DecisionForm onSubmit={vi.fn()} requestedAmountMinor={500_000} />);

    // Invalid amount and empty reason produce two field errors.
    await user.type(screen.getByLabelText(/Approved amount/), "abc");
    await user.click(screen.getByRole("button", { name: "Record decision" }));
    expect(await screen.findAllByRole("alert")).toHaveLength(2);

    await user.click(screen.getByLabelText("Reject"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Switching back must not remount the amount field with the stale error.
    await user.click(screen.getByLabelText("Approve"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Approved amount/)).not.toHaveAttribute("aria-invalid");
  });

  it("shows a magnitude-specific message for absurdly large amounts", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DecisionForm onSubmit={onSubmit} requestedAmountMinor={500_000} />);

    // Parses as a number but overflows the safe-integer/int32 range —
    // the format hint would be misleading here.
    await user.type(screen.getByLabelText(/Approved amount/), "99999999999999999999");
    await user.type(screen.getByLabelText("Reason"), "Checked");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Amount is too large.");
  });
});
