import React from 'react';

const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', font: '13px/1.4 var(--font-sans)', color: '#171717' };

export default function PreviewSizeMenu({ devices, device, onSelect }) {
  const [position, setPosition] = React.useState(null);
  const triggerRef = React.useRef(null);
  const submenuRef = React.useRef(null);
  const focusOnOpen = React.useRef(false);
  const id = React.useId();
  const current = devices.find(item => item.id === device) || devices[0];
  const open = (focus = false) => {
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(240, window.innerWidth - 16);
    const right = rect.right + width + 4 <= window.innerWidth - 8;
    const left = !right && rect.left - width - 4 >= 8;
    focusOnOpen.current = focus;
    setPosition({
      left: right ? rect.right : left ? rect.left - width - 4 : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(right || left ? rect.top - 4 : rect.bottom, window.innerHeight - (devices.length * 33 + 10) - 8)),
      width: width + 4,
      paddingLeft: right ? 4 : 0,
      paddingRight: left ? 4 : 0,
    });
  };
  React.useLayoutEffect(() => {
    if (position && focusOnOpen.current) {
      focusOnOpen.current = false;
      submenuRef.current?.querySelector('[aria-checked="true"]')?.focus();
    }
  }, [position]);
  const close = () => { setPosition(null); triggerRef.current?.focus(); };
  const onKeyDown = event => {
    if (position && (event.key === 'Escape' || event.key === 'ArrowLeft')) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.target === triggerRef.current && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
      event.preventDefault(); open(true);
    } else if (submenuRef.current?.contains(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...submenuRef.current.querySelectorAll('button')];
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };
  return <div onMouseEnter={() => open()} onMouseLeave={() => { if (!submenuRef.current?.contains(document.activeElement)) setPosition(null); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPosition(null); }} onKeyDown={onKeyDown}>
    <button ref={triggerRef} type="button" data-preview-size="1" className="hov-wash" aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? id : undefined}
      onClick={() => open(true)} style={{ ...rowStyle, background: position ? '#f2f2f2' : 'transparent' }}>
      <span style={{ flex: 'none' }}>Preview size</span>
      <span style={{ flex: 1, minWidth: 0, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: '#8f8f8f' }}>{current.name}</span>
      <span aria-hidden="true" style={{ flex: 'none', color: '#8f8f8f' }}>›</span>
    </button>
    {position && <div data-overlay="1" style={{ position: 'fixed', zIndex: 61, boxSizing: 'border-box', ...position }}>
      <div ref={submenuRef} id={id} role="menu" aria-label="Preview size" data-preview-size-menu="1"
        style={{ padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}>
        {devices.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={device === item.id} className="hov-wash"
          onClick={() => onSelect(item.id)} style={rowStyle}>
          <span aria-hidden="true" style={{ flex: 'none', width: 14, textAlign: 'center', fontSize: 12 }}>{device === item.id ? '✓' : ''}</span>
          <span style={{ flex: 1 }}>{item.name}</span>
          <span style={{ font: '11px/1 var(--font-mono)', color: '#8f8f8f' }}>{item.w ? `${item.w}×${item.h}` : ''}</span>
        </button>)}
      </div>
    </div>}
  </div>;
}
