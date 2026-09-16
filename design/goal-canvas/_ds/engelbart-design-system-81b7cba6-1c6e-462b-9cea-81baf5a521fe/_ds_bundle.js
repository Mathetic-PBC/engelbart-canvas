/* @ds-bundle: {"format":4,"namespace":"EngelbartDesignSystem_81b7cb","components":[{"name":"ArrowButton","sourcePath":"components/actions/ArrowButton.jsx"},{"name":"Button","sourcePath":"components/actions/Button.jsx"},{"name":"Seed","sourcePath":"components/actions/Seed.jsx"},{"name":"Attachment","sourcePath":"components/content/Attachment.jsx"},{"name":"Card","sourcePath":"components/content/Card.jsx"},{"name":"Command","sourcePath":"components/content/Command.jsx"},{"name":"Inset","sourcePath":"components/content/Inset.jsx"},{"name":"ListGroup","sourcePath":"components/content/ListGroup.jsx"},{"name":"ListRow","sourcePath":"components/content/ListGroup.jsx"},{"name":"FileTile","sourcePath":"components/content/ListGroup.jsx"},{"name":"Message","sourcePath":"components/content/Message.jsx"},{"name":"MicroLabel","sourcePath":"components/content/MicroLabel.jsx"},{"name":"ThinkingDots","sourcePath":"components/content/ThinkingDots.jsx"},{"name":"TodoRow","sourcePath":"components/content/TodoRow.jsx"},{"name":"Field","sourcePath":"components/forms/Field.jsx"},{"name":"Option","sourcePath":"components/forms/Option.jsx"},{"name":"PillField","sourcePath":"components/forms/PillField.jsx"},{"name":"Slider","sourcePath":"components/forms/Slider.jsx"},{"name":"Pager","sourcePath":"components/navigation/Pager.jsx"},{"name":"StepRail","sourcePath":"components/navigation/StepRail.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"}],"sourceHashes":{"components/actions/ArrowButton.jsx":"4379f0bbd70b","components/actions/Button.jsx":"bb49d13649e1","components/actions/Seed.jsx":"e16f6664957e","components/content/Attachment.jsx":"a43cdf8ab37f","components/content/Card.jsx":"577480ed0c12","components/content/Command.jsx":"026fde1dd5c9","components/content/Inset.jsx":"d7d663a5358e","components/content/ListGroup.jsx":"152f269ef2f7","components/content/Message.jsx":"4c0f9664f810","components/content/MicroLabel.jsx":"cf11e1c11e2c","components/content/ThinkingDots.jsx":"03985e3cf3eb","components/content/TodoRow.jsx":"0226f320a607","components/forms/Field.jsx":"887275e42873","components/forms/Option.jsx":"8d8fee1c1015","components/forms/PillField.jsx":"a05610c3b7ef","components/forms/Slider.jsx":"c8568dd2174c","components/navigation/Pager.jsx":"d058015069af","components/navigation/StepRail.jsx":"8b9c8e875425","components/navigation/Tabs.jsx":"7da1d03e820b","ui_kits/goal-workspace/GoalTree.jsx":"68de05449b9d","ui_kits/goal-workspace/Inspector.jsx":"f171c1634a0b","ui_kits/goal-workspace/WorkspaceApp.jsx":"228b5664f598","ui_kits/setup-wizard/StepsIdentity.jsx":"061c2beac167","ui_kits/setup-wizard/StepsProject.jsx":"f7989afa708e","ui_kits/setup-wizard/StepsTodos.jsx":"210830b355cf","ui_kits/setup-wizard/WizardApp.jsx":"096c6147c93b"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.EngelbartDesignSystem_81b7cb = window.EngelbartDesignSystem_81b7cb || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/actions/ArrowButton.jsx
try { (() => {
/** 38px round pager arrow. on=true fills ink. */
function ArrowButton({
  dir = 'next',
  on = false,
  disabled = false,
  onClick
}) {
  const [hov, setHov] = React.useState(false);
  const s = {
    flex: 'none',
    width: 38,
    height: 38,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    font: `15px/1 var(--font-sans)`,
    borderRadius: '50%',
    cursor: disabled ? 'default' : 'pointer',
    transition: 'color 120ms,border-color 120ms,opacity 120ms',
    border: '1px solid',
    ...(on ? {
      color: 'var(--onacc)',
      background: 'var(--ink)',
      borderColor: 'var(--ink)',
      opacity: hov ? .86 : 1
    } : {
      color: hov && !disabled ? 'var(--ink)' : 'var(--mut)',
      background: 'transparent',
      borderColor: hov && !disabled ? 'var(--bd2)' : 'var(--bd)',
      opacity: disabled ? .35 : 1
    })
  };
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: s
  }, dir === 'prev' ? '←' : '→');
}
Object.assign(__ds_scope, { ArrowButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/ArrowButton.jsx", error: String((e && e.message) || e) }); }

// components/actions/Button.jsx
try { (() => {
/** Button. Default: sentence case 13px/500, 8px radius. variant: 'outline' | 'filled' (ink) | 'link' (accent text, no box). caps=true restores the tracked micro-caps pill. */
function Button({
  variant = 'outline',
  size = 'lg',
  caps = false,
  disabled = false,
  go = false,
  children,
  onClick,
  style
}) {
  const [hov, setHov] = React.useState(false);
  const filled = variant === 'filled',
    link = variant === 'link';
  const lg = size === 'lg';
  let base;
  if (caps) base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: lg ? '9px 18px' : '7px 15px',
    font: `500 ${lg ? 10 : 9}px/1 var(--font-sans)`,
    letterSpacing: lg ? '1.4px' : '1.5px',
    textTransform: 'uppercase',
    borderRadius: 999,
    border: '1px solid'
  };else base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: link ? 0 : lg ? '11px 16px' : '8px 12px',
    font: `500 ${lg ? 13 : 12.5}px/1 var(--font-sans)`,
    borderRadius: 8,
    border: link ? 'none' : '1px solid'
  };
  base = {
    ...base,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'border-color 120ms,color 120ms,background 120ms,opacity 120ms'
  };
  let s;
  if (link) s = {
    ...base,
    color: disabled ? 'var(--fnt)' : hov ? 'var(--acc-hov)' : 'var(--acc)',
    background: 'none'
  };else if (disabled) s = {
    ...base,
    color: 'var(--fnt)',
    background: 'var(--hov)',
    borderColor: 'var(--bd)'
  };else if (filled) s = {
    ...base,
    color: 'var(--onacc)',
    background: 'var(--ink)',
    borderColor: 'var(--ink)',
    opacity: hov ? .86 : 1
  };else s = {
    ...base,
    color: 'var(--ink)',
    background: hov ? 'var(--hov)' : 'var(--panel)',
    borderColor: hov ? 'var(--bd2)' : 'var(--bd)'
  };
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: {
      ...s,
      ...style
    }
  }, children, go && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: caps ? lg ? 12 : 10 : 14,
      lineHeight: 1,
      letterSpacing: 0
    }
  }, "\u203A"));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/Button.jsx", error: String((e && e.message) || e) }); }

// components/actions/Seed.jsx
try { (() => {
/** Suggestion chip under a text field. Pressing one is the same act as typing it. */
function Seed({
  children,
  onClick,
  size = 'sm'
}) {
  const [hov, setHov] = React.useState(false);
  const lg = size === 'lg';
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClick,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: {
      padding: lg ? '6px 12px' : '5px 11px',
      font: `${lg ? 12 : 11.5}px/1.4 var(--font-sans)`,
      color: hov ? 'var(--ink)' : 'var(--mut)',
      background: hov ? 'var(--hov)' : 'transparent',
      border: '1px solid',
      borderColor: hov ? 'var(--bd2)' : 'var(--bd)',
      borderRadius: 999,
      cursor: 'pointer',
      transition: 'color 120ms,border-color 120ms,background 120ms'
    }
  }, children);
}
Object.assign(__ds_scope, { Seed });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/actions/Seed.jsx", error: String((e && e.message) || e) }); }

// components/content/Attachment.jsx
try { (() => {
/** Attached URL or pasted text: 26px icon tile (≡ ink / ↗ grey), title, optional show/hide toggle, ×. */
function Attachment({
  kind = 'url',
  title,
  text,
  onRemove
}) {
  const [open, setOpen] = React.useState(false);
  const [xh, setXh] = React.useState(false);
  const isText = kind === 'text';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '12px 14px',
      border: '1px solid var(--bd)',
      borderRadius: 10,
      background: 'var(--panel)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      width: 26,
      height: 26,
      borderRadius: 7,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: `500 13px/1 var(--font-sans)`,
      background: isText ? 'var(--ink)' : 'var(--hov)',
      color: isText ? 'var(--onacc)' : 'var(--mut)'
    }
  }, isText ? '≡' : '↗'), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      font: `500 13px/1.4 var(--font-sans)`,
      color: 'var(--ink)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, title), isText && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setOpen(!open),
    style: {
      marginTop: 3,
      padding: 0,
      font: `12px/1.5 var(--font-sans)`,
      color: 'var(--fnt)',
      background: 'none',
      border: 'none',
      borderBottom: '1px dotted var(--bd2)',
      cursor: 'pointer'
    }
  }, open ? 'Hide text ⌃' : 'Show pasted text ›'), isText && open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      padding: '10px 12px',
      background: 'var(--tint)',
      borderRadius: 8,
      font: `12.5px/1.7 var(--font-sans)`,
      color: 'var(--mut)',
      whiteSpace: 'pre-wrap',
      maxHeight: 180,
      overflowY: 'auto'
    }
  }, text)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onRemove,
    onMouseEnter: () => setXh(true),
    onMouseLeave: () => setXh(false),
    style: {
      flex: 'none',
      padding: '0 3px',
      font: `14px/1 var(--font-sans)`,
      color: xh ? 'var(--del)' : 'var(--bd2)',
      background: 'none',
      border: 'none',
      cursor: 'pointer'
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Attachment });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/Attachment.jsx", error: String((e && e.message) || e) }); }

