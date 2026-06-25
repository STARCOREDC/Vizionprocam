import Icon from './Icon.jsx';

/**
 * Campo de busca com ícone.
 * Props:
 *  - value:       string
 *  - onChange:    (novoValor) => void
 *  - placeholder: texto placeholder
 */
export default function SearchBar({
  value,
  onChange,
  placeholder = 'Buscar…',
}) {
  return (
    <div className="searchbar">
      <span className="searchbar-icon" aria-hidden="true">
        <Icon name="search" size={18} />
      </span>
      <input
        type="text"
        className="searchbar-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button
          type="button"
          className="searchbar-clear"
          onClick={() => onChange('')}
          aria-label="Limpar busca"
        >
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
}
