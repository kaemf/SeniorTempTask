export interface DevUser {
  id: string;
  name: string;
  role: "UNDERWRITER" | "SUPPORT";
}

export const DEV_USER_ID_STORAGE_KEY = "dev-user-id";
export const DEV_USER_ROLE_STORAGE_KEY = "dev-user-role";

export const DEV_USERS = [
  { id: "user-underwriter-1", name: "Ada Underwriter", role: "UNDERWRITER" },
  { id: "user-underwriter-2", name: "Grace Underwriter", role: "UNDERWRITER" },
  { id: "user-support-1", name: "Sam Support", role: "SUPPORT" },
] as const satisfies readonly DevUser[];

export const DEFAULT_DEV_USER: DevUser = DEV_USERS[0];

export function userDisplayName(userId: string): string {
  const known = DEV_USERS.find((user) => user.id === userId);
  return known ? known.name : userId;
}

/**
 * Reads the acting dev user from localStorage. Safe to call during SSR:
 * without a window it falls back to the default seeded underwriter.
 */
export function getDevUser(): DevUser {
  if (typeof window === "undefined") {
    return DEFAULT_DEV_USER;
  }

  const storedId = window.localStorage.getItem(DEV_USER_ID_STORAGE_KEY);
  if (!storedId) {
    return DEFAULT_DEV_USER;
  }

  const known = DEV_USERS.find((user) => user.id === storedId);
  if (known) {
    return known;
  }

  const storedRole = window.localStorage.getItem(DEV_USER_ROLE_STORAGE_KEY);
  return {
    id: storedId,
    name: storedId,
    role: storedRole === "SUPPORT" ? "SUPPORT" : "UNDERWRITER",
  };
}

export function setDevUser(userId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const user = DEV_USERS.find((candidate) => candidate.id === userId) ?? DEFAULT_DEV_USER;
  window.localStorage.setItem(DEV_USER_ID_STORAGE_KEY, user.id);
  window.localStorage.setItem(DEV_USER_ROLE_STORAGE_KEY, user.role);
}