// components/content/Card.jsx
try { (() => {
/** Bordered card: 12px radius, 1px #eaeaea border, 20px padding. Optional head (title + micro-caps sub) over a 1px rule. strong=true uses the #c9c9c9 border. */
function Card({
  title,
  sub,
  children,
  strong = false,
  pad = 20,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--panel)',
      border: `1px solid var(--${strong ? 'bd2' : 'bd'})`,
      borderRadius: 12,
      overflow: 'hidden',
      ...style
    }
  }, (title || sub) && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: `${pad - 4}px ${pad}px 0`
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      font: `500 14.5px/1.5 var(--font-sans)`,
      color: 'var(--ink)',
      textWrap: 'pretty'
    }
  }, title), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 5,
      font: `500 9px/1 var(--font-sans)`,
      letterSpacing: '1.4px',
      textTransform: 'uppercase',
      color: 'var(--fnt)'
    }
  }, sub), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: 'var(--bd)',
      marginTop: 8
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: pad
    }
  }, children));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/Card.jsx", error: String((e && e.message) || e) }); }

// components/content/Command.jsx
try { (() => {
/** Copyable command in a pill: mono-ish text, COPY button; says "copied" for 1.4s. */
function Command({
  text,
  said
}) {
  const [label, setLabel] = React.useState('copy');
  const [hov, setHov] = React.useState(false);
  const copy = () => {
    try {
      navigator.clipboard.writeText(text);
      setLabel('copied');
      setTimeout(() => setLabel('copy'), 1400);
    } catch (e) {
      setLabel('select it');
    }
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginTop: 9,
      padding: '9px 8px 9px 14px',
      background: 'var(--tint)',
      borderRadius: 999
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      font: `12.5px/1.5 var(--font-mono)`,
      color: 'var(--ink)',
      userSelect: 'all'
    }
  }, text), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: copy,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: {
      flex: 'none',
      padding: '5px 12px',
      font: `500 9px/1 var(--font-sans)`,
      letterSpacing: '1.4px',
      textTransform: 'uppercase',
      color: hov ? 'var(--ink)' : 'var(--mut)',
      background: 'var(--panel)',
      border: '1px solid',
      borderColor: hov ? 'var(--bd2)' : 'var(--bd)',
      borderRadius: 999,
      cursor: 'pointer'
    }
  }, label)), said && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      marginTop: 5,
      paddingLeft: 14,
      font: `11px/1.6 var(--font-sans)`,
      color: 'var(--fnt)'
    }
  }, said));
}
Object.assign(__ds_scope, { Command });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/Command.jsx", error: String((e && e.message) || e) }); }

// components/content/Inset.jsx
try { (() => {
/** Tinted aside for a doubt or note; optional micro-caps label. */
function Inset({
  label,
  children,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: '11px 14px',
      background: 'var(--tint)',
      borderRadius: 8,
      font: `12px/1.7 var(--font-sans)`,
      color: 'var(--mut)',
      textWrap: 'pretty',
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 4,
      font: `500 9px/1 var(--font-sans)`,
      letterSpacing: '1.6px',
      textTransform: 'uppercase',
      color: 'var(--fnt)'
    }
  }, label), children);
}
Object.assign(__ds_scope, { Inset });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/Inset.jsx", error: String((e && e.message) || e) }); }

// components/content/ListGroup.jsx
try { (() => {
/** Stack of rows on a #fafafa panel, 1px separators, 8px radius. Put ListRow (or a flat Attachment) inside. */
function ListGroup({
  children,
  style
}) {
  const kids = React.Children.toArray(children).filter(Boolean);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--tint)',
      border: '1px solid var(--bd)',
      borderRadius: 8,
      overflow: 'hidden',
      ...style
    }
  }, kids.map((k, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      borderTop: i ? '1px solid var(--bd)' : 'none'
    }
  }, k)));
}
/** One row: optional leading tile, label + faint hint, optional meta line, trailing action or › chevron. */
function ListRow({
  icon,
  label,
  hint,
  meta,
  action,
  chevron = true,
  onClick,
  style
}) {
  const [hov, setHov] = React.useState(false);
  const act = !!onClick;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: icon ? '14px 18px' : '15px 18px',
      minHeight: 52,
      boxSizing: 'border-box',
      cursor: act ? 'pointer' : 'default',
      background: act && hov ? 'var(--hov)' : 'transparent',
      transition: 'background 120ms',
      ...style
    }
  }, icon, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: meta ? 3 : 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 10,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '14px/1.4 var(--font-sans)',
      color: 'var(--ink)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, label), hint && /*#__PURE__*/React.createElement("span", {
    style: {
      font: '12px/1.4 var(--font-sans)',
      color: 'var(--fnt)',
      whiteSpace: 'nowrap'
    }
  }, hint)), meta && /*#__PURE__*/React.createElement("span", {
    style: {
      font: '12px/1.4 var(--font-sans)',
      color: 'var(--mut)'
    }
  }, meta)), action ? action : chevron && act && /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      font: '16px/1 var(--font-sans)',
      color: 'var(--bd2)'
    }
  }, "\u203A"));
}
/** 32×40 white "document" tile with three grey lines — the leading icon for file rows. */
function FileTile() {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      width: 32,
      height: 40,
      borderRadius: 4,
      background: 'var(--panel)',
      border: '1px solid var(--bd)',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 3,
      padding: '0 6px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      height: 1.5,
      background: 'var(--gray-300)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      height: 1.5,
      background: 'var(--gray-300)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      height: 1.5,
      width: '60%',
      background: 'var(--gray-300)'
    }
  }));
}
Object.assign(__ds_scope, { ListGroup, ListRow, FileTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/ListGroup.jsx", error: String((e && e.message) || e) }); }

// components/content/Message.jsx
try { (() => {
/** Chat message. who='them' is plain prose; who='you' is a filled ink block right-aligned. */
function Message({
  who = 'them',
  children
}) {
  if (who === 'you') return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      paddingTop: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: '74%',
      marginTop: 7,
      padding: '11px 14px',
      background: 'var(--ink)',
      color: 'var(--onacc)',
      borderRadius: 8,
      font: `12.5px/1.7 var(--font-sans)`,
      whiteSpace: 'pre-wrap',
      textWrap: 'pretty'
    }
  }, children));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 7,
      font: `13px/1.75 var(--font-sans)`,
      color: 'var(--dtxt)',
      whiteSpace: 'pre-wrap',
      textWrap: 'pretty'
    }
  }, children));
}
Object.assign(__ds_scope, { Message });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/Message.jsx", error: String((e && e.message) || e) }); }

// components/content/MicroLabel.jsx
try { (() => {
/** The tracked micro-caps that label everything. size 'sm' 9px (.lbl) | 'lg' 10px (wizard-count). tone 'faint' | 'ghost' (#c9c9c9 note). */
function MicroLabel({
  children,
  size = 'sm',
  tone = 'faint',
  rule = false,
  right,
  style
}) {
  const s = {
    font: `500 ${size === 'lg' ? 10 : 9}px/${tone === 'ghost' ? 1.6 : 1} var(--font-sans)`,
    letterSpacing: tone === 'ghost' ? '1.4px' : '1.6px',
    textTransform: 'uppercase',
    color: tone === 'ghost' ? 'var(--bd2)' : 'var(--fnt)'
  };
  const inner = right ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: s
  }, children), /*#__PURE__*/React.createElement("span", {
    style: s
  }, right)) : /*#__PURE__*/React.createElement("div", {
    style: s
  }, children);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      ...(rule ? {
        paddingBottom: 10,
        borderBottom: '1px solid var(--bd)'
      } : {}),
      ...style
    }
  }, inner);
}
Object.assign(__ds_scope, { MicroLabel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/MicroLabel.jsx", error: String((e && e.message) || e) }); }

// components/content/ThinkingDots.jsx
try { (() => {
/** 3×3 grid of pulsing dots + "generating". */
function ThinkingDots({
  label = 'generating',
  size = 4
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("style", null, '@keyframes eng-pulse{0%,70%,100%{opacity:.15}35%{opacity:1}}'), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'grid',
      gridTemplateColumns: `repeat(3,${size}px)`,
      gap: size > 3 ? 2.5 : 2
    }
  }, Array.from({
    length: 9
  }, (_, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      background: 'var(--ink)',
      opacity: .15,
      animation: 'eng-pulse 1.1s ease-in-out infinite',
      animationDelay: `${i * 90}ms`
    }
  }))), /*#__PURE__*/React.createElement("span", {
    style: {
      font: `${size > 3 ? 13 : 11.5}px/1 var(--font-sans)`,
      letterSpacing: '0.3px',
      color: 'var(--fnt)'
    }
  }, label));
}
Object.assign(__ds_scope, { ThinkingDots });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/ThinkingDots.jsx", error: String((e && e.message) || e) }); }

