"use client";

import React from "react";
import { Terminal } from "lucide-react";

interface FloatingDevTriggerProps {
  onClick: () => void;
  logsCount: number;
}

export function FloatingDevTrigger({ onClick, logsCount }: FloatingDevTriggerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group fixed bottom-5 right-5 z-30 inline-flex items-center gap-2 rounded-full border border-console-hairline bg-console/85 px-3.5 py-2 text-xs text-console-text backdrop-blur-xl shadow-glass hover:shadow-glass-hover hover:border-console-accent hover:text-console-accent active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-console-accent disabled:opacity-50 transition-colors"
      title="Open Developer Telemetry Drawer (Esc to close)"
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-console-accent opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-console-accent" />
      </span>
      <Terminal className="h-3.5 w-3.5 text-console-accent" />
      <span>Telemetry</span>
      {logsCount > 0 && (
        <span className="tabular-mono rounded-md bg-console-surface border border-console-hairline px-1.5 py-0.5 text-xs text-console-accent font-bold">
          {logsCount}
        </span>
      )}
    </button>
  );
}
