import { useId, useRef, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import './skins.css';

export type SkinName = 'forest' | 'elysia';

export function SkinAvatar() {
  return (
    <span className="skin-avatar" aria-hidden="true">
      <img src="skins/elysia.png" alt="" />
    </span>
  );
}

export interface SkinPickerProps {
  skin: SkinName;
  onSelect: (skin: SkinName) => void;
  disabled?: boolean;
}

const options = [
  { id: 'forest', name: '森林序曲', description: '松绿 · 清晰专注' },
  { id: 'elysia', name: '爱莉希雅', description: '粉色妖精 · 水晶花语' },
] as const;

/** A shared, keyboard accessible skin selector for the manager and native popup. */
export function SkinPicker({ skin, onSelect, disabled = false }: SkinPickerProps) {
  const groupId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    if (disabled) return;
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = (current + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (current - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    buttons.current[next]?.focus();
    onSelect(options[next].id);
  }

  return (
    <div className="skin-picker" role="radiogroup" aria-label="界面皮肤">
      {options.map((option, index) => {
        const current = skin === option.id;
        return (
          <button
            key={option.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-label={option.name}
            aria-describedby={`${groupId}-${option.id}`}
            aria-checked={current}
            tabIndex={current ? 0 : -1}
            disabled={disabled}
            className={`skin-option skin-${option.id}${current ? ' is-current' : ''}`}
            onClick={() => onSelect(option.id)}
            onKeyDown={(event) => navigate(event, index)}
          >
            <span className="skin-preview" aria-hidden="true">
              <span className="mini-nav">
                <i />
                <i />
                <i />
              </span>
              <span className="mini-tiles">
                {Array.from({ length: 6 }, (_, tile) => (
                  <span className="mini-tile" key={tile}>
                    <i />
                    <b />
                  </span>
                ))}
              </span>
              {option.id === 'elysia' && (
                <img className="skin-character" src="skins/elysia.png" alt="" loading="lazy" />
              )}
            </span>
            <span className="skin-option-copy">
              <strong>{option.name}</strong>
              <small id={`${groupId}-${option.id}`}>{option.description}</small>
            </span>
            {current && (
              <span className="skin-status">
                <Check size={12} aria-hidden="true" />
                使用中
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