// components/content/TodoRow.jsx
try { (() => {
/** One todo: "–" bullet, editable text, × that appears on hover (red on its own hover). */
function TodoRow({
  text,
  onChange,
  onDelete,
  placeholder,
  adder = false,
  onKeyDown
}) {
  const [hov, setHov] = React.useState(false);
  const [xh, setXh] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 4px',
      borderBottom: adder ? 'none' : '1px solid var(--line-soft)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      font: `13px/1 var(--font-sans)`,
      color: adder ? 'var(--bd2)' : 'var(--fnt)'
    }
  }, "\u2013"), /*#__PURE__*/React.createElement("input", {
    value: text,
    onChange: e => onChange && onChange(e.target.value),
    placeholder: placeholder,
    spellCheck: false,
    onKeyDown: onKeyDown,
    style: {
      all: 'unset',
      display: 'block',
      flex: 1,
      font: `13px/1.6 var(--font-sans)`,
      color: 'var(--ink)'
    }
  }), !adder && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onDelete,
    onMouseEnter: () => setXh(true),
    onMouseLeave: () => setXh(false),
    style: {
      flex: 'none',
      padding: '0 3px',
      font: `13px/1 var(--font-sans)`,
      color: xh ? 'var(--del)' : 'var(--bd2)',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      opacity: hov ? 1 : 0,
      transition: 'opacity 120ms'
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { TodoRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/TodoRow.jsx", error: String((e && e.message) || e) }); }

// components/forms/Field.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** A #fafafa box holding an unstyled input or textarea. Border turns #c9c9c9 on focus-within. */
function Field({
  value,
  onChange,
  placeholder,
  multiline = false,
  rows = 3,
  size = 'lg',
  autoFocus = false,
  onKeyDown,
  italicPlaceholder = false,
  style
}) {
  const [foc, setFoc] = React.useState(false);
  const lg = size === 'lg';
  const box = {
    padding: lg ? '12px 14px' : '9px 12px',
    background: 'var(--tint)',
    border: '1px solid',
    borderColor: foc ? 'var(--acc)' : lg ? 'var(--bd)' : 'transparent',
    borderRadius: 8,
    boxShadow: foc ? '0 0 0 3px var(--accbg)' : 'none',
    transition: 'border-color 120ms,box-shadow 120ms',
    ...style
  };
  const inp = {
    all: 'unset',
    display: 'block',
    width: '100%',
    font: lg ? `14px/1.6 var(--font-sans)` : `12.5px/1.7 var(--font-sans)`,
    color: 'var(--ink)',
    caretColor: 'var(--acc)',
    resize: 'none',
    minHeight: multiline && lg ? 64 : undefined
  };
  const ph = italicPlaceholder ? /*#__PURE__*/React.createElement("style", null, '.eng-field::placeholder{color:var(--fnt);font-style:italic}') : /*#__PURE__*/React.createElement("style", null, '.eng-field::placeholder{color:var(--fnt)}');
  const common = {
    className: 'eng-field',
    value,
    onChange: e => onChange && onChange(e.target.value),
    placeholder,
    autoFocus,
    spellCheck: false,
    onFocus: () => setFoc(true),
    onBlur: () => setFoc(false),
    onKeyDown,
    style: inp
  };
  return /*#__PURE__*/React.createElement("div", {
    style: box
  }, ph, multiline ? /*#__PURE__*/React.createElement("textarea", _extends({
    rows: rows
  }, common)) : /*#__PURE__*/React.createElement("input", common));
}
Object.assign(__ds_scope, { Field });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Field.jsx", error: String((e && e.message) || e) }); }

// components/forms/Option.jsx
try { (() => {
/** A selectable row that becomes a box when chosen: 11px mark (circle=one, 6px square=many) filled in the accent, label, optional why. */
function Option({
  on = false,
  many = false,
  label,
  why,
  onClick,
  boxed = true,
  size = 'lg'
}) {
  const [hov, setHov] = React.useState(false);
  const lg = size === 'lg';
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: {
      display: 'flex',
      alignItems: why ? 'flex-start' : 'center',
      gap: 11,
      padding: lg ? why ? '13px 14px' : '12px 14px' : '9px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      transition: 'border-color 120ms,background 120ms',
      border: '1px solid',
      borderColor: on ? 'var(--ink)' : boxed ? 'var(--bd)' : 'transparent',
      borderBottomColor: on ? 'var(--ink)' : 'var(--bd)',
      background: on ? 'var(--panel)' : hov ? 'var(--hov)' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      marginTop: why ? 4 : 0,
      width: 11,
      height: 11,
      borderRadius: many ? 6 : '50%',
      border: '1.5px solid',
      borderColor: on ? 'var(--acc)' : 'var(--bd2)',
      background: on ? 'var(--acc)' : 'transparent',
      boxSizing: 'border-box'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      font: lg ? why ? `500 13.5px/1.5 var(--font-sans)` : `13px/1.4 var(--font-sans)` : `12.5px/1.6 var(--font-sans)`,
      color: on ? 'var(--ink)' : 'var(--mut)'
    }
  }, label), why && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      marginTop: 3,
      font: `${lg ? 12 : 11.5}px/1.6 var(--font-sans)`,
      color: 'var(--fnt)',
      textWrap: 'pretty'
    }
  }, why)));
}
Object.assign(__ds_scope, { Option });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Option.jsx", error: String((e && e.message) || e) }); }

