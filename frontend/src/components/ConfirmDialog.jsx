import Modal from './Modal.jsx';

/**
 * Diálogo de confirmação reutilizável (ex: excluir).
 * Props:
 *  - open:       boolean
 *  - title:      título (default "Confirmar")
 *  - message:    texto / nó descritivo
 *  - confirmText (default "Confirmar")
 *  - cancelText  (default "Cancelar")
 *  - danger:     estiliza o botão de confirmar como destrutivo
 *  - busy:       desabilita os botões enquanto processa
 *  - onConfirm / onCancel
 */
export default function ConfirmDialog({
  open,
  title = 'Confirmar',
  message,
  confirmText = 'Confirmar',
  cancelText = 'Cancelar',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? undefined : onCancel}
      size="sm"
      footer={
        <>
          <button
            type="button"
            className="btn ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'danger-solid' : 'primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Aguarde…' : confirmText}
          </button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>
    </Modal>
  );
}
