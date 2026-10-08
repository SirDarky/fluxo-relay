import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "../../../src/shared/contracts/dashboard";
import { api, HttpError } from "@/lib/api";

export function useDashboard(
  runId: string | null,
  page: number,
  session: number,
) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "offline"
  >("connecting");
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let attempt = 0;
    let lastMessage = Date.now();
    const query = new URLSearchParams({ page: String(page) });
    if (runId) query.set("run_id", runId);
    const update = (data: DashboardSnapshot) => {
      if (!stopped) {
        setSnapshot(data);
        setError(null);
        setAuthRequired(false);
      }
    };
    async function connect() {
      if (stopped) return;
      setConnection("connecting");
      try {
        update(await api<DashboardSnapshot>(`/snapshot?${query}`));
      } catch (failure) {
        if (stopped) return;
        setConnection("offline");
        setError(
          failure instanceof Error ? failure.message : "Falha de conexão.",
        );
        if (failure instanceof HttpError && failure.status === 401) {
          setAuthRequired(true);
          return;
        }
        retry = setTimeout(
          () => {
            void connect();
          },
          Math.min(1000 * 2 ** attempt++, 15000),
        );
        return;
      }
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/dashboard/ws?${query}`,
      );
      socket.onopen = () => {
        if (!stopped) {
          setConnection("live");
          attempt = 0;
          lastMessage = Date.now();
        }
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot") {
            lastMessage = Date.now();
            update(message.data);
          }
        } catch {
          setError("A atualização recebida não pôde ser lida.");
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnection("offline");
        retry = setTimeout(
          () => {
            void connect();
          },
          Math.min(1000 * 2 ** attempt++, 15000),
        );
      };
      socket.onerror = () => socket?.close();
    }
    void connect();
    watchdog = setInterval(() => {
      if (
        socket?.readyState === WebSocket.OPEN &&
        Date.now() - lastMessage > 12000
      )
        socket.close();
    }, 3000);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      socket?.close();
    };
  }, [runId, page, session]);
  return { snapshot, connection, error, authRequired };
}
