import { useLiveQuery } from "dexie-react-hooks";
import { expectedCash, uuidv7, type Cents, type CashMovementType } from "@misventas/core";
import { db, getDeviceId, type CashSession, type User } from "../db";

/** La caja abierta de ESTE dispositivo (cada caja física tiene la suya). null si no hay; undefined mientras carga. */
export function useOpenSession(): CashSession | null | undefined {
  return useLiveQuery(async () => (await getOpenSession()) ?? null, []);
}

export async function getOpenSession(): Promise<CashSession | undefined> {
  const deviceId = await getDeviceId();
  return db.cashSessions.where("status").equals("abierta").filter((s) => s.deviceId === deviceId).first();
}

export async function openSession(user: Pick<User, "id" | "name">, openingAmount: Cents): Promise<CashSession> {
  const existing = await getOpenSession();
  if (existing) return existing;
  const session: CashSession = {
    id: uuidv7(),
    deviceId: await getDeviceId(),
    status: "abierta",
    openedAt: Date.now(),
    openedById: user.id,
    openedBy: user.name,
    openingAmount,
  };
  await db.cashSessions.add(session);
  return session;
}

export async function addCashMovement(cashSessionId: string, type: CashMovementType, amount: Cents, reason: string, userName?: string): Promise<void> {
  await db.cashMovements.add({ id: uuidv7(), cashSessionId, type, amount, reason, createdAt: Date.now(), userName });
}

export async function sessionExpectedCash(session: CashSession): Promise<Cents> {
  const [sales, movements] = await Promise.all([
    db.sales.where("cashSessionId").equals(session.id).toArray(),
    db.cashMovements.where("cashSessionId").equals(session.id).toArray(),
  ]);
  return expectedCash(session.openingAmount, sales, movements);
}

export async function closeSession(session: CashSession, countedAmount: Cents, closedBy: string, note?: string): Promise<void> {
  const expectedAmount = await sessionExpectedCash(session);
  await db.cashSessions.update(session.id, { status: "cerrada", closedAt: Date.now(), closedBy, expectedAmount, countedAmount, note });
}
