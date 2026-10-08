export const number = (value: number) =>
  new Intl.NumberFormat("pt-BR").format(value);
export const dateTime = (value: string, precise = false) =>
  new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: precise ? 3 : undefined,
  });
export const duration = (ms: number) => {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60)
    return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`;
};
export const milliseconds = (value: number | null) =>
  value === null
    ? "—"
    : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)} ms`;
export const percent = (value: number | null) =>
  value === null
    ? "—"
    : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`;
export const time = (value: string) =>
  new Date(value).toLocaleTimeString("pt-BR");
export const date = (value: string) =>
  new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export const shortId = (value: string) =>
  value.startsWith("local-")
    ? `local-${value.slice(6, 14)}`
    : value.length > 20
      ? `${value.slice(0, 18)}…`
      : value;
export const money = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(value);
