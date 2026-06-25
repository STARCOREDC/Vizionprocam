import { useEffect } from 'react';

/**
 * Modal reutilizável (overlay + card centralizado).
 * Props:
 *  - open:     boolean controla visibilidade
 *  - title:    título no cabeçalho
 *  - onClose:  callback ao fechar (overlay, X, ESC)
 *  - children: conteúdo
 *  - footer:   nó opcional para rodapé com ações
 *  - size:     'sm' | 'md' | 'lg' (default 'md')
 */
export default function Modal({ open, title, onClose, children, footer, size = 'md' }) {
  // Fecha com ESC e trava o scroll do body enquanto aberto.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className={`modal-card ${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h3 className="modal-title">{title}</h3>
          <button
            type="button"
            className="modal-x"
            aria-label="Fechar"
            onClick={onClose}
          >
            &times;
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
