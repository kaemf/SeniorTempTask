"use client";

import type { LoanApplicationView } from "@loan-review/api/types";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type RowSelectionState,
} from "@tanstack/react-table";
import Link from "next/link";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";

const columnHelper = createColumnHelper<LoanApplicationView>();

/** Presentation-only alignment/typography per column (keyed by column id). */
const columnClassNames: Record<string, string> = {
  requestedAmountMinor: "col-num",
  customer_taxId: "col-mono",
};

function formatMoney(minor: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(minor / 100);
}

const columns = [
  columnHelper.display({
    id: "select",
    header: ({ table }) => (
      <input
        aria-label="Select all applications on this page"
        checked={table.getIsAllRowsSelected()}
        onChange={table.getToggleAllRowsSelectedHandler()}
        type="checkbox"
      />
    ),
    cell: ({ row }) => (
      <input
        aria-label={`Select application ${row.original.id}`}
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
        type="checkbox"
      />
    ),
  }),
  columnHelper.accessor("id", {
    header: "Application",
    cell: ({ getValue }) => <Link href={`/applications/${getValue()}`}>{getValue()}</Link>,
  }),
  columnHelper.accessor("customer.fullName", {
    header: "Customer",
  }),
  columnHelper.accessor("customer.gender", {
    header: "Gender",
  }),
  columnHelper.accessor("customer.taxId", {
    header: "Tax ID",
  }),
  columnHelper.accessor("requestedAmountMinor", {
    header: "Requested",
    cell: ({ getValue }) => formatMoney(getValue()),
  }),
  columnHelper.accessor("status", {
    header: "Status",
    cell: ({ getValue }) => (
      <span className={`status status-${getValue().toLowerCase()}`}>{getValue()}</span>
    ),
  }),
];

export function ApplicationsList() {
  const applicationsQuery = trpc.loanApplications.list.useQuery(undefined, {
    refetchInterval: 5_000,
  });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 2;
  const applications = applicationsQuery.data ?? [];
  // At least one page, so an empty list renders "Page 1 of 1" rather than "of 0".
  const pageCount = Math.max(1, Math.ceil(applications.length / pageSize));
  // Derive a clamped index instead of resetting state in an effect: when the
  // data shrinks (refetch, deletion) the stored index may point past the last
  // page, and deriving avoids the extra render an effect reset would cause.
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageApplications = useMemo(
    () => applications.slice(safePageIndex * pageSize, (safePageIndex + 1) * pageSize),
    [applications, safePageIndex],
  );

  const table = useReactTable({
    data: pageApplications,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Key selection by application id, not array index, so selection cannot
    // migrate to a different application across pages or refetches.
    getRowId: (row) => row.id,
    manualPagination: true,
    pageCount,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
  });

  if (applicationsQuery.isLoading) {
    return <main className="shell applications-shell">Loading applications…</main>;
  }

  // Only blank the page when we have nothing to show. A failed background
  // refetch (polling every 5s) must not unmount a table that has data.
  if (applicationsQuery.isError && applicationsQuery.data === undefined) {
    return (
      <main className="shell applications-shell" role="alert">
        Could not load applications: {applicationsQuery.error.message}
      </main>
    );
  }

  return (
    <main className="shell applications-shell">
      <div className="eyebrow">Underwriting workspace</div>
      <div className="title-row">
        <div>
          <h1>Applications</h1>
          <p className="lede">Review and select submitted loan applications.</p>
        </div>
        <span className="selection-count">{Object.keys(rowSelection).length} selected</span>
      </div>

      {applicationsQuery.isError ? (
        <p className="refresh-notice" role="alert">
          Live updates are temporarily unavailable.
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th className={columnClassNames[header.column.id]} key={header.id} scope="col">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={columns.length}>
                  No applications
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr data-selected={row.getIsSelected() || undefined} key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td className={columnClassNames[cell.column.id]} key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <button
          disabled={safePageIndex === 0}
          onClick={() => setPageIndex(safePageIndex - 1)}
          type="button"
        >
          Previous
        </button>
        <span>
          Page {safePageIndex + 1} of {pageCount}
        </span>
        <button
          disabled={safePageIndex + 1 >= pageCount}
          onClick={() => setPageIndex(safePageIndex + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </main>
  );
}
