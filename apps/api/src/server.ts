import cors from "@fastify/cors";
import { prisma } from "@loan-review/db";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";

import type { RequestContext } from "./domain.js";
import type { LoanNotifier } from "./notifier.js";
import { PrismaLoanRepository } from "./repository.js";
import { appRouter } from "./router.js";
import { parseDevSession } from "./session.js";

const server = Fastify({ logger: true, routerOptions: { maxParamLength: 5_000 } });
const repository = new PrismaLoanRepository(prisma);

await server.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  credentials: true,
});

server.get("/health", async () => ({ status: "ok" }));

/**
 * Logging notifier: records that a business notification is due. The external
 * transport is out of scope; this keeps delivery callable and testable.
 */
const notifier: LoanNotifier = {
  async send(notification) {
    server.log.info(
      { applicationId: notification.applicationId, type: notification.type },
      "Loan notification dispatched",
    );
  },
};

await server.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: {
    router: appRouter,
    createContext({ req }: CreateFastifyContextOptions): RequestContext {
      return {
        repository,
        session: parseDevSession(req.headers),
        logger: {
          info(context, message) {
            server.log.info(context, message);
          },
          warn(context, message) {
            server.log.warn(context, message);
          },
          error(context, message) {
            server.log.error(context, message);
          },
        },
        notifier,
      };
    },
  },
});

try {
  await server.listen({ port: 4000, host: "0.0.0.0" });
} catch (error: unknown) {
  server.log.error(error);
  process.exit(1);
}
