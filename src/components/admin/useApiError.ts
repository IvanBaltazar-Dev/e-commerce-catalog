"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { AdminApiError } from "@/lib/admin/api";
import { useToast } from "@/components/admin/ToastProvider";

export function useApiError() {
  const router = useRouter();
  const showToast = useToast();

  return useCallback(
    (error: unknown, fallback = "Ocurrió un error inesperado.") => {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        router.replace("/admin/login");
        return;
      }

      showToast(error instanceof Error && error.message ? error.message : fallback);
    },
    [router, showToast]
  );
}
