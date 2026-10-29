import { useEffect, useState } from "react";
import { MapPin, Plus } from "lucide-react";
import { DEFAULT_BRANCH_ID } from "@misventas/core";
import { currentBranchId, type Branch } from "../db";
import { createBranch, renameBranch, setDeviceBranch, useBranches } from "../data/branches";
import { Button, Card, Field, inputClass, Modal, TextInput, useToast } from "./ui";

/** Sucursales del comercio y en cuál está esta caja (solo el dueño). */
export function BranchSettings() {
  const branches = useBranches();
  const [editing, setEditing] = useState<Branch | "nueva" | null>(null);
  const [current, setCurrent] = useState(currentBranchId());
  const toast = useToast();
  const list = branches.length ? branches : [{ id: DEFAULT_BRANCH_ID, name: "Principal", address: "", active: true, createdAt: 0, updatedAt: 0 }];

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-bold"><MapPin className="size-6 text-brand" /> Sucursales</h2>
        <Button onClick={() => setEditing("nueva")}><Plus className="size-5" /> Nueva sucursal</Button>
      </div>
      <p className="mb-4 text-muted">
        Con más de un local, cada uno tiene su propio stock y sus cajas. Los productos y precios son los mismos, y la mercadería se puede enviar de uno a otro.
      </p>
      <ul className="mb-4 divide-y divide-line">
        {list.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
            <span><b>{b.name}</b>{b.address && <span className="text-muted"> · {b.address}</span>}{b.id === current && <span className="text-muted"> · esta caja</span>}</span>
            {branches.length > 0 && <Button variant="ghost" onClick={() => setEditing(b)}>Editar</Button>}
          </li>
        ))}
      </ul>
      {list.length > 1 && (
        <Field label="Esta caja está en" hint="Cambia el stock que ve esta caja y dónde se registran sus ventas.">
          <select className={inputClass} value={current} onChange={async (e) => {
            await setDeviceBranch(e.target.value);
            setCurrent(e.target.value);
            toast({ tone: "ok", message: `Esta caja ahora es de ${list.find((b) => b.id === e.target.value)?.name}` });
          }}>
            {list.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
      )}
      <BranchDialog branch={editing === "nueva" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </Card>
  );
}

function BranchDialog({ branch, open, onClose }: { branch: Branch | null; open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (open) { setName(branch?.name ?? ""); setAddress(branch?.address ?? ""); }
  }, [open, branch]);
  const save = async () => {
    if (!name.trim()) return;
    if (branch) await renameBranch(branch.id, name, address);
    else await createBranch(name, address);
    toast({ tone: "ok", message: `Guardaste la sucursal ${name.trim()}` });
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={branch ? "Editar sucursal" : "Nueva sucursal"} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} disabled={!name.trim()}>Guardar</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Nombre"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Sucursal Centro" /></Field>
        <Field label="Dirección (opcional)"><TextInput value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
