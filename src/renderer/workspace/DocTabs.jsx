/** Document tabs, rendered inside the header's middle column (design 2026-09-17): Workspace plus opened notes. */
export default function DocTabs({ tabs, activeTab, onSelect, onClose }) {
  return tabs.map((tab) => {
    const on = tab.id === activeTab;
    return (
      <div
        key={tab.id}
        className="hov-ink"
        onClick={() => onSelect(tab.id)}
        data-doc-tab={tab.id}
        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: 220, flex: '0 1 auto', padding: '7px 12px 8px', marginBottom: -1, border: `1px solid ${on ? '#eaeaea' : 'transparent'}`, borderBottomColor: on ? '#fff' : 'transparent', borderRadius: '8px 8px 0 0', background: on ? '#fff' : 'transparent', cursor: 'pointer', font: `${on ? 500 : 400} 12.5px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', whiteSpace: 'nowrap', transition: 'color 120ms' }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.title}</span>
        {tab.id !== 'ws' && (
          <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); onClose(tab.id); }} aria-label="Close tab" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
        )}
      </div>
    );
  });
}
