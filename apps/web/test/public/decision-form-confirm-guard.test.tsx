import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as ReactModule from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecisionForm } from "../../src/components/DecisionForm";

// DecisionForm normally flips the selection away from a disabled Confirm in a
// useEffect. handleSubmit carries a defense-in-depth guard for submits that
// land in the window between paint and that effect. Testing-library flushes
// passive effects inside act(), so the window cannot be hit from userEvent
// alone — this file suppresses effect bodies to hold the component inside
// that window and exercise the guard.
const effectWindow = vi.hoisted(() => ({ open: false }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  const useEffect: typeof actual.useEffect = (effect, deps) =>
    actual.useEffect(() => (effectWindow.open ? undefined : effect()), deps);
  return { ...actual, useEffect };
});

afterEach(() => {
  cleanup();
  effectWindow.open = false;
});

describe("DecisionForm confirm-disabled submit guard", () => {
  it("never submits CONFIRMED while Confirm is disabled but still selected", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    effectWindow.open = true;

    const { rerender } = render(
      <DecisionForm mode="confirmation" onSubmit={onSubmit} requestedAmountMinor={500_000} />,
    );
    expect(screen.getByLabelText("Confirm")).toBeChecked();

    // The acting user is resolved after mount and turns out to be the
    // proposer: Confirm becomes disabled, but the corrective effect has not
    // run yet, so it is still the selected choice.
    rerender(
      <DecisionForm
        disableConfirm
        mode="confirmation"
        onSubmit={onSubmit}
        requestedAmountMinor={500_000}
      />,
    );
    const confirmRadio = screen.getByLabelText("Confirm");
    expect(confirmRadio).toBeDisabled();
    expect(confirmRadio).toBeChecked();

    await user.type(screen.getByLabelText("Reason"), "Trying to self-confirm");
    await user.click(screen.getByRole("button", { name: "Record decision" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);
  });
});
