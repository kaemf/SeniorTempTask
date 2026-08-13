import type { SessionUser } from "./domain.js";

/**
 * TRUST BOUNDARY: this development-only session mechanism trusts the
 * x-user-id / x-user-role headers sent by the local frontend. It performs no
 * authentication and must be replaced by a real identity provider before any
 * non-local deployment. It fails closed: a missing/empty user id or a role
 * other than exactly "UNDERWRITER" or "SUPPORT" yields no session, so
 * downstream procedures return UNAUTHORIZED instead of assuming an identity.
 */
export function parseDevSession(
  headers: Record<string, string | string[] | undefined>,
): { user: SessionUser } | null {
  const rawId = headers["x-user-id"];
  const rawRole = headers["x-user-role"];
  const id = typeof rawId === "string" ? rawId.trim() : "";
  const role = typeof rawRole === "string" ? rawRole : "";
  if (!id) {
    return null;
  }
  if (role !== "UNDERWRITER" && role !== "SUPPORT") {
    return null;
  }
  return { user: { id, name: "Development User", role } };
}
