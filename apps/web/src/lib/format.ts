const time = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const date = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
const weekday = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long" });

export const formatTime = (ms: number | Date) => time.format(ms);
export const formatDate = (ms: number | Date) => date.format(ms);
export const formatDateTime = (ms: number | Date) => `${date.format(ms)} ${time.format(ms)}`;
export const formatLongDay = (ms: number | Date) => {
  const s = weekday.format(ms);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Para precargar un campo de dinero: 150000 → "1500", 150050 → "1500,50". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(".", ",");
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