// components/forms/PillField.jsx
try { (() => {
/** Pill-shaped row: an input with a button living inside its right end (name-row / url-row / cmd). */
function PillField({
  value,
  onChange,
  placeholder,
  action,
  readOnly = false,
  autoFocus = false,
  onKeyDown,
  bold = false
}) {
  const [foc, setFoc] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '5px 5px 5px 14px',
      background: 'var(--tint)',
      border: '1px solid',
      borderColor: foc ? 'var(--bd2)' : 'var(--bd)',
      borderRadius: 999,
      transition: 'border-color 120ms'
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: value,
    readOnly: readOnly,
    onChange: e => onChange && onChange(e.target.value),
    placeholder: placeholder,
    autoFocus: autoFocus,
    spellCheck: false,
    onKeyDown: onKeyDown,
    onFocus: () => setFoc(true),
    onBlur: () => setFoc(false),
    style: {
      all: 'unset',
      display: 'block',
      flex: 1,
      minWidth: 0,
      font: `${bold ? '500 ' : ''}${bold ? 14 : 13}px/1.5 var(--font-sans)`,
      color: 'var(--ink)',
      caretColor: 'var(--acc)',
      userSelect: readOnly ? 'all' : undefined
    }
  }), action);
}
Object.assign(__ds_scope, { PillField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/PillField.jsx", error: String((e && e.message) || e) }); }

// components/forms/Slider.jsx
try { (() => {
/** Segmented register slider: n grey blocks rising left→right, the chosen one filled in the accent; a white thumb with an accent ring sits at its right edge. stops: string[] or {label,why}[]. */
function Slider({
  stops = [],
  value = 0,
  onChange,
  ends,
  touched = true,
  showTitle = true
}) {
  const n = stops.length;
  const items = stops.map(s => typeof s === 'string' ? {
    label: s
  } : s);
  const at = Math.max(0, Math.min(n - 1, value));
  const set = i => onChange && onChange(Math.max(0, Math.min(n - 1, i)));
  const onKey = e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      set(at + 1);
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      set(at - 1);
    }
  };
  const cur = items[at] || {};
  const gap = 8;
  const pct = (at + 1) / n;
  return /*#__PURE__*/React.createElement("div", null, showTitle && touched && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '500 17px/1.3 var(--font-sans)',
      color: 'var(--acc)',
      letterSpacing: '-0.2px'
    }
  }, cur.label), cur.why && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      font: '13px/1.5 var(--font-sans)',
      color: 'var(--mut)',
      textWrap: 'pretty'
    }
  }, cur.why)), /*#__PURE__*/React.createElement("div", {
    role: "slider",
    tabIndex: 0,
    "aria-valuemin": 0,
    "aria-valuemax": n - 1,
    "aria-valuenow": at,
    "aria-valuetext": cur.label,
    onKeyDown: onKey,
    style: {
      position: 'relative',
      outline: 'none',
      paddingBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap,
      height: 44
    }
  }, items.map((s, i) => {
    const on = touched && i === at;
    const h = on ? 10 : 16 + 28 * i / Math.max(1, n - 1);
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      "aria-label": s.label,
      onClick: () => set(i),
      style: {
        flex: 1,
        height: h,
        padding: 0,
        border: 'none',
        borderRadius: on ? 999 : 6,
        background: on ? 'var(--acc)' : 'var(--gray-200)',
        cursor: 'pointer',
        transition: 'height 140ms,background 120ms,border-radius 140ms'
      }
    });
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 4,
      height: 1,
      background: 'var(--bd)'
    }
  }), touched && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: -3,
      left: `calc(${pct * 100}% - ${pct * gap}px)`,
      transform: 'translateX(-50%)',
      width: 14,
      height: 14,
      borderRadius: '50%',
      background: 'var(--panel)',
      border: '2px solid var(--acc)',
      boxSizing: 'border-box',
      transition: 'left 140ms',
      pointerEvents: 'none'
    }
  })), ends && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginTop: 16,
      font: '12px/1 var(--font-sans)',
      color: 'var(--fnt)'
    }
  }, /*#__PURE__*/React.createElement("span", null, ends[0]), /*#__PURE__*/React.createElement("span", null, ends[1])));
}
Object.assign(__ds_scope, { Slider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Slider.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Pager.jsx
try { (() => {
/** Row of 6px dots; the current one stretches to 20px ink. */
function Pager({
  count = 1,
  index = 0,
  onSelect
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6
    }
  }, Array.from({
    length: count
  }, (_, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    onClick: onSelect ? () => onSelect(i) : undefined,
    style: {
      display: 'block',
      height: 6,
      borderRadius: 999,
      transition: 'width 140ms,background 140ms',
      cursor: i === index ? 'default' : 'pointer',
      width: i === index ? 20 : 6,
      background: i === index ? 'var(--ink)' : 'var(--bd2)'
    }
  })));
}
Object.assign(__ds_scope, { Pager });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Pager.jsx", error: String((e && e.message) || e) }); }

// components/navigation/StepRail.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** The 340px wizard rail: brand, caption, and numbered steps joined by a connector. steps[i].state: 'done'|'now'|'later'. */
function StepRail({
  brand = 'Engelbart',
  caption,
  steps = [],
  onStep,
  width = 340,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      flex: 'none',
      background: 'var(--panel2)',
      borderRight: '1px solid var(--bd)',
      display: 'flex',
      flexDirection: 'column',
      padding: '36px 32px',
      overflowY: 'auto',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `500 17px/1 var(--font-sans)`,
      letterSpacing: '-0.2px',
      color: 'var(--ink)'
    }
  }, brand), caption && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      font: `12px/1.6 var(--font-sans)`,
      color: 'var(--fnt)'
    }
  }, caption), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 40,
      display: 'flex',
      flexDirection: 'column'
    }
  }, steps.map((st, i) => /*#__PURE__*/React.createElement(RailStep, _extends({
    key: i,
    i: i
  }, st, {
    first: i === 0,
    onClick: onStep ? () => onStep(i) : undefined
  })))));
}
function RailStep({
  i,
  label,
  value,
  state = 'later',
  first,
  reachable = false,
  onClick
}) {
  const [hov, setHov] = React.useState(false);
  const done = state === 'done',
    now = state === 'now';
  const click = reachable && !now;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column'
    }
  }, !first && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      width: 1.5,
      height: 12,
      marginLeft: 20,
      background: done || now ? 'var(--ink)' : 'var(--gray-250)',
      transition: 'background 300ms'
    }
  }), /*#__PURE__*/React.createElement("div", {
    onClick: click ? onClick : undefined,
    onMouseEnter: () => setHov(true),
    onMouseLeave: () => setHov(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 12px',
      borderRadius: 8,
      border: '1px solid',
      borderColor: now ? 'var(--bd)' : 'transparent',
      background: now ? 'var(--panel)' : click && hov ? 'var(--hov)' : 'transparent',
      cursor: click ? 'pointer' : 'default'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      width: 18,
      height: 18,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: `500 9px/1 var(--font-sans)`,
      transition: 'background 300ms',
      boxSizing: 'border-box',
      ...(done ? {
        background: 'var(--ink)',
        color: 'var(--onacc)'
      } : now ? {
        border: '1.5px solid var(--ink)',
        color: 'var(--ink)',
        background: 'var(--panel)'
      } : {
        border: '1.5px solid var(--bd2)',
        color: 'var(--fnt)',
        background: 'var(--panel2)'
      })
    }
  }, done ? '✓' : i + 1), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      ...(done && value ? {
        font: `500 9px/1 var(--font-sans)`,
        letterSpacing: '1.2px',
        textTransform: 'uppercase',
        color: 'var(--fnt)'
      } : {
        font: `500 13px/1.3 var(--font-sans)`,
        color: now ? 'var(--ink)' : 'var(--fnt)'
      })
    }
  }, label), done && value && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      marginTop: 3,
      font: `500 12.5px/1.3 var(--font-sans)`,
      color: 'var(--ink)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, value))));
}
Object.assign(__ds_scope, { StepRail });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/StepRail.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
/** Micro-caps text tabs with a 2px underline (goal workspace PROMPT / NOTES). */
function Tabs({
  items = [],
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      borderBottom: '1px solid var(--bd)'
    }
  }, items.map(t => /*#__PURE__*/React.createElement("span", {
    key: t,
    onClick: () => onChange && onChange(t),
    style: {
      padding: '0 2px 7px',
      font: `600 10px var(--font-sans)`,
      letterSpacing: '1.2px',
      textTransform: 'uppercase',
      cursor: 'pointer',
      borderBottom: '2px solid',
      borderBottomColor: t === value ? 'var(--ink)' : 'transparent',
      marginBottom: -1,
      color: t === value ? 'var(--ink)' : 'var(--fnt)'
    }
  }, t)));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/goal-workspace/GoalTree.jsx
try { (() => {
{
  function GoalRow({
    g,
    depth,
    sel,
    onSelect,
    onToggle,
    onAdd,
    onDel,
    editing,
    onRename
  }) {
    const done = g.status === 'completed' || g.status === 'archived';
    const ip = g.status === 'in_progress';
    const [hov, setHov] = React.useState(false);
    return /*#__PURE__*/React.createElement("div", {
      className: "rowh",
      onMouseEnter: () => setHov(true),
      onMouseLeave: () => setHov(false),
      onClick: () => onSelect(g.id),
      onDoubleClick: () => onRename(g.id),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        height: 29,
        padding: '0 8px',
        borderRadius: 6,
        cursor: 'pointer',
        background: sel ? 'var(--hov)' : undefined
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 'none',
        width: depth * 18
      }
    }), /*#__PURE__*/React.createElement("span", {
      onClick: e => {
        e.stopPropagation();
        onToggle(g.id);
      },
      style: {
        width: 12,
        flex: 'none',
        textAlign: 'center',
        font: '10px var(--font-sans)',
        color: 'var(--fnt)'
      }
    }, g.kids.length ? g.open ? '▾' : '▸' : ''), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 13,
        height: 13,
        flex: 'none',
        borderRadius: '50%',
        boxSizing: 'border-box',
        color: 'var(--mut)',
        font: '8.5px/10px var(--font-sans)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1.5px solid var(--fnt)',
        background: done ? 'var(--ink)' : ip ? 'var(--hov)' : 'transparent',
        borderColor: done ? 'var(--ink)' : 'var(--fnt)'
      }
    }, done ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#fff'
      }
    }, "\u2713") : ''), editing ? /*#__PURE__*/React.createElement("input", {
      autoFocus: true,
      defaultValue: g.title,
      onClick: e => e.stopPropagation(),
      onBlur: e => onRename(g.id, e.target.value),
      onKeyDown: e => {
        if (e.key === 'Enter') onRename(g.id, e.target.value);
        if (e.key === 'Escape') onRename(g.id, g.title);
      },
      style: {
        flex: 1,
        minWidth: 80,
        border: '1px solid var(--acc)',
        borderRadius: 6,
        background: 'var(--panel)',
        padding: '3px 7px',
        font: '12.5px var(--font-sans)',
        color: 'var(--ink)',
        outline: 'none',
        boxShadow: '0 0 0 2px var(--acchov)'
      }
    }) : /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12.5,
        color: done ? 'var(--fnt)' : 'var(--ink)',
        textDecoration: done ? 'line-through' : 'none',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, g.title), hov && !editing && /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: 'auto',
        display: 'inline-flex',
        gap: 10,
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "rb add",
      onClick: e => {
        e.stopPropagation();
        onAdd(g.id);
      },
      style: {
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: '500 12px var(--font-sans)',
        color: 'var(--fnt)',
        cursor: 'pointer',
        borderRadius: 4
      }
    }, "+"), /*#__PURE__*/React.createElement("span", {
      className: "rb del",
      onClick: e => {
        e.stopPropagation();
        onDel(g.id);
      },
      style: {
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: '500 12px var(--font-sans)',
        color: 'var(--fnt)',
        cursor: 'pointer',
        borderRadius: 4
      }
    }, "\xD7")));
  }
  function GoalTree(props) {
    const {
      goals,
      sel,
      filter
    } = props;
    const show = g => filter === 'all' || (filter === 'active' ? g.status !== 'completed' && g.status !== 'archived' : filter === 'done' ? g.status === 'completed' : g.status === 'archived');
    const rows = [];
    const walk = (list, d) => list.forEach(g => {
      if (!show(g)) return;
      rows.push([g, d]);
      if (g.open) walk(g.kids, d + 1);
    });
    walk(goals, 0);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0,
        flex: 1,
        border: '1px solid var(--bd)',
        borderRadius: 6,
        padding: '6px 10px 6px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        padding: '2px 4px 3px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "exp",
      title: "Expand goal tree",
      style: {
        font: '13px/1 var(--font-sans)',
        color: 'var(--fnt)',
        cursor: 'pointer'
      }
    }, "\u2922")), rows.map(([g, d]) => /*#__PURE__*/React.createElement(GoalRow, {
      key: g.id,
      g: g,
      depth: d,
      sel: sel === g.id,
      editing: props.editing === g.id,
      onSelect: props.onSelect,
      onToggle: props.onToggle,
      onAdd: props.onAdd,
      onDel: props.onDel,
      onRename: props.onRename
    })), rows.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '10px 8px',
        fontSize: 12.5,
        color: 'var(--mut)'
      }
    }, "Nothing here yet."), /*#__PURE__*/React.createElement("div", {
      className: "addrow",
      onClick: () => props.onAdd(null),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        height: 28,
        padding: '0 8px',
        borderRadius: 6,
        cursor: 'pointer',
        color: 'var(--mut)',
        marginTop: 2
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 12,
        flex: 'none',
        textAlign: 'center',
        font: '12px var(--font-sans)'
      }
    }, "+"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12.5
      }
    }, "Add goal")), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '5px 8px 3px',
        fontSize: 10.5,
        color: 'var(--fnt)'
      }
    }, "Tab cycles \xB7 \u2318\u23CE new sibling \xB7 \u2318\u232B delete \xB7 double-click renames"));
  }
  Object.assign(window, {
    GoalTree
  });
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/goal-workspace/GoalTree.jsx", error: String((e && e.message) || e) }); }

