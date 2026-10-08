export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string" && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(`/dashboard${path}`, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new HttpError(
      body.message ?? "Não foi possível concluir a operação.",
      response.status,
    );
  }
  return response.json();
}
export function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
