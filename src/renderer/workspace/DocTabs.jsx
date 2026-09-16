/** Tabs above the document: Workspace plus opened notes (design lines 169–178). */
export default function DocTabs({ tabs, activeTab, onSelect, onClose }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 8px', minHeight: 38, borderBottom: '1px solid #eaeaea', flex: 'none' }}>
      {tabs.map((tab) => {
        const on = tab.id === activeTab;
        return (
          <div key={tab.id} className="hov-ink" onClick={() => onSelect(tab.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 12px', marginBottom: -1, borderBottom: `2px solid ${on ? '#171717' : 'transparent'}`, cursor: 'pointer', font: `${on ? 600 : 400} 13px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', whiteSpace: 'nowrap' }}>
            <span>{tab.title}</span>
            {tab.id !== 'ws' && (
              <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); onClose(tab.id); }} aria-label="Close tab" style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
