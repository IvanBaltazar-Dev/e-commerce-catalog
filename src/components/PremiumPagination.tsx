type PaginationItem = number | "ellipsis-start" | "ellipsis-end";

function paginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 3) {
    return [1, 2, 3, 4, "ellipsis-end", totalPages];
  }

  if (currentPage >= totalPages - 2) {
    return [1, "ellipsis-start", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, "ellipsis-start", currentPage - 1, currentPage, currentPage + 1, "ellipsis-end", totalPages];
}

type PremiumPaginationProps = {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  tone?: "admin" | "public";
};

export function PremiumPagination({
  currentPage,
  totalPages,
  onPageChange,
  tone = "admin"
}: PremiumPaginationProps) {
  if (totalPages <= 1) {
    return null;
  }

  return (
    <nav
      className={`premium-pagination premium-pagination--${tone}`}
      aria-label="Paginación de productos"
    >
      <button
        type="button"
        className="premium-page premium-page--arrow"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
        aria-label="Página anterior"
      >
        ←
      </button>

      {paginationItems(currentPage, totalPages).map((item) =>
        typeof item === "number" ? (
          <button
            key={item}
            type="button"
            className={item === currentPage ? "premium-page premium-page--active" : "premium-page"}
            onClick={() => onPageChange(item)}
            aria-label={`Página ${item}`}
            aria-current={item === currentPage ? "page" : undefined}
          >
            {item}
          </button>
        ) : (
          <span key={item} className="premium-page-ellipsis" aria-hidden="true">
            ···
          </span>
        )
      )}

      <button
        type="button"
        className="premium-page premium-page--arrow"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
        aria-label="Página siguiente"
      >
        →
      </button>
    </nav>
  );
}
