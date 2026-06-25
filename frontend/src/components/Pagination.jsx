import Icon from './Icon.jsx';

/**
 * Paginação reutilizável.
 * Props:
 *  - page:     página atual (1-based)
 *  - total:    total de itens
 *  - pageSize: itens por página
 *  - onChange: (novaPagina) => void
 */
export default function Pagination({ page, total, pageSize, onChange }) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / (pageSize || 1)));
  if (totalPages <= 1) return null;

  const go = (p) => {
    const next = Math.min(totalPages, Math.max(1, p));
    if (next !== page) onChange(next);
  };

  return (
    <div className="pagination">
      <button
        type="button"
        className="pg-btn"
        onClick={() => go(page - 1)}
        disabled={page <= 1}
        aria-label="Página anterior"
      >
        <Icon name="chevron-left" size={18} />
      </button>
      <span className="pg-info">
        Página {page} de {totalPages}
      </span>
      <button
        type="button"
        className="pg-btn"
        onClick={() => go(page + 1)}
        disabled={page >= totalPages}
        aria-label="Próxima página"
      >
        <Icon name="chevron-right" size={18} />
      </button>
    </div>
  );
}