// ui_kits/goal-workspace/Inspector.jsx
try { (() => {
{
  const {
    Tabs
  } = window.EngelbartDesignSystem_81b7cb;
  const STATUSES = [['todo', 'todo'], ['in_progress', 'in progress'], ['completed', 'done'], ['archived', 'archived']];
  const PRIS = ['low', 'medium', 'high'];
  function Chip({
    on,
    children,
    onClick
  }) {
    return /*#__PURE__*/React.createElement("span", {
      className: "hl",
      onClick: onClick,
      style: {
        font: '11px var(--font-sans)',
        cursor: 'pointer',
        color: on ? 'var(--ink)' : 'var(--fnt)',
        fontWeight: on ? 600 : 400
      }
    }, children);
  }
  function Inspector({
    g,
    onChange
  }) {
    const [tab, setTab] = React.useState('Prompt');
    const [copied, setCopied] = React.useState(false);
    const lab = {
      font: '600 10px var(--font-sans)',
      letterSpacing: '1.2px',
      color: 'var(--mut)'
    };
    const chiplab = {
      width: 56,
      flex: 'none',
      font: '600 9.5px var(--font-sans)',
      letterSpacing: '1px',
      color: 'var(--fnt)'
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        width: 340,
        minWidth: 300,
        flex: 'none',
        position: 'sticky',
        top: 16,
        border: '1px solid var(--bd)',
        borderRadius: 6,
        padding: '14px 16px 16px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: lab
    }, "SELECTED GOAL"), /*#__PURE__*/React.createElement("span", {
      className: "exp",
      style: {
        font: '13px/1 var(--font-sans)',
        color: 'var(--fnt)',
        cursor: 'pointer'
      }
    }, "\u2922")), !g ? /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '24px 0',
        textAlign: 'center',
        fontSize: 12.5,
        color: 'var(--fnt)'
      }
    }, "Nothing selected \u2014 click a goal, or \u2318\u23CE to create one.") : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 7,
        fontSize: 13.5,
        fontWeight: 700,
        lineHeight: 1.4,
        color: 'var(--ink)',
        cursor: 'text'
      }
    }, g.title), /*#__PURE__*/React.createElement("textarea", {
      value: g.desc || '',
      onChange: e => onChange({
        desc: e.target.value
      }),
      rows: 2,
      placeholder: "Add a description\u2026",
      spellCheck: false,
      style: {
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 6,
        border: 'none',
        outline: 'none',
        resize: 'none',
        background: 'transparent',
        padding: 0,
        font: '11.5px/1.6 var(--font-sans)',
        color: 'var(--mut)'
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 14,
        marginTop: 13
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: chiplab
    }, "STATUS"), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        gap: 14
      }
    }, STATUSES.map(([k, l]) => /*#__PURE__*/React.createElement(Chip, {
      key: k,
      on: g.status === k,
      onClick: () => onChange({
        status: k
      })
    }, l)))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 14,
        marginTop: 9
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: chiplab
    }, "PRIORITY"), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        gap: 14
      }
    }, PRIS.map(p => /*#__PURE__*/React.createElement(Chip, {
      key: p,
      on: g.priority === p,
      onClick: () => onChange({
        priority: p
      })
    }, p)))), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 15
      }
    }, /*#__PURE__*/React.createElement(Tabs, {
      items: ['Prompt', 'Notes'],
      value: tab,
      onChange: setTab
    })), tab === 'Prompt' ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("textarea", {
      value: g.draft || '',
      onChange: e => onChange({
        draft: e.target.value
      }),
      spellCheck: false,
      style: {
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 96,
        maxHeight: 300,
        resize: 'none',
        marginTop: 11,
        border: '1px solid var(--bd)',
        borderRadius: 6,
        background: 'var(--panel2)',
        padding: '9px 11px',
        font: '12px/1.6 var(--font-mono)',
        color: 'var(--dtxt)',
        outline: 'none'
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 10,
        gap: 12
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: 'var(--fnt)'
      }
    }, "Copy appends goal metadata"), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        gap: 18,
        alignItems: 'baseline'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "hl",
      style: {
        font: '600 11.5px var(--font-sans)',
        color: 'var(--acc)',
        cursor: 'pointer'
      }
    }, "generate"), /*#__PURE__*/React.createElement("span", {
      className: "hl",
      onClick: () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      style: {
        font: '600 11.5px var(--font-sans)',
        color: 'var(--acc)',
        cursor: 'pointer'
      }
    }, copied ? 'copied' : 'copy prompt')))) : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 11,
        border: '1px solid var(--bd)',
        borderRadius: 6,
        background: 'var(--panel2)'
      }
    }, /*#__PURE__*/React.createElement("textarea", {
      value: g.notes || '',
      onChange: e => onChange({
        notes: e.target.value
      }),
      placeholder: "Plan in markdown \u2014 # heading, - list, - [ ] task, **bold**, `code`",
      spellCheck: false,
      style: {
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 150,
        padding: '10px 12px',
        font: '12px/1.7 var(--font-mono)',
        background: 'transparent',
        border: 'none',
        outline: 'none',
        resize: 'none',
        color: 'var(--dtxt)'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 8,
        fontSize: 11,
        color: 'var(--fnt)'
      }
    }, "Markdown formats as you type \xB7 auto-saved with this goal"))));
  }
  Object.assign(window, {
    Inspector
  });
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/goal-workspace/Inspector.jsx", error: String((e && e.message) || e) }); }

