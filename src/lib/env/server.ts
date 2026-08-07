import "server-only";

import { z } from "zod";
import { publicEnv } from "@/lib/env/public";

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  CATALOG_DEFAULT_WHATSAPP: z.string().min(8).default("+51963463550"),
  ENABLE_CATALOG_IMPORTS: z.enum(["true", "false"]).default("false"),
  // --- Integraciones omnicanal (Bloque 3). SECRETOS: jamás con prefijo público
  // ni en columnas de la base; solo viven aquí. Sin credenciales, los
  // adaptadores degradan a modo local: registran y encolan sin llamar fuera.
  WHATSAPP_VERIFY_TOKEN: z.string().min(8).optional(),
  WHATSAPP_APP_SECRET: z.string().min(8).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(8).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(3).optional(),
  META_VERIFY_TOKEN: z.string().min(8).optional(),
  META_APP_SECRET: z.string().min(8).optional(),
  META_PAGE_ACCESS_TOKEN: z.string().min(8).optional(),
  TIKTOK_WEBHOOK_SECRET: z.string().min(8).optional()
});

export const serverEnv = {
  ...publicEnv,
  ...serverEnvSchema.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    CATALOG_DEFAULT_WHATSAPP: process.env.CATALOG_DEFAULT_WHATSAPP,
    ENABLE_CATALOG_IMPORTS: process.env.ENABLE_CATALOG_IMPORTS,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
    META_APP_SECRET: process.env.META_APP_SECRET,
    META_PAGE_ACCESS_TOKEN: process.env.META_PAGE_ACCESS_TOKEN,
    TIKTOK_WEBHOOK_SECRET: process.env.TIKTOK_WEBHOOK_SECRET
  })
};
