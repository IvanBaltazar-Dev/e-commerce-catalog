import "server-only";

import { z } from "zod";
import { publicEnv } from "@/lib/env/public";

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  CATALOG_DEFAULT_WHATSAPP: z.string().min(8).default("+51963463550")
});

export const serverEnv = {
  ...publicEnv,
  ...serverEnvSchema.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    CATALOG_DEFAULT_WHATSAPP: process.env.CATALOG_DEFAULT_WHATSAPP
  })
};
