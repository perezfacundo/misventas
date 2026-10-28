/** Avisa en tiempo real a los dispositivos de un comercio: hay cambios para bajar, o se confirmó un pago. */
type Listener = { deviceId: string; send: (event: string, data: unknown) => void };

export class SyncHub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(tenantId: string, listener: Listener): () => void {
    const set = this.listeners.get(tenantId) ?? new Set();
    set.add(listener);
    this.listeners.set(tenantId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(tenantId);
    };
  }

  /** "Hay cambios": a todos menos al que los subió. */
  publish(tenantId: string, fromDeviceId: string, seq: number): void {
    this.emit(tenantId, "changed", { seq }, fromDeviceId);
  }

  emit(tenantId: string, event: string, data: unknown, exceptDeviceId?: string): void {
    for (const l of this.listeners.get(tenantId) ?? []) {
      if (l.deviceId !== exceptDeviceId) l.send(event, data);
    }
  }
}
