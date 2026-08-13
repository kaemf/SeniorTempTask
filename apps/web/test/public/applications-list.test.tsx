import "@testing-library/jest-dom/vitest";
import type { LoanApplicationView } from "@loan-review/api/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationsList } from "../../src/components/ApplicationsList";

const { useQueryMock } = vi.hoisted(() => ({ useQueryMock: vi.fn() }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    loanApplications: {
      list: { useQuery: useQueryMock },
    },
  },
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(cleanup);

interface ListQueryState {
  data: LoanApplicationView[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

function setQueryState(state: Partial<ListQueryState>) {
  useQueryMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    ...state,
  });
}

function makeApplication(id: string): LoanApplicationView {
  return {
    id,
    status: "PENDING_REVIEW",
    requestedAmountMinor: 100_000,
    approvedAmountMinor: null,
    proposedById: null,
    customer: {
      fullName: `Customer ${id}`,
      lastName: "Tester",
      gender: "female",
      taxId: `TAX-${id}`,
      email: `${id}@example.com`,
    },
  };
}

// pageSize is 2, so four applications span two pages.
const fourApplications = ["app-1", "app-2", "app-3", "app-4"].map(makeApplication);

describe("ApplicationsList row selection", () => {
  it("keys selection by application id so it does not leak across pages", async () => {
    const user = userEvent.setup();
    setQueryState({ data: fourApplications });
    render(<ApplicationsList />);

    await user.click(screen.getByLabelText("Select application app-1"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Select application app-3")).not.toBeChecked();
    expect(screen.getByLabelText("Select application app-4")).not.toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByLabelText("Select application app-1")).toBeChecked();
    expect(screen.getByLabelText("Select application app-2")).not.toBeChecked();
  });

  it("select-all on one page does not select rows on other pages", async () => {
    const user = userEvent.setup();
    setQueryState({ data: fourApplications });
    render(<ApplicationsList />);

    await user.click(screen.getByLabelText("Select all applications on this page"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Select application app-3")).not.toBeChecked();
    expect(screen.getByLabelText("Select application app-4")).not.toBeChecked();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });
});

describe("ApplicationsList pagination clamping", () => {
  it("clamps the current page when the data shrinks", async () => {
    const user = userEvent.setup();
    setQueryState({ data: fourApplications });
    const { rerender } = render(<ApplicationsList />);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

    setQueryState({ data: [makeApplication("app-1")] });
    rerender(<ApplicationsList />);

    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Select application app-1")).toBeInTheDocument();
  });

  it("shows an empty state and Page 1 of 1 for an empty list", () => {
    setQueryState({ data: [] });
    render(<ApplicationsList />);

    expect(screen.getByText("No applications")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });
});

describe("ApplicationsList refetch errors", () => {
  it("keeps the table and shows an inline notice when a background refetch fails", () => {
    setQueryState({
      data: fourApplications.slice(0, 2),
      isError: true,
      error: { message: "network down" },
    });
    render(<ApplicationsList />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByLabelText("Select application app-1")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /live updates are temporarily unavailable/i,
    );
    expect(screen.queryByText(/Could not load applications/)).not.toBeInTheDocument();
  });

  it("shows the full-page error only when no data has ever loaded", () => {
    setQueryState({ data: undefined, isError: true, error: { message: "boom" } });
    render(<ApplicationsList />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load applications: boom");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
