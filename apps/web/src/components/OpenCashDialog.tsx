import { useEffect, useState } from "react";
import { openSession } from "../data/cash";
import { Button, Field, MoneyInput, Modal } from "./ui";
import { useSession } from "./Session";

export function OpenCashDialog({ open, onClose, onOpened }: { open: boolean; onClose: () => void; onOpened?: () => void }) {
  const { user } = useSession();
  const [amount, setAmount] = useState<number | null>(0);

  useEffect(() => {
    if (open) setAmount(0);
  }, [open]);

  const submit = async () => {
    await openSession(user, amount ?? 0);
    onClose();
    onOpened?.();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Abrir la caja"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit}>Abrir caja</Button>
        </>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="text-muted">
          Para vender, primero abrí la caja, <b className="text-ink">{user.name}</b>. Así al final del turno sabés cuánta plata tiene que haber.
        </p>
        <Field label="¿Con cuánto efectivo empieza la caja?" hint="El cambio que hay en el cajón ahora.">
          <MoneyInput value={amount} onChange={setAmount} placeholder="0" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