// ui_kits/goal-workspace/WorkspaceApp.jsx
try { (() => {
{
  let nid = 100;
  const SEED = [{
    id: 1,
    title: 'Build the agent CLI loop',
    status: 'in_progress',
    priority: 'high',
    desc: 'Prompt in, tool calls out, loop until done.',
    draft: 'Implement the dispatch loop: parse tool calls from the model response, execute, append results, repeat until a plain answer.',
    open: true,
    kids: [{
      id: 2,
      title: 'Tool interface and registry',
      status: 'completed',
      priority: 'medium',
      kids: [],
      open: true
    }, {
      id: 3,
      title: 'The three concrete tools',
      status: 'in_progress',
      priority: 'high',
      kids: [{
        id: 6,
        title: 'run_shell with a timeout',
        status: 'todo',
        priority: 'medium',
        kids: [],
        open: true
      }],
      open: true
    }, {
      id: 4,
      title: 'Dispatch loop',
      status: 'todo',
      priority: 'high',
      kids: [],
      open: true
    }]
  }, {
    id: 5,
    title: 'Keep long sessions coherent',
    status: 'todo',
    priority: 'medium',
    desc: 'Context manager: transcript compaction and what the agent may do without asking.',
    kids: [],
    open: true
  }, {
    id: 7,
    title: 'Sandbox agent-issued shell commands',
    status: 'archived',
    priority: 'low',
    kids: [],
    open: true
  }];
  function WorkspaceApp() {
    const [goals, setGoals] = React.useState(SEED);
    const [sel, setSel] = React.useState(1);
    const [filter, setFilter] = React.useState('active');
    const [editing, setEditing] = React.useState(null);
    const [dark, setDark] = React.useState(false);
    const map = (list, fn) => list.map(g => fn({
      ...g,
      kids: map(g.kids, fn)
    }));
    const find = (list, id) => {
      for (const g of list) {
        if (g.id === id) return g;
        const k = find(g.kids, id);
        if (k) return k;
      }
      return null;
    };
    const patch = (id, p) => setGoals(gs => map(gs, g => g.id === id ? {
      ...g,
      ...p
    } : g));
    const onAdd = parent => {
      const n = {
        id: ++nid,
        title: 'New goal',
        status: 'todo',
        priority: 'medium',
        kids: [],
        open: true
      };
      if (parent == null) setGoals(gs => gs.concat([n]));else setGoals(gs => map(gs, g => g.id === parent ? {
        ...g,
        open: true,
        kids: g.kids.concat([n])
      } : g));
      setSel(n.id);
      setEditing(n.id);
    };
    const onDel = id => {
      const rm = list => list.filter(g => g.id !== id).map(g => ({
        ...g,
        kids: rm(g.kids)
      }));
      setGoals(gs => rm(gs));
      if (sel === id) setSel(null);
    };
    const onRename = (id, title) => {
      if (title !== undefined && title.trim()) patch(id, {
        title: title.trim()
      });
      setEditing(title === undefined ? id : null);
    };
    const g = find(goals, sel);
    const flink = (k, l) => /*#__PURE__*/React.createElement("span", {
      key: k,
      className: "hl",
      onClick: () => setFilter(k),
      style: {
        font: '11px var(--font-sans)',
        cursor: 'pointer',
        color: filter === k ? 'var(--ink)' : 'var(--fnt)',
        fontWeight: filter === k ? 600 : 400
      }
    }, l);
    return /*#__PURE__*/React.createElement("div", {
      "data-dark": dark ? 'true' : 'false',
      style: {
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--ink)'
      },
      "data-screen-label": "Vault-goals"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        padding: '14px 24px',
        borderBottom: '1px solid var(--bd)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13.5,
        fontWeight: 700
      }
    }, "Vault-goals"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 16
      }
    }, /*#__PURE__*/React.createElement("span", {
      onClick: () => setDark(!dark),
      style: {
        font: '11px var(--font-sans)',
        color: 'var(--mut)',
        cursor: 'pointer',
        userSelect: 'none'
      }
    }, "[ ", dark ? 'dark' : 'light', " ]"), /*#__PURE__*/React.createElement("span", {
      style: {
        font: '11px var(--font-sans)',
        color: 'var(--fnt)'
      }
    }, "updated just now"))), /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: 1140,
        margin: '0 auto',
        padding: '24px 18px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 16,
        padding: '0 4px',
        flexWrap: 'wrap'
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 700
      }
    }, "Goals"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 6,
        fontSize: 11.5,
        lineHeight: 1.6,
        color: 'var(--mut)',
        maxWidth: 480
      }
    }, "A holistic view of your goals, subgoals, and suggested tasks \u2014 inferred from your Claude Code conversation history.")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 16,
        alignItems: 'baseline'
      }
    }, flink('active', 'active'), flink('done', 'done'), flink('archived', 'archived'), flink('all', 'all'))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement(GoalTree, {
      goals: goals,
      sel: sel,
      filter: filter,
      editing: editing,
      onSelect: setSel,
      onToggle: id => patch(id, {
        open: !find(goals, id).open
      }),
      onAdd: onAdd,
      onDel: onDel,
      onRename: onRename
    }), /*#__PURE__*/React.createElement(Inspector, {
      g: g,
      onChange: p => patch(sel, p)
    }))));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(WorkspaceApp, null));
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/goal-workspace/WorkspaceApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/setup-wizard/StepsIdentity.jsx
try { (() => {
{
  const {
    Button,
    Field,
    Option,
    Seed,
    Slider,
    MicroLabel
  } = window.EngelbartDesignSystem_81b7cb;
  const wizTitle = {
    marginTop: 14,
    font: '500 24px/1.35 var(--font-sans)',
    letterSpacing: '-0.3px'
  };
  const actionsEnd = {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: 18
  };
  const YEARS = ["First year", "Second year", "Third year", "Fourth year"];
  const MAJORS = ["Computer Science", "Electrical Engineering & Computer Sciences", "Data Science", "Cognitive Science", "Molecular & Cell Biology", "Bioengineering", "Mechanical Engineering", "Applied Mathematics", "Statistics", "Physics", "Economics", "Business Administration", "Political Science", "Psychology", "Public Health", "English", "History", "Sociology", "Architecture", "Undeclared"];
  const LEVELS = [{
    label: "Plain language",
    why: "Explain it like I've never seen the code."
  }, {
    label: "Some technical detail",
    why: "Name the pieces, skip the internals."
  }, {
    label: "Fully technical",
    why: "Assume I can read the source."
  }];
  const enter = (ok, fn) => e => {
    if (e.key === 'Enter' && ok) fn();
  };
  function StepName({
    s,
    set,
    next
  }) {
    const ok = !!s.name.trim();
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg"
    }, "Step 1 of 9"), /*#__PURE__*/React.createElement("div", {
      style: wizTitle
    }, "What is your name?"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 22
      }
    }, /*#__PURE__*/React.createElement(Field, {
      autoFocus: true,
      value: s.name,
      onChange: v => set({
        name: v
      }),
      onKeyDown: enter(ok, next),
      placeholder: "type your name\u2026"
    })), /*#__PURE__*/React.createElement("div", {
      style: actionsEnd
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      disabled: !ok,
      go: true,
      onClick: next
    }, "Continue")));
  }
  function StepYear({
    s,
    set,
    next
  }) {
    const ok = !!s.yearText.trim();
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg"
    }, "Step 2 of 9"), /*#__PURE__*/React.createElement("div", {
      style: wizTitle
    }, "What year are you?"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 22,
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }
    }, YEARS.map(y => /*#__PURE__*/React.createElement(Option, {
      key: y,
      on: !s.yearOther && s.year === y,
      label: y,
      onClick: () => {
        set({
          year: y,
          yearOther: false
        });
        setTimeout(next, 180);
      }
    })), /*#__PURE__*/React.createElement(Option, {
      on: s.yearOther,
      label: "Something else",
      onClick: () => set({
        yearOther: !s.yearOther,
        year: ''
      })
    })), s.yearOther && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10
      }
    }, /*#__PURE__*/React.createElement(Field, {
      autoFocus: true,
      value: s.yearText,
      onChange: v => set({
        yearText: v
      }),
      onKeyDown: enter(ok, next),
      placeholder: "transferring, fifth-year, grad\u2026"
    })), /*#__PURE__*/React.createElement("div", {
      style: actionsEnd
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      disabled: !ok,
      go: true,
      onClick: next
    }, "Continue"))));
  }
  function StepMajor({
    s,
    set,
    next
  }) {
    const ok = !!s.major.trim();
    const typed = s.major.trim().toLowerCase();
    const seeds = MAJORS.filter(m => {
      const l = m.toLowerCase();
      return l !== typed && (!typed || l.indexOf(typed) >= 0);
    }).slice(0, 6);
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg"
    }, "Step 3 of 9"), /*#__PURE__*/React.createElement("div", {
      style: wizTitle
    }, "What is your major?"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 22
      }
    }, /*#__PURE__*/React.createElement(Field, {
      autoFocus: true,
      value: s.major,
      onChange: v => set({
        major: v
      }),
      onKeyDown: enter(ok, next),
      placeholder: "start typing\u2026"
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 12
      }
    }, seeds.map(m => /*#__PURE__*/React.createElement(Seed, {
      key: m,
      size: "lg",
      onClick: () => {
        set({
          major: m
        });
        setTimeout(next, 180);
      }
    }, m))), /*#__PURE__*/React.createElement("div", {
      style: actionsEnd
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      disabled: !ok,
      go: true,
      onClick: next
    }, "Continue")));
  }
  function StepLevel({
    s,
    set,
    next
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg"
    }, "Step 4 of 9"), /*#__PURE__*/React.createElement("div", {
      style: wizTitle
    }, "How technical should explanations be?"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 34
      }
    }, /*#__PURE__*/React.createElement(Slider, {
      stops: LEVELS,
      value: s.level,
      touched: s.touched,
      ends: ['Plain', 'Technical'],
      onChange: i => set({
        level: i,
        touched: true
      })
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        ...actionsEnd,
        marginTop: 34
      }
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      disabled: !s.touched,
      go: true,
      onClick: next
    }, "Continue")));
  }
  Object.assign(window, {
    StepName,
    StepYear,
    StepMajor,
    StepLevel,
    LEVELS,
    wizTitle,
    actionsEnd
  });
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/setup-wizard/StepsIdentity.jsx", error: String((e && e.message) || e) }); }

