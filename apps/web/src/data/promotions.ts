import { useLiveQuery } from "dexie-react-hooks";
import { uuidv7, type Promotion } from "@misventas/core";
import { db, type PromotionRecord } from "../db";

const EMPTY: PromotionRecord[] = [];

export function usePromotions(): PromotionRecord[] {
  return useLiveQuery(
    () => db.promotions.filter((p) => !p.deleted).toArray().then((ps) => ps.sort((a, b) => a.name.localeCompare(b.name, "es"))),
    [],
    EMPTY,
  );
}

export type PromotionInput = Omit<Promotion, "id">;

export async function savePromotion(id: string | null, input: PromotionInput): Promise<void> {
  const now = Date.now();
  if (id) await db.promotions.update(id, { ...input, updatedAt: now });
  else await db.promotions.add({ ...input, id: uuidv7(), createdAt: now, updatedAt: now });
}

export async function setPromotionActive(id: string, active: boolean): Promise<void> {
  await db.promotions.update(id, { active, updatedAt: Date.now() });
}

export async function deletePromotion(id: string): Promise<void> {
  await db.promotions.update(id, { deleted: true, active: false, updatedAt: Date.now() });
}
