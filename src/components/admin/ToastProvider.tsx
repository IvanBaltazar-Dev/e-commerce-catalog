"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

const ToastContext = createContext<(message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((next: string) => {
    clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => setMessage(""), 2600);
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {message ? <div className="toast">{message}</div> : null}
    </ToastContext.Provider>
  );
}
