"use client";

import { useRef, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { publicAssetUrl, uploadCatalogImage } from "@/lib/admin/api";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 10 * 1024 * 1024;

type ImageSlotProps = {
  label: string;
  path: string | null;
  kind: "product-image" | "color-chart";
  onChange: (path: string | null) => void;
};

export function ImageSlot({ label, path, kind, onChange }: ImageSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const showToast = useToast();
  const handleApiError = useApiError();

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || uploading) {
      return;
    }

    if (!ACCEPTED_TYPES.includes(file.type)) {
      showToast("Usa una imagen PNG, JPG, WEBP o GIF.");
      return;
    }

    if (file.size > MAX_BYTES) {
      showToast("La imagen supera el límite de 10 MB.");
      return;
    }

    setUploading(true);

    try {
      const uploadedPath = await uploadCatalogImage(kind, file);
      onChange(uploadedPath);
    } catch (error) {
      handleApiError(error, "No se pudo subir la imagen.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="img-slot">
      {path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={publicAssetUrl(path)} alt={label} />
      ) : null}
      <button
        type="button"
        className={path ? "img-slot-btn img-slot-btn--filled" : "img-slot-btn"}
        onClick={() => inputRef.current?.click()}
        title={path ? "Cambiar imagen" : "Subir imagen"}
      >
        {path ? "" : label}
      </button>
      {path && !uploading ? (
        <button
          type="button"
          className="img-slot-remove"
          onClick={() => onChange(null)}
          title="Quitar imagen"
        >
          ✕
        </button>
      ) : null}
      {uploading ? (
        <div className="img-slot-loading">
          <span className="spinner spinner--pink" />
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        style={{ display: "none" }}
        onChange={handleFile}
      />
    </div>
  );
}
