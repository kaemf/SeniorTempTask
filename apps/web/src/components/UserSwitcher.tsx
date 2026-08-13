"use client";

import { useEffect, useState, type ChangeEvent } from "react";

import { DEFAULT_DEV_USER, DEV_USERS, getDevUser, setDevUser } from "@/lib/devUser";

/**
 * Development-only session switcher. Persists the chosen seeded user to
 * localStorage (read by the tRPC client's request headers) and reloads the
 * page so every query re-runs as the newly selected user.
 */
export function UserSwitcher() {
  const [userId, setUserId] = useState(DEFAULT_DEV_USER.id);

  // Read localStorage after mount to avoid SSR/hydration mismatches.
  useEffect(() => {
    setUserId(getDevUser().id);
  }, []);

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextUserId = event.target.value;
    setDevUser(nextUserId);
    setUserId(nextUserId);
    window.location.reload();
  }

  return (
    <div className="user-switcher">
      <label>
        Acting as
        <select aria-label="Acting as user" onChange={handleChange} value={userId}>
          {DEV_USERS.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.role})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
