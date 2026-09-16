import React from 'react';

/** A DS field (tinted box, border turns strong on focus) that commits on Enter and cancels on Escape. */
export default function InlineField({ placeholder, initial = '', onCommit, onCancel, autoFocus = true, width = 260, style }) {
  const [value, setValue] = React.useState(initial);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [autoFocus]);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed) onCommit(trimmed);
    else if (onCancel) onCancel();
  };
  return (
    <div className="focus-bd2" style={{ display: 'flex', alignItems: 'center', width, padding: '9px 12px', background: '#fafafa', border: '1px solid #eaeaea', borderRadius: 8, ...style }}>
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            if (onCancel) onCancel();
          }
        }}
        onBlur={commit}
        style={{ all: 'unset', flex: 1, minWidth: 0, font: '14px/1.4 var(--font-sans)', color: '#171717' }}
      />
    </div>
  );
}
