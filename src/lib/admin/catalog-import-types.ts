export type CatalogImportIssueSeverity = "warning" | "error";

export type CatalogImportIssue = {
  severity: CatalogImportIssueSeverity;
  code: string;
  message: string;
  sheet?: string;
  row?: number;
  field?: string;
};

export type CatalogImportSecurityReport = {
  fileSha256: string;
  fileBytes: number;
  archiveEntries: number;
  totalUncompressedBytes: number;
  macrosDetected: false;
  externalLinksDetected: false;
  embeddedObjectsDetected: false;
  formulasDetected: false;
  originalFileStored: false;
};

export type CatalogImportPreview = {
  fileName: string;
  fileSha256: string;
  canCommit: boolean;
  security: CatalogImportSecurityReport;
  summary: {
    products: number;
    variants: number;
    productLinesToCreate: number;
    tonesToCreate: number;
    productAttributes: number;
    variantAttributes: number;
    media: number;
    relations: number;
    warnings: number;
    errors: number;
  };
  products: Array<{
    code: string;
    name: string;
    brand: string;
    line: string | null;
    variants: number;
    editorialStatus: string;
  }>;
  productLinesToCreate: Array<{
    brandSlug: string;
    brandName: string;
    slug: string;
    suggestedName: string;
    templateCodes: string[];
  }>;
  issues: CatalogImportIssue[];
};

export type CatalogImportProductLineApproval = {
  brandSlug: string;
  slug: string;
  name: string;
};

export type CatalogImportCommitResult = {
  batchId: string;
  fileSha256: string;
  createdProductLineCount: number;
  createdToneCount: number;
  products: Array<{ id: string; code: string; name: string }>;
};

export type CatalogMediaSecurityReport = {
  fileSha256: string;
  fileBytes: number;
  archiveEntries: number;
  totalUncompressedBytes: number;
  mediaBytes: number;
  pathsRestrictedToProducts: true;
  contentSignaturesVerified: true;
  existingFilesOverwritten: false;
  originalFileStored: false;
};

export type CatalogMediaPackagePreview = {
  fileName: string;
  fileSha256: string;
  canCommit: boolean;
  security: CatalogMediaSecurityReport;
  summary: {
    mediaFiles: number;
    webpFiles: number;
    pdfFiles: number;
    ignoredFiles: number;
    existingFiles: number;
    filesToUpload: number;
    mediaBytes: number;
  };
  ignored: Array<{ path: string; reason: string }>;
  samplePaths: string[];
};

export type CatalogMediaPackageCommitResult = {
  batchId: string;
  fileSha256: string;
  uploadedFiles: number;
  existingFiles: number;
  uploadedBytes: number;
};
