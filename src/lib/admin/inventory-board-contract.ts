export type InventoryBoardItem = {
  variantId: string;
  branchId: string;
  branchName: string;
  sku: string | null;
  variantName: string;
  productId: string;
  productName: string;
  presentation: string | null;
  brandName: string;
  shadeName: string | null;
  shadeCode: string | null;
  referenceColor: string | null;
  onHand: number;
  reserved: number;
  available: number;
  unvaluedQuantity: number;
  averageUnitCost: number | null;
  totalValue: number | null;
  unitsInPeriod: number;
  coverageDays: number | null;
  needsReposition: boolean;
  reason: "agotado" | "cobertura" | null;
};

export type InventoryBoardRange = {
  desde: string;
  hasta: string;
  dias: number;
};

export type InventoryBoardData = {
  items: InventoryBoardItem[];
  total: number;
  rango: InventoryBoardRange | null;
};

export type InventoryBoardFilters = {
  branchId?: string | null;
  query?: string | null;
  from?: string | null;
  to?: string | null;
  onlyReposition?: boolean;
  limit?: number;
};
