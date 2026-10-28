/** Avisa en tiempo real a los otros dispositivos del comercio que hay cambios para bajar. */
type Listener = { deviceId: string; send: (seq: number) => void };

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

  publish(tenantId: string, fromDeviceId: string, seq: number): void {
    for (const l of this.listeners.get(tenantId) ?? []) {
      if (l.deviceId !== fromDeviceId) l.send(seq);
    }
  }
}
