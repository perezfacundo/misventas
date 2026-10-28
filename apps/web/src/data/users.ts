import { useLiveQuery } from "dexie-react-hooks";
import { uuidv7, type Role } from "@misventas/core";
import { db, type User } from "../db";
import { hashPin } from "../lib/pin";

const EMPTY: User[] = [];

export function useUsers(): User[] {
  return useLiveQuery(() => db.users.toArray().then((us) => us.sort((a, b) => a.name.localeCompare(b.name, "es"))), [], EMPTY);
}

export async function createUser(input: { name: string; role: Role; pin: string | null }): Promise<User> {
  const now = Date.now();
  const user: User = {
    id: uuidv7(),
    name: input.name.trim(),
    role: input.role,
    pinHash: input.pin ? await hashPin(input.pin) : null,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await db.users.add(user);
  return user;
}

export async function updateUser(id: string, patch: { name?: string; role?: Role; active?: boolean; pin?: string | null }): Promise<void> {
  const { pin, ...rest } = patch;
  const changes: Partial<User> = { ...rest, updatedAt: Date.now() };
  if (pin !== undefined) changes.pinHash = pin ? await hashPin(pin) : null;
  await db.users.update(id, changes);
}
