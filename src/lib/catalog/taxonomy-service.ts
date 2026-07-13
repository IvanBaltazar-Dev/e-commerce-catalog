import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/http";
import { slugify } from "@/lib/catalog/slug";
import type { taxonomyCreateSchema, taxonomyUpdateSchema } from "@/lib/catalog/validation";
import type { z } from "zod";

type Supabase = SupabaseClient;
type TaxonomyTable = "brands" | "categories";
type TaxonomyCreateInput = z.infer<typeof taxonomyCreateSchema>;
type TaxonomyUpdateInput = z.infer<typeof taxonomyUpdateSchema>;

const TAXONOMY_SELECT = "id, name, slug, description, is_active, sort_order, created_at, updated_at";

function cleanNullableText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

export async function createTaxonomy(
  supabase: Supabase,
  table: TaxonomyTable,
  input: TaxonomyCreateInput
) {
  const { data, error } = await supabase
    .from(table)
    .insert({
      name: input.name,
      slug: input.slug ?? slugify(input.name),
      description: cleanNullableText(input.description),
      is_active: input.isActive,
      sort_order: input.sortOrder
    })
    .select(TAXONOMY_SELECT)
    .single();

  if (error) {
    throw new HttpError(400, `${table}_create_failed`, error.message);
  }

  return data;
}

export async function updateTaxonomy(
  supabase: Supabase,
  table: TaxonomyTable,
  id: string,
  input: TaxonomyUpdateInput
) {
  const { data, error } = await supabase
    .from(table)
    .update(
      compact({
        name: input.name,
        slug: input.slug,
        description: cleanNullableText(input.description),
        is_active: input.isActive,
        sort_order: input.sortOrder
      })
    )
    .eq("id", id)
    .select(TAXONOMY_SELECT)
    .single();

  if (error) {
    throw new HttpError(400, `${table}_update_failed`, error.message);
  }

  return data;
}

export async function hideTaxonomy(supabase: Supabase, table: TaxonomyTable, id: string) {
  const { data, error } = await supabase
    .from(table)
    .update({ is_active: false })
    .eq("id", id)
    .select(TAXONOMY_SELECT)
    .single();

  if (error) {
    throw new HttpError(400, `${table}_hide_failed`, error.message);
  }

  return data;
}
