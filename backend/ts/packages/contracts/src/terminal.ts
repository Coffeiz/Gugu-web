/** 交互式 PTY 与咕咕结构化终端共用的协议契约。 */

export type TerminalMode = "interactive-pty" | "agent-events";
export type TerminalSource = "user" | "agent";

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "signal"; signal: "SIGINT" | "SIGTERM" | "SIGTSTP" }
  | { type: "detach" };

export type TerminalServerMessage =
  | { type: "ready"; terminalId: string; cols: number; rows: number }
  | { type: "output"; data: string }
  | { type: "status"; status: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; code: string; message?: string };

export type InteractiveTerminalRef = {
  terminal_id: string;
  owner_id: string;
  source: "user";
  mode: "interactive-pty";
  pty_pid?: number;
  pty_sandbox_id?: string;
  pty_cols?: number;
  pty_rows?: number;
};

export type AgentTerminalRef = {
  terminal_id: string;
  owner_id: string;
  source: "agent";
  mode: "agent-events";
};

export type TerminalRef = InteractiveTerminalRef | AgentTerminalRef;