// ui_kits/setup-wizard/StepsProject.jsx
try { (() => {
{
  const {
    Button,
    Field,
    PillField,
    Option,
    MicroLabel,
    Attachment
  } = window.EngelbartDesignSystem_81b7cb;
  const GOALS = [{
    label: "A CLI that can read a prompt, call an LLM, and edit files in a project",
    short: "The core CLI loop",
    why: "This is the core loop everything else depends on — get this working and you have a real agent, even a crude one."
  }, {
    label: "A tool-use layer the agent can call (read file, write file, run shell command)",
    short: "Tool-use layer",
    why: "Without tools the agent can only talk, not act — this is what turns a chatbot into a coding agent."
  }, {
    label: "A safe execution sandbox for running agent-issued shell commands",
    short: "Execution sandbox",
    why: "If you're letting an LLM run commands on your machine, containment is what keeps this from being terrifying."
  }, {
    label: "A conversation/context manager that keeps long sessions coherent",
    short: "Context manager",
    why: "This is the piece that separates a toy demo from something usable on a real multi-file project."
  }, {
    label: "Something else",
    short: "Something else",
    why: "tell it what to start on instead and it will use that"
  }];
  const PLAN = ["You're building an agentic coding tool: something that runs in a terminal, reads and edits a codebase, calls out to tools (shell, file I/O, search), and loops on a model's decisions until a task is done. 'Done' for a first slice: a CLI that takes a prompt, lets the model call a small set of tools, shows what's happening, and stops when the task is finished.", "The hard parts aren't the individual tools, they're the loop around them: feeding tool results back to the model, keeping the transcript from blowing past context, and deciding what the agent may do without asking first."];
  function StepProject({
    s,
    set,
    send
  }) {
    const ok = !!s.draft.trim() || s.attachments.length > 0;
    const urlOk = !!s.urlText.trim();
    const add = (kind, text) => set({
      attachments: s.attachments.concat([{
        id: Math.random().toString(36).slice(2),
        kind,
        text
      }])
    });
    const addUrls = () => {
      if (!urlOk) return;
      s.urlText.split(/[,\s]+/).filter(Boolean).forEach(u => add('url', /^https?:\/\//.test(u) ? u : 'https://' + u));
      set({
        urlText: ''
      });
    };
    const onPaste = e => {
      const t = (e.clipboardData || window.clipboardData).getData('text');
      if (!t || !t.trim()) return;
      const one = t.trim();
      if (/^https?:\/\/\S+$/.test(one)) {
        e.preventDefault();
        add('url', one);
      } else if (one.length > 40 || /\n/.test(one)) {
        e.preventDefault();
        add('text', one);
      }
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg"
    }, "Step 5 of 9"), /*#__PURE__*/React.createElement("div", {
      style: wizTitle
    }, "What do you want to work on?"), /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg",
      tone: "ghost",
      style: {
        marginTop: 6
      }
    }, "A sentence or two is fine \xB7 paste notes or attach links"), s.attachments.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }
    }, s.attachments.map(a => /*#__PURE__*/React.createElement(Attachment, {
      key: a.id,
      kind: a.kind,
      title: a.kind === 'text' ? a.text.replace(/\s+/g, ' ').slice(0, 60) + (a.text.length > 60 ? '…' : '') : a.text.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      text: a.text,
      onRemove: () => set({
        attachments: s.attachments.filter(x => x.id !== a.id)
      })
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 18
      },
      onPaste: onPaste
    }, /*#__PURE__*/React.createElement(Field, {
      multiline: true,
      rows: 3,
      value: s.draft,
      onChange: v => set({
        draft: v
      }),
      onKeyDown: e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (ok) send();
        }
      },
      placeholder: "e.g. a CLI tool that syncs my notes between devices",
      style: {
        padding: '14px 16px'
      }
    })), s.urlOpen && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10
      }
    }, /*#__PURE__*/React.createElement(PillField, {
      autoFocus: true,
      value: s.urlText,
      onChange: v => set({
        urlText: v
      }),
      onKeyDown: e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addUrls();
        }
        if (e.key === 'Escape') set({
          urlOpen: false
        });
      },
      placeholder: "https://",
      action: /*#__PURE__*/React.createElement(Button, {
        size: "lg",
        variant: "filled",
        disabled: !urlOk,
        onClick: addUrls
      }, "Add")
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 18
      }
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      onClick: () => set({
        urlOpen: !s.urlOpen
      })
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        lineHeight: 1
      }
    }, "+"), " Attach URLs"), /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      disabled: !ok,
      go: true,
      onClick: send
    }, "Send")));
  }
  function StepPlan({
    s,
    set,
    approve
  }) {
    const addOk = !!s.addText.trim();
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg",
      rule: true
    }, "Plan"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 20,
        font: '500 19px/1.4 var(--font-sans)',
        letterSpacing: '-0.2px'
      }
    }, "Here's what I think you're working on"), PLAN.map((p, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        marginTop: 12,
        font: '13px/1.8 var(--font-sans)',
        color: 'var(--mut)',
        textWrap: 'pretty'
      }
    }, p)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        marginTop: 16,
        flexWrap: 'wrap'
      }
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      go: true,
      onClick: approve
    }, "Continue"), /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      onClick: () => set({
        addOpen: !s.addOpen
      })
    }, "Add something")), s.addOpen && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement(Field, {
      multiline: true,
      rows: 2,
      value: s.addText,
      onChange: v => set({
        addText: v
      }),
      placeholder: "what the plan is missing\u2026",
      style: {
        padding: '12px 14px'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: actionsEnd
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      disabled: !addOk,
      go: true,
      onClick: approve
    }, "Send"))));
  }
  function StepGoal({
    s,
    set,
    gen
  }) {
    const unpicked = s.goalPick < 0 || s.goalPick === 4 && !s.goalOther.trim();
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg",
      rule: true
    }, "Goal"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 20,
        font: '500 19px/1.4 var(--font-sans)',
        letterSpacing: '-0.2px'
      }
    }, "What should we focus on?"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }
    }, GOALS.map((g, i) => /*#__PURE__*/React.createElement(Option, {
      key: i,
      on: s.goalPick === i,
      label: g.label,
      why: g.why,
      onClick: () => set({
        goalPick: s.goalPick === i ? -1 : i
      })
    }))), s.goalPick === 4 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10
      }
    }, /*#__PURE__*/React.createElement(Field, {
      autoFocus: true,
      value: s.goalOther,
      onChange: v => set({
        goalOther: v
      }),
      placeholder: "what to start on instead\u2026"
    })), /*#__PURE__*/React.createElement(MicroLabel, {
      style: {
        marginTop: 20
      }
    }, "Anything else?"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 9
      }
    }, /*#__PURE__*/React.createElement(Field, {
      multiline: true,
      rows: 2,
      value: s.goalNote,
      onChange: v => set({
        goalNote: v
      }),
      placeholder: "type here...",
      style: {
        padding: '12px 14px'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: actionsEnd
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      variant: "filled",
      disabled: unpicked,
      go: true,
      onClick: gen
    }, "Generate todos")));
  }
  Object.assign(window, {
    StepProject,
    StepPlan,
    StepGoal,
    GOALS
  });
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/setup-wizard/StepsProject.jsx", error: String((e && e.message) || e) }); }

