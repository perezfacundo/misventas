import { useLiveQuery } from "dexie-react-hooks";
import { balanceOf, uuidv7, type Cents, type PaymentMethod } from "@misventas/core";
import { db, type AccountMovement, type Customer } from "../db";
import { addCashMovement, getOpenSession } from "./cash";

const EMPTY_C: Customer[] = [];
const EMPTY_M: AccountMovement[] = [];

export function useCustomers(): Customer[] {
  return useLiveQuery(
    () => db.customers.filter((c) => c.active).toArray().then((cs) => cs.sort((a, b) => a.name.localeCompare(b.name, "es"))),
    [],
    EMPTY_C,
  );
}

/** Todos los movimientos de cuenta corriente: alcanzan para calcular saldos y deudores en memoria. */
export function useAccountMovements(): AccountMovement[] {
  return useLiveQuery(() => db.accountMovements.toArray(), [], EMPTY_M);
}

export async function customerBalance(customerId: string): Promise<Cents> {
  return balanceOf(await db.accountMovements.where("customerId").equals(customerId).toArray(), customerId);
}

export type CustomerInput = Pick<Customer, "name" | "phone" | "document" | "creditLimit" | "notes">;

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const now = Date.now();
  const customer: Customer = { ...input, name: input.name.trim(), id: uuidv7(), active: true, createdAt: now, updatedAt: now };
  await db.customers.add(customer);
  return customer;
}

export async function updateCustomer(id: string, patch: Partial<CustomerInput & { active: boolean }>): Promise<void> {
  await db.customers.update(id, { ...patch, updatedAt: Date.now() });
}

/** El cliente paga (todo o parte) de lo que debe. Si es en efectivo, entra a la caja abierta. */
export async function registerDebtPayment(input: {
  customer: Customer;
  amount: Cents;
  method: PaymentMethod;
  userName: string;
}): Promise<void> {
  await db.transaction("rw", [db.accountMovements, db.cashSessions, db.cashMovements, db.meta], async () => {
    if (input.method === "efectivo") {
      const session = await getOpenSession();
      if (!session) throw new Error("Para cobrar en efectivo, primero abrí la caja.");
      await addCashMovement(session.id, "ingreso", input.amount, `Pago de fiado: ${input.customer.name}`, input.userName);
    }
    await db.accountMovements.add({
      id: uuidv7(),
      customerId: input.customer.id,
      type: "pago",
      amount: -input.amount,
      method: input.method,
      createdAt: Date.now(),
      userName: input.userName,
    });
  });
}
