import { created, handleApiError, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { adminV2StructureSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, adminV2StructureSchema);

    if (input.action === "create_category") {
      const { data, error } = await supabase.from("categories").insert({
        name: input.name,
        slug: input.slug,
        parent_id: input.parentId ?? null,
        template_id: input.templateId ?? null,
        is_active: true
      }).select("id, name, slug, parent_id, template_id").single();
      if (error) throw error;
      return created(data);
    }

    if (input.action === "create_template") {
      const { data, error } = await supabase.from("attribute_templates").insert({
        name: input.name,
        code: input.code,
        description: input.description ?? null
      }).select("id, name, code, description").single();
      if (error) throw error;
      return created(data);
    }

    if (input.action === "create_attribute") {
      const { data, error } = await supabase.from("attribute_definitions").insert({
        name: input.name,
        code: input.code,
        data_type: input.dataType,
        scope: input.scope,
        unit: input.unit ?? null,
        is_required: input.isRequired,
        is_variant_axis: input.isVariantAxis,
        is_filterable: input.isFilterable
      }).select("id, name, code").single();
      if (error) throw error;

      if (input.options.length) {
        const options = input.options.map((option, index) => ({
          attribute_definition_id: data.id,
          value: option.value,
          label: option.label,
          sort_order: index
        }));
        const result = await supabase.from("attribute_options").insert(options);
        if (result.error) throw result.error;
      }

      return created(data);
    }

    if (input.action === "create_product_line") {
      const { data, error } = await supabase.from("product_lines").upsert({
        brand_id: input.brandId,
        name: input.name,
        slug: input.slug,
        is_active: true
      }, { onConflict: "brand_id,slug" }).select("id, brand_id, name, slug").single();
      if (error) throw error;
      const association = await supabase.from("product_line_product_families").upsert({
        product_line_id: data.id,
        template_id: input.templateId
      });
      if (association.error) throw association.error;
      return created(data);
    }

    if (input.action === "assign_brand_family") {
      const { data, error } = await supabase.from("brand_product_families").upsert({
        brand_id: input.brandId,
        template_id: input.templateId
      }).select("brand_id, template_id").single();
      if (error) throw error;
      return created(data);
    }

    if (input.action === "create_attribute_option") {
      const { data, error } = await supabase.from("attribute_options").upsert({
        attribute_definition_id: input.attributeDefinitionId,
        value: input.value,
        label: input.label,
        is_active: true
      }, { onConflict: "attribute_definition_id,value" }).select("id, attribute_definition_id, value, label").single();
      if (error) throw error;
      return created(data);
    }

    if (input.action === "create_color_shade") {
      const { data, error } = await supabase.rpc("create_color_shade", {
        p_brand_id: input.brandId,
        p_product_line_id: input.productLineId ?? null,
        p_name: input.name,
        p_code: input.code,
        p_color_family_option_id: input.colorFamilyOptionId,
        p_reference_color: input.referenceColor ?? null
      });
      if (error) throw error;
      const shade = await supabase.from("color_shades")
        .select("id, brand_id, product_line_id, name, code, tone_option_id, color_family_option_id, reference_color")
        .eq("id", data).single();
      if (shade.error) throw shade.error;
      return created(shade.data);
    }

    const { data, error } = await supabase.from("template_attributes").upsert({
      template_id: input.templateId,
      attribute_definition_id: input.attributeDefinitionId,
      is_required_override: input.isRequired,
      scope_override: input.scope,
      sort_order: input.sortOrder
    }).select("template_id, attribute_definition_id").single();
    if (error) throw error;
    return created(data);
  } catch (error) {
    return handleApiError(error);
  }
}