// ui_kits/setup-wizard/StepsTodos.jsx
try { (() => {
{
  const {
    Button,
    PillField,
    MicroLabel,
    TodoRow,
    Pager,
    ArrowButton
  } = window.EngelbartDesignSystem_81b7cb;
  const PIECES = [{
    label: "Tool interface and registry",
    rows: ["Define a Tool base class/protocol with name, description, input schema, and an execute method", "Build a registry that tools register into, keyed by name", "Write a JSON schema-to-prompt formatter so the model can see what each tool expects"]
  }, {
    label: "The three concrete tools",
    rows: ["Implement read_file: path in, contents out, with a size cap", "Implement write_file: path + new contents, refusing paths outside the project", "Implement run_shell: command in, stdout/stderr/exit code out, with a timeout"]
  }, {
    label: "Dispatch loop",
    rows: ["Parse tool calls out of the model's response", "Execute the named tool and append the result to the transcript", "Loop until the model answers without a tool call, then show that answer"]
  }];
  function StepTodos({
    s,
    set,
    done
  }) {
    const piece = s.pieces[s.page];
    const n = s.pieces.length;
    const upd = fn => set({
      pieces: s.pieces.map((p, i) => i === s.page ? fn(p) : p)
    });
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg",
      rule: true,
      right: piece.rows.length + ' todos'
    }, "Goal ", s.page + 1, " of ", n), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 18,
        padding: '2px 0'
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: piece.label,
      onChange: e => upd(p => ({
        ...p,
        label: e.target.value
      })),
      spellCheck: false,
      style: {
        all: 'unset',
        display: 'block',
        width: '100%',
        font: '500 22px/1.35 var(--font-sans)',
        letterSpacing: '-0.3px',
        color: 'var(--ink)'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 14,
        display: 'flex',
        flexDirection: 'column'
      }
    }, piece.rows.map((r, i) => /*#__PURE__*/React.createElement(TodoRow, {
      key: i,
      text: r,
      onChange: v => upd(p => ({
        ...p,
        rows: p.rows.map((x, j) => j === i ? v : x)
      })),
      onDelete: () => upd(p => ({
        ...p,
        rows: p.rows.filter((x, j) => j !== i)
      }))
    })), /*#__PURE__*/React.createElement(TodoRow, {
      adder: true,
      text: s.newTodo,
      onChange: v => set({
        newTodo: v
      }),
      placeholder: "add a todo\u2026",
      onKeyDown: e => {
        if (e.key === 'Enter' && s.newTodo.trim()) {
          const v = s.newTodo.trim();
          set({
            newTodo: '',
            pieces: s.pieces.map((p, i) => i === s.page ? {
              ...p,
              rows: p.rows.concat([v])
            } : p)
          });
        }
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        marginTop: 24,
        paddingTop: 16,
        borderTop: '1px solid var(--bd)'
      }
    }, /*#__PURE__*/React.createElement(ArrowButton, {
      dir: "prev",
      disabled: s.page === 0,
      onClick: () => set({
        page: s.page - 1
      })
    }), /*#__PURE__*/React.createElement(Pager, {
      count: n,
      index: s.page,
      onSelect: i => set({
        page: i
      })
    }), /*#__PURE__*/React.createElement(ArrowButton, {
      dir: "next",
      on: true,
      onClick: () => s.page < n - 1 ? set({
        page: s.page + 1
      }) : done()
    })));
  }
  function StepCreate({
    s,
    set,
    create
  }) {
    const total = s.pieces.reduce((a, p) => a + p.rows.length, 0);
    return /*#__PURE__*/React.createElement("div", {
      className: "rise"
    }, /*#__PURE__*/React.createElement(MicroLabel, {
      size: "lg",
      rule: true,
      right: s.pieces.length + ' goals · ' + total + ' todos'
    }, "The project"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 20,
        font: '500 24px/1.35 var(--font-sans)',
        letterSpacing: '-0.3px'
      }
    }, "Looks good?"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 18
      }
    }, /*#__PURE__*/React.createElement(PillField, {
      bold: true,
      value: s.projName,
      onChange: v => set({
        projName: v
      }),
      action: /*#__PURE__*/React.createElement(Button, {
        size: "lg",
        variant: "filled",
        go: true,
        onClick: create,
        style: {
          padding: '9px 16px'
        }
      }, "Create project")
    })));
  }
  function StepDone({
    s,
    restart
  }) {
    const total = s.pieces.reduce((a, p) => a + p.rows.length, 0);
    return /*#__PURE__*/React.createElement("div", {
      className: "rise",
      style: {
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'inline-flex',
        width: 44,
        height: 44,
        borderRadius: '50%',
        background: 'var(--ink)',
        color: '#fff',
        alignItems: 'center',
        justifyContent: 'center',
        font: '16px/1 var(--font-sans)'
      }
    }, "\u2713"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 20,
        font: '500 24px/1.35 var(--font-sans)',
        letterSpacing: '-0.3px'
      }
    }, s.projName, " is made"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        font: '13px/1.7 var(--font-sans)',
        color: 'var(--fnt)',
        textWrap: 'pretty'
      }
    }, s.pieces.length, " goals and ", total, " todos, written for ", s.name.trim(), " \u2014 explanations ", ["in plain language", "with some technical detail", "fully technical"][s.level], "."), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'center',
        marginTop: 26
      }
    }, /*#__PURE__*/React.createElement(Button, {
      size: "lg",
      onClick: restart
    }, "Start over")));
  }
  Object.assign(window, {
    StepTodos,
    StepCreate,
    StepDone,
    PIECES
  });
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/setup-wizard/StepsTodos.jsx", error: String((e && e.message) || e) }); }

// ui_kits/setup-wizard/WizardApp.jsx
try { (() => {
{
  const {
    StepRail,
    ThinkingDots
  } = window.EngelbartDesignSystem_81b7cb;
  const INIT = {
    step: 0,
    maxSeen: 0,
    thinking: false,
    name: '',
    year: '',
    yearOther: false,
    yearText: '',
    major: '',
    level: 1,
    touched: false,
    draft: '',
    attachments: [],
    urlOpen: false,
    urlText: '',
    addOpen: false,
    addText: '',
    planApproved: false,
    goalPick: -1,
    goalOther: '',
    goalNote: '',
    pieces: [],
    page: 0,
    newTodo: '',
    projName: ''
  };
  const LABELS = ["Name", "Year", "Major", "Explanations", "Project", "Plan", "Focus", "Todos", "Create"];
  function WizardApp() {
    const [s, setS] = React.useState(INIT);
    const set = p => setS(prev => ({
      ...prev,
      ...p
    }));
    const go = n => setS(prev => ({
      ...prev,
      step: n,
      maxSeen: Math.max(prev.maxSeen, n)
    }));
    const stage = n => {
      set({
        thinking: true
      });
      setTimeout(() => setS(prev => ({
        ...prev,
        thinking: false,
        step: n,
        maxSeen: Math.max(prev.maxSeen, n)
      })), 1200);
    };
    const trunc = (t, n) => t.length > n ? t.slice(0, n - 1).trim() + '…' : t;
    const total = s.pieces.reduce((a, p) => a + p.rows.length, 0);
    const goal = s.goalPick === 4 ? s.goalOther.trim() : s.goalPick >= 0 ? GOALS[s.goalPick].short : '';
    const vals = [s.name.trim(), s.yearOther ? s.yearText.trim() : s.year, s.major.trim(), s.touched ? ["plain language", "some technical detail", "fully technical"][s.level] : '', trunc(s.draft.trim(), 26), s.planApproved ? 'Approved' : '', goal ? trunc(goal, 26) : '', s.step >= 8 ? total + ' todos' : '', s.step >= 9 ? trunc(s.projName.trim(), 26) : ''];
    const steps = LABELS.map((label, i) => ({
      label,
      value: vals[i],
      state: s.step === i ? 'now' : vals[i] && s.step > i ? 'done' : 'later',
      reachable: i <= s.maxSeen && !s.thinking && s.step < 9
    }));
    const next = () => go(s.step + 1);
    const genTodos = () => {
      set({
        pieces: PIECES.map(p => ({
          label: p.label,
          rows: p.rows.slice()
        })),
        page: 0,
        projName: s.projName || (s.goalPick === 4 ? 'my-project' : ['agent-cli', 'claude-code', 'safe-sandbox', 'context-keeper'][s.goalPick])
      });
      stage(7);
    };
    const body = s.thinking ? /*#__PURE__*/React.createElement(ThinkingDots, null) : [/*#__PURE__*/React.createElement(StepName, {
      s: s,
      set: set,
      next: next
    }), /*#__PURE__*/React.createElement(StepYear, {
      s: s,
      set: set,
      next: next
    }), /*#__PURE__*/React.createElement(StepMajor, {
      s: s,
      set: set,
      next: next
    }), /*#__PURE__*/React.createElement(StepLevel, {
      s: s,
      set: set,
      next: next
    }), /*#__PURE__*/React.createElement(StepProject, {
      s: s,
      set: set,
      send: () => stage(5)
    }), /*#__PURE__*/React.createElement(StepPlan, {
      s: s,
      set: set,
      approve: () => {
        set({
          planApproved: true
        });
        stage(6);
      }
    }), /*#__PURE__*/React.createElement(StepGoal, {
      s: s,
      set: set,
      gen: genTodos
    }), /*#__PURE__*/React.createElement(StepTodos, {
      s: s,
      set: set,
      done: () => go(8)
    }), /*#__PURE__*/React.createElement(StepCreate, {
      s: s,
      set: set,
      create: () => set({
        step: 9,
        maxSeen: 9
      })
    }), /*#__PURE__*/React.createElement(StepDone, {
      s: s,
      restart: () => setS(INIT)
    })][s.step];
    return /*#__PURE__*/React.createElement("div", {
      style: {
        minHeight: '100vh',
        display: 'flex',
        background: '#fff',
        color: 'var(--ink)'
      },
      "data-screen-label": 'Step ' + (s.step + 1)
    }, /*#__PURE__*/React.createElement(StepRail, {
      caption: "Setting up your first project",
      steps: steps,
      onStep: go
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 600,
        maxWidth: '100%'
      },
      key: s.thinking ? 't' : s.step
    }, body)));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(WizardApp, null));
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/setup-wizard/WizardApp.jsx", error: String((e && e.message) || e) }); }

__ds_ns.ArrowButton = __ds_scope.ArrowButton;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Seed = __ds_scope.Seed;

__ds_ns.Attachment = __ds_scope.Attachment;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Command = __ds_scope.Command;

__ds_ns.Inset = __ds_scope.Inset;

__ds_ns.ListGroup = __ds_scope.ListGroup;

__ds_ns.ListRow = __ds_scope.ListRow;

__ds_ns.FileTile = __ds_scope.FileTile;

__ds_ns.Message = __ds_scope.Message;

__ds_ns.MicroLabel = __ds_scope.MicroLabel;

__ds_ns.ThinkingDots = __ds_scope.ThinkingDots;

__ds_ns.TodoRow = __ds_scope.TodoRow;

__ds_ns.Field = __ds_scope.Field;

__ds_ns.Option = __ds_scope.Option;

__ds_ns.PillField = __ds_scope.PillField;

__ds_ns.Slider = __ds_scope.Slider;

__ds_ns.Pager = __ds_scope.Pager;

__ds_ns.StepRail = __ds_scope.StepRail;

__ds_ns.Tabs = __ds_scope.Tabs;

})();
