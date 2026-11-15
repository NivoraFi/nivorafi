"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { decodeSorobanError } from "@/lib/math";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  componentName?: string;
  onCatch?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`ErrorBoundary caught error in [${this.props.componentName || "Component"}]:`, error, errorInfo);
    if (this.props.onCatch) {
      this.props.onCatch(error, errorInfo);
    }
  }

  public reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        if (typeof this.props.fallback === "function") {
          return this.props.fallback(this.state.error ?? new Error("Unknown error"), this.reset);
        }
        return this.props.fallback;
      }

      const decoded = this.state.error ? decodeSorobanError(this.state.error) : "A rendering exception occurred.";

      return (
        <div className="double-bezel rounded-2xl p-6 bg-surface-muted/60 border border-hairline text-center my-4 max-w-lg mx-auto shadow-card">
          <div className="flex items-center justify-center gap-2 text-danger mb-2">
            <AlertCircle className="h-5 w-5" />
            <h3 className="text-sm font-semibold text-ink">
              {this.props.componentName ? `${this.props.componentName} Failed` : "Component Error"}
            </h3>
          </div>
          <p className="text-xs text-ink-muted mb-4 font-mono break-words">{decoded}</p>
          <button
            type="button"
            onClick={this.reset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-elevated transition cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Try Again</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
