import { useMemo, useState } from 'react';

/**
 * Hook de paginação client-side.
 * @param {Array} items     array completo de itens
 * @param {number} pageSize itens por página (default 20)
 * @returns {{ page, setPage, totalPages, slice }}
 */
export function usePaginated(items, pageSize = 20) {
  const list = Array.isArray(items) ? items : [];
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));

  // Clampa a página corrente caso a lista encolha (ex: após filtro/exclusão).
  const safePage = Math.min(page, totalPages);

  const slice = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return list.slice(start, start + pageSize);
  }, [list, safePage, pageSize]);

  return { page: safePage, setPage, totalPages, slice };
}

export default usePaginated;
