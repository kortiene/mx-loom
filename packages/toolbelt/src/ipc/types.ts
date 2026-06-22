/** JSON-RPC 2.0 envelope types for the mx-agent daemon IPC. */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | null;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Result shape of `daemon.status` (verified against v0.2.1). */
export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptime_seconds: number;
  socket_path: string;
  version: string;
  sync?: {
    state: string;
    total_syncs: number;
    consecutive_failures: number;
    [key: string]: unknown;
  };
}
