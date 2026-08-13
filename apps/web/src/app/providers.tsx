"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState, type ReactNode } from "react";
import superjson from "superjson";

import { UserSwitcher } from "@/components/UserSwitcher";
import { getDevUser } from "@/lib/devUser";
import { trpc } from "@/lib/trpc";

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          transformer: superjson,
          url: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/trpc",
          headers() {
            // Resolved per request so a user switch takes effect immediately.
            const user = getDevUser();
            return {
              "x-user-id": user.id,
              "x-user-role": user.role,
            };
          },
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <UserSwitcher />
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
